using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRage.ModAPI;
using VRageMath;
using IMyThrust = Sandbox.ModAPI.IMyThrust;
using IMyGyro = Sandbox.ModAPI.IMyGyro;
using IMyShipController = Sandbox.ModAPI.IMyShipController;
using IMyRemoteControl = Sandbox.ModAPI.IMyRemoteControl;
using IMyBatteryBlock = Sandbox.ModAPI.IMyBatteryBlock;
using IMyGasTank = Sandbox.ModAPI.IMyGasTank;

namespace HermesRts.Plugin
{
    /// <summary>
    /// T25 level-mode flight controller (test build only).
    ///
    /// Some hulls (Data's atmospheric satellite: 12 lift thrusters, no down or
    /// lateral bank) cannot be flown by SE's autopilot: it rotates the ship to
    /// face the waypoint and the ship tips over. This controller keeps the grid
    /// level instead — gyro override aligns grid-down with gravity (tilt cap),
    /// and the lift bank is driven by a PD loop on altitude/vertical speed while
    /// lateral banks handle horizontal position.
    ///
    /// Everything runs on the game thread from Plugin.Tick at 10 Hz. The
    /// controller is off unless a `level_hold` / `level_move` test order starts
    /// a job, and every job ends by zeroing its own overrides.
    ///
    /// Deliberately conservative:
    ///  * refuses when lift thrust < 1.05 x weight, in zero-g, or when a player
    ///    is piloting (manual handoff wins);
    ///  * aborts on tilt exceedance, ground floor, battery/H2 reserve, lost
    ///    ground reference;
    ///  * auto-flips the gyro sign once if tilt grows while correcting (the SE
    ///    gyro axis convention is not documented; divergence is measured, not
    ///    assumed), then gives up rather than fight.
    /// </summary>
    public sealed class LevelFlightController
    {
        private const double TickIntervalSec = 0.1;
        private const double MaxTiltDegDefault = 10.0;
        private const double KpAltitude = 0.55;
        private const double KdAltitude = 1.7;
        private const double KpPosition = 0.22;
        private const double KdPosition = 1.1;
        private const double MaxAltitudeAccelG = 0.45;
        private const double BatteryReservePct = 15.0;
        private const double H2ReservePct = 5.0;

        public static readonly LevelFlightController Instance = new LevelFlightController();

        private sealed class Job
        {
            public long GridId;
            public string Mode;              // hold | move
            public double TargetAglM;
            public Vector3D TargetPos;       // world position including target altitude
            public double MaxLateralMps;
            public double MaxTiltDeg;
            public string State = "starting"; // starting | flying | holding | done | aborted
            public string Note = "";
            public double StartedAt;
            public double LastTickAt;
            public double LastLogAt;
            public double LastTilt;
            public double SignCheckAt = -1;
            /// <summary>Tilt at the start of the rolling sign-learning window.</summary>
            public double TiltRef;
            public double TiltRefAt = -1;
            public int SignFlips;
            public double GyroSign = 1.0;

            // --- yaw sign test and yaw rate damping (2026-11-11 spin) ---------
            /// <summary>0 = not started; 1..SignTestTicks = commanding; then decide. -1 = skipped.</summary>
            public int YawTestTick = -1;
            public int YawTestAttempt;
            public double YawTestBaseline;
            public double YawTestCommand;
            public Vector3D YawTestAxis = Vector3D.Zero;
            /// <summary>The deterministic yaw sign test has decided (either way).</summary>
            public bool YawTested;
            /// <summary>Measured yaw response, deg/s of rate CHANGE over the test window.</summary>
            public double YawTestRateDegS;
            /// <summary>Command scale measured by the yaw test, deg/s per override unit.</summary>
            public double RatePerCommandDegS = LandMath.NominalRatePerCommandDegS;
            /// <summary>Yaw rate damping is commanded ONLY while the sign is proven.</summary>
            public bool YawSignProven;
            /// <summary>Last yaw damping demand added to the gyro, override units.</summary>
            public double YawDampOverride;
            public double PeakTilt;
            public double MaxSpeedSeen;
            public double MaxAglSeen = double.MinValue;
            public double MinAglSeen = double.MaxValue;
            public double LastVerticalAccelCmd;
            public double LastHorizontalAccelCmd;
        }

        private readonly Dictionary<long, Job> _jobs = new Dictionary<long, Job>();
        private Action<string, string> _log = (l, m) => { };
        private double _now;

        public void SetLogger(Action<string, string> log)
        {
            _log = log ?? ((l, m) => { });
        }

        // ------------------------------------------------------------------ API

        public JObject StartHold(long gridId, double? altitudeAglM, double? maxTiltDeg)
        {
            var grid = FindGrid(gridId);
            if (grid == null) return GenericRefusal(gridId, "grid not in scene", "grid not in scene");
            var pos = grid.PositionComp.GetPosition();
            var up = UpVector(pos);
            double agl;
            Vector3D hitPos;
            if (!ProbeGround(pos, up, out agl, out hitPos))
                return GenericRefusal(gridId, "no ground reference within 8 km", null);

            var targetAgl = altitudeAglM ?? agl;
            var refusal = Preflight(grid, targetAgl, maxTiltDeg);
            if (refusal != null) return GenericRefusal(gridId, refusal, null);

            var job = NewJob(grid, "hold", targetAgl, pos + up * (targetAgl - agl), 0, maxTiltDeg);
            _jobs[grid.EntityId] = job;
            Prepare(grid);
            Log("info", "level_hold grid:" + gridId + " target " + Math.Round(targetAgl, 1) + " m AGL (from " +
                Math.Round(agl, 1) + "), tilt cap " + job.MaxTiltDeg + " deg");
            return Status(job, grid);
        }

        public JObject StartMove(long gridId, double x, double y, double z, double maxLateralMps, double? altitudeAglM, double? maxTiltDeg)
        {
            var grid = FindGrid(gridId);
            if (grid == null) return GenericRefusal(gridId, "grid not in scene", "grid not in scene");
            var pos = grid.PositionComp.GetPosition();
            var up = UpVector(pos);
            double agl;
            Vector3D hitPos;
            if (!ProbeGround(pos, up, out agl, out hitPos))
                return GenericRefusal(gridId, "no ground reference within 8 km of the ship", null);

            var targetAgl = altitudeAglM ?? agl;
            var refusal = Preflight(grid, targetAgl, maxTiltDeg);
            if (refusal != null) return GenericRefusal(gridId, refusal, null);

            // Terrain at the destination decides the altitude, so a move over
            // rising ground does not fly into it.
            var target = new Vector3D(x, y, z);
            double tAgl;
            Vector3D tHit;
            if (ProbeGround(target + up * 5000.0, up, out tAgl, out tHit))
                target = tHit + up * targetAgl;
            else
                target = target + up * (targetAgl - agl);

            var job = NewJob(grid, "move", targetAgl, target, maxLateralMps, maxTiltDeg);
            _jobs[grid.EntityId] = job;
            Prepare(grid);
            Log("info", "level_move grid:" + gridId + " to " + Fmt(target) + " (" + Math.Round((target - pos).Length()) +
                " m, " + Math.Round(targetAgl, 1) + " m AGL, cap " + job.MaxLateralMps + " m/s)");
            return Status(job, grid);
        }

        public JObject Stop(long gridId, string reason)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job))
                return new JObject { ["gridId"] = "grid:" + gridId, ["stopped"] = false, ["note"] = "no level job" };
            job.State = "done";
            job.Note = reason ?? "stopped";
            ReleaseOverrides(FindGrid(gridId));
            _jobs.Remove(gridId);
            Log("info", "level job stopped grid:" + gridId + " (" + job.Note + ")");
            return Status(job, null);
        }

        public void StopAll(string reason)
        {
            foreach (var id in _jobs.Keys.ToList())
            {
                try { Stop(id, reason); } catch (Exception ex) { Log("warn", "level stop failed: " + ex.Message); }
            }
        }

        public JObject StatusAll()
        {
            var arr = new JArray();
            foreach (var job in _jobs.Values) arr.Add(Status(job, null));
            return new JObject { ["jobs"] = arr, ["count"] = arr.Count };
        }

        public JObject StatusOne(long gridId)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job))
                return new JObject { ["gridId"] = "grid:" + gridId, ["active"] = false };
            return Status(job, FindGrid(gridId));
        }

        public bool HasJob(long gridId) { return _jobs.ContainsKey(gridId); }

        // ---------------------------------------------------------------- tick

        /// <summary>Called from Plugin.Tick on the game thread.</summary>
        public void Tick(double dt)
        {
            if (_jobs.Count == 0) return;
            _now += dt;
            foreach (var job in _jobs.Values.ToList())
            {
                if (_now - job.LastTickAt < TickIntervalSec) continue;
                job.LastTickAt = _now;
                try { Control(job); }
                catch (Exception ex) { Abort(job, "controller error: " + ex.GetType().Name + ": " + ex.Message); }
            }
        }

        private void Control(Job job)
        {
            var grid = FindGrid(job.GridId);
            if (grid == null) { Abort(job, "grid no longer in scene"); return; }
            if (grid.Physics == null) { Abort(job, "no physics body"); return; }
            if (grid.IsStatic) { Abort(job, "grid became static"); return; }

            var pos = grid.PositionComp.GetPosition();
            float gInterference;
            var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out gInterference);
            var g = (double)gravity.Length();
            if (g < LevelMath.MinGravityMs2) { Abort(job, "gravity disappeared"); return; }
            var up = new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g);

            var vel = (Vector3D)grid.Physics.LinearVelocity;
            var ang = (Vector3D)grid.Physics.AngularVelocity;
            var mass = grid.Physics.Mass;
            var matrix = grid.WorldMatrix;

            // Manual handoff wins over any automation (T27).
            var controller = UnderControl(grid);
            if (controller != null) { Abort(job, "manual control: " + controller); return; }

            var tilt = LevelMath.TiltDeg(Vector3D.Dot(matrix.Up, up));
            job.PeakTilt = Math.Max(job.PeakTilt, tilt);
            job.MaxSpeedSeen = Math.Max(job.MaxSpeedSeen, vel.Length());

            double agl;
            Vector3D hitPos;
            if (!ProbeGround(pos, up, out agl, out hitPos)) { Abort(job, "lost ground reference"); return; }
            job.MaxAglSeen = Math.Max(job.MaxAglSeen, agl);
            job.MinAglSeen = Math.Min(job.MinAglSeen, agl);

            var floor = LevelMath.GroundFloor(job.TargetAglM);
            if (agl < floor) { Abort(job, "ground floor: " + Math.Round(agl, 1) + " m AGL < " + Math.Round(floor, 1)); return; }
            if (tilt > job.MaxTiltDeg * 1.15) { Abort(job, "tilt " + Math.Round(tilt, 1) + " deg exceeds cap " + job.MaxTiltDeg); return; }
            var reserve = ReserveReason(grid);
            if (reserve != null) { Abort(job, reserve); return; }

            // --- yaw sign test, once per job (2026-11-11 spin) ----------------
            // The yaw rate damper below is only safe on a PROVEN yaw sign: a
            // wrong one adds rate instead of removing it. This is the land
            // controller's own test (same constants, same decision), run here
            // because level mode has no settle phase to hide it in. If it cannot
            // measure a response, the damper stays off for the whole job.
            if (!job.YawTested && RunYawSignTest(job, grid, ang, matrix)) return;

            // --- gyro: align grid up with anti-gravity, hold heading
            double rotMag;
            var rot = AttitudeRotation(matrix, up, ang, out rotMag);

            // --- yaw (up-axis) rate damping ------------------------------------
            // A pure rate term against `omega . up`: it drives yaw to zero, never
            // to a heading, and is ADDED to the tilt correction (pitch/roll keep
            // priority through the override budget). Zero unless the sign test
            // proved the yaw sign.
            {
                var rateUpDegS = Vector3D.Dot(ang, up) * 180.0 / Math.PI;
                var yaw = LandMath.YawRateDampOverride(rateUpDegS, job.RatePerCommandDegS, job.YawSignProven);
                yaw = LandMath.YawWithinAttitudeBudget(rot.Length(), yaw);
                job.YawDampOverride = yaw;
                if (yaw != 0.0) rot += up * yaw;
            }

            // Sign is learned: if tilt keeps growing while a correction is
            // commanded, the axis convention is inverted. Flip once, then give
            // up. The rule is LandMath.SignFlipDue (shared with the land
            // controller): 0.3 deg of growth inside rolling 1 s windows, so a
            // hull that is being pushed the wrong way is caught on the first
            // real growth instead of after ~1 s of +0.02 deg steps.
            if (job.State != "starting" && job.SignFlips == 0)
            {
                if (!(rotMag > 0.02)) job.TiltRefAt = -1;
                else if (job.TiltRefAt < 0) { job.TiltRef = tilt; job.TiltRefAt = _now; }
                else if (tilt < job.TiltRef - 0.02) { job.TiltRef = tilt; job.TiltRefAt = _now; }
                else if (LandMath.SignFlipDue(tilt, job.TiltRef, _now - job.TiltRefAt, rotMag))
                {
                    var window = _now - job.TiltRefAt;
                    job.SignFlips++;
                    job.GyroSign = -job.GyroSign;
                    job.TiltRef = tilt;
                    job.TiltRefAt = _now;
                    // The yaw damper was enabled on the sign this flip just
                    // disproved: it goes off and stays off (no guessing).
                    job.YawSignProven = false;
                    job.YawDampOverride = 0.0;
                    Log("warn", "level gyro sign flipped to " + job.GyroSign + " (tilt grew to " +
                        Math.Round(tilt, 1) + " deg in " + Math.Round(window, 2) + " s while correcting)");
                }
                else if (_now - job.TiltRefAt > LandMath.SignFlipWindowSec) { job.TiltRef = tilt; job.TiltRefAt = _now; }
            }
            job.LastTilt = tilt;
            ApplyGyro(grid, rot * job.GyroSign);

            // --- vertical PD on altitude AGL + vertical speed
            var vz = Vector3D.Dot(vel, up);
            var liftN = UpThrust(up, grid);
            var maxUpAccel = Math.Max(0.05, Math.Min(MaxAltitudeAccelG * g, 0.9 * (liftN / Math.Max(1.0, mass) - g)));
            var maxDownAccel = MaxAltitudeAccelG * g;
            var aVert = LevelMath.VerticalAccel(job.TargetAglM, agl, vz, KpAltitude, KdAltitude, maxUpAccel, maxDownAccel);
            job.LastVerticalAccelCmd = aVert;

            // --- horizontal PD
            var err = job.TargetPos - pos;
            err -= up * Vector3D.Dot(err, up);
            var velH = vel - up * vz;
            var east = Vector3D.Cross(up, Vector3D.UnitY);
            if (east.LengthSquared() < 0.01) east = Vector3D.Cross(up, Vector3D.UnitX);
            east.Normalize();
            var north = Vector3D.Cross(east, up);
            double ax, az;
            LevelMath.HorizontalAccel(
                Vector3D.Dot(err, east), Vector3D.Dot(err, north),
                Vector3D.Dot(velH, east), Vector3D.Dot(velH, north),
                KpPosition, KdPosition, Math.Max(0.05, 0.35 * g), job.MaxLateralMps, out ax, out az);
            var aH = east * ax + north * az;
            job.LastHorizontalAccelCmd = aH.Length();

            // --- force -> per-direction overrides (grid local)
            var forceWorld = up * (mass * (g + aVert)) + aH * mass;
            var forceLocal = Vector3D.TransformNormal(forceWorld, MatrixD.Transpose(matrix));
            ApplyThrust(grid, forceLocal);

            if (job.State == "starting")
            {
                job.State = "flying";
                Log("info", "level job active grid:" + job.GridId + " (" + Math.Round(agl, 1) + " m AGL, tilt " +
                    Math.Round(tilt, 1) + " deg, lift " + Math.Round(liftN / 1000) + " kN)");
            }
            if (job.State == "flying" &&
                Math.Abs(job.TargetAglM - agl) < 3.0 && Math.Abs(vz) < 0.6 &&
                (job.Mode == "hold" || err.Length() < 10.0))
            {
                job.State = "holding";
                job.Note = "on target";
                Log("info", "level job on target grid:" + job.GridId + " (" + Math.Round(agl, 1) + " m AGL, " +
                    Math.Round(tilt, 1) + " deg tilt)");
            }
            if (_now - job.LastLogAt > 5)
            {
                job.LastLogAt = _now;
                Log("info", "level grid:" + job.GridId + " " + job.State + " agl=" + Math.Round(agl, 1) +
                    " tilt=" + Math.Round(tilt, 1) + " vz=" + Math.Round(vz, 2) + " vh=" + Math.Round(velH.Length(), 2) +
                    " err=" + Math.Round(err.Length(), 1) + " upCmd=" + Math.Round(forceLocal.Y / 1000) + "kN");
            }
        }

        // ------------------------------------------------------------- helpers

        /// <summary>
        /// Gyro rotation (world frame) that aligns the hull's up axis with
        /// <paramref name="desiredUp"/> and holds its heading, damped against the
        /// current angular velocity and magnitude-capped at 0.9. Shared with the
        /// land controller so both fly the hull the same way.
        /// <paramref name="magnitude"/> is the UNCAPPED magnitude, which the
        /// sign-learning check in <see cref="Control"/> needs.
        /// </summary>
        public static Vector3D AttitudeRotation(MatrixD matrix, Vector3D desiredUp, Vector3D angularVelocity, out double magnitude)
        {
            var curFwd = matrix.Forward;
            var desFwd = curFwd - desiredUp * Vector3D.Dot(curFwd, desiredUp);
            if (desFwd.LengthSquared() < 0.01) desFwd = Vector3D.Cross(desiredUp, Vector3D.UnitX);
            desFwd.Normalize();

            var rot = Vector3D.Cross(matrix.Up, desiredUp) * 2.2 + Vector3D.Cross(curFwd, desFwd) * 0.8 - angularVelocity * 1.1;
            magnitude = rot.Length();
            if (magnitude > 0.9) rot *= 0.9 / magnitude;
            return rot;
        }

        /// <summary>
        /// THE YAW SIGN TEST, level mode (2026-11-11 spin). The same deterministic
        /// test the land controller runs in its settle: command a ~1 deg/s yaw
        /// about the hull's up axis for <see cref="LandMath.SignTestTicks"/>
        /// ticks, then read the CHANGE of the angular rate along that axis. The
        /// delta is the gyro's response, so a residual spin cannot be mistaken
        /// for it. A no-evidence result keeps the default sign for the tilt loop
        /// (unchanged behaviour) but keeps the yaw damper OFF.
        ///
        /// Returns true while the test owns the gyro for this tick. It is bounded
        /// (<see cref="LandMath.SignTestAttempts"/> attempts) and releases the
        /// gyro to the normal loop either way.
        /// </summary>
        private bool RunYawSignTest(Job job, IMyCubeGrid grid, Vector3D ang, MatrixD matrix)
        {
            if (job.YawTestTick < 0)
            {
                var axis = matrix.Up;
                if (axis.LengthSquared() < 1e-6) axis = Vector3D.UnitY;
                axis.Normalize();
                job.YawTestAxis = axis;
                job.YawTestBaseline = Vector3D.Dot(ang, axis);
                job.YawTestCommand = LandMath.SignTestYawCommand *
                                     Math.Pow(LandMath.SignTestRetryScale, job.YawTestAttempt);
                job.YawTestTick = 0;
            }

            if (job.YawTestTick < LandMath.SignTestTicks)
            {
                // Raw, unsigned: the test must measure the gyro as it is.
                ApplyGyro(grid, job.YawTestAxis * job.YawTestCommand);
                job.YawTestTick++;
                return true;
            }

            var after = Vector3D.Dot(ang, job.YawTestAxis);
            job.YawTestRateDegS = (after - job.YawTestBaseline) * 180.0 / Math.PI;
            var sign = LandMath.SignFromDelta(job.YawTestBaseline, after,
                LandMath.SignTestMinRateDegS * Math.PI / 180.0);

            if (sign == 0 && job.YawTestAttempt + 1 < LandMath.SignTestAttempts)
            {
                job.YawTestAttempt++;
                job.YawTestTick = -1;
                Log("warn", "level yaw sign test grid:" + job.GridId + " saw only " +
                    Math.Round(job.YawTestRateDegS, 3) + " deg/s of change for a " +
                    job.YawTestCommand + " yaw command: retrying at " +
                    Math.Round(job.YawTestCommand * LandMath.SignTestRetryScale, 3));
                return true;
            }

            if (sign != 0)
            {
                job.GyroSign = sign;
                job.RatePerCommandDegS = LandMath.RatePerCommandDegS(job.YawTestRateDegS, job.YawTestCommand);
                job.YawSignProven = true;
            }
            job.YawTested = true;
            Log(sign == 0 ? "warn" : "info", "level yaw sign test grid:" + job.GridId +
                " measured " + Math.Round(job.YawTestRateDegS, 2) + " deg/s of rate CHANGE for a +" +
                job.YawTestCommand + " yaw command over " + (LandMath.SignTestTicks * TickIntervalSec) +
                " s -> sign " + job.GyroSign + " (command scale " + Math.Round(job.RatePerCommandDegS, 1) +
                " deg/s per unit): yaw rate damping " + (job.YawSignProven ? "armed" : "OFF (no sign evidence)"));
            return false;
        }

        private Job NewJob(IMyCubeGrid grid, string mode, double targetAgl, Vector3D target, double maxLateralMps, double? maxTiltDeg)
        {
            return new Job
            {
                GridId = grid.EntityId,
                Mode = mode,
                TargetAglM = targetAgl,
                TargetPos = target,
                MaxLateralMps = maxLateralMps > 0 ? maxLateralMps : 3.0,
                MaxTiltDeg = maxTiltDeg.HasValue && maxTiltDeg.Value > 0
                    ? Math.Min(25.0, maxTiltDeg.Value)
                    : MaxTiltDegDefault,
                StartedAt = _now,
                LastTickAt = _now,
            };
        }

        private string Preflight(IMyCubeGrid grid, double targetAgl, double? maxTiltDeg)
        {
            var pos = grid.PositionComp.GetPosition();
            float gInterference;
            var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out gInterference);
            var g = (double)gravity.Length();
            var up = g > 0 ? new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g) : Vector3D.UnitY;
            double agl;
            Vector3D hit;
            var probed = ProbeGround(pos, up, out agl, out hit);
            var tilt = LevelMath.TiltDeg(Vector3D.Dot(grid.WorldMatrix.Up, up));
            var mass = grid.Physics != null ? (double)grid.Physics.Mass : 0;
            var liftN = UpThrust(up, grid);
            var manual = UnderControl(grid);
            var cap = maxTiltDeg.HasValue && maxTiltDeg.Value > 0 ? Math.Min(25.0, maxTiltDeg.Value) : MaxTiltDegDefault;
            return LevelMath.StartRefusal(
                grid.IsStatic, grid.Physics != null, g, tilt, cap,
                liftN, mass, probed ? agl : 1000, 0, manual != null);
        }

        private JObject GenericRefusal(long gridId, string reason, string extra)
        {
            var row = new JObject
            {
                ["gridId"] = "grid:" + gridId,
                ["started"] = false,
                ["refused"] = reason,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            if (extra != null) row["note"] = extra;
            Log("warn", "level start refused grid:" + gridId + ": " + reason);
            return row;
        }

        private void Abort(Job job, string reason)
        {
            job.State = "aborted";
            job.Note = reason;
            try { ReleaseOverrides(FindGrid(job.GridId)); } catch { }
            _jobs.Remove(job.GridId);
            Log("warn", "level job aborted grid:" + job.GridId + ": " + reason);
        }

        private string ReserveReason(IMyCubeGrid grid)
        {
            double stored = 0, capacity = 0;
            foreach (var bat in grid.GetFatBlocks<IMyBatteryBlock>())
            {
                if (bat == null) continue;
                stored += bat.CurrentStoredPower;
                capacity += bat.MaxStoredPower;
            }
            if (capacity > 0 && stored / capacity * 100.0 < BatteryReservePct)
                return "battery reserve: " + Math.Round(stored / capacity * 100.0, 1) + "% < " + BatteryReservePct + "%";

            var liftHasH2 = false;
            var liftAxes = new Dictionary<long, Vector3I>();
            foreach (var a in ThrusterGeometry.Classify(grid).Thrusters)
            {
                if (a.Thruster != null) liftAxes[a.Thruster.EntityId] = a.GridAxis;
            }
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                var sub = thr.BlockDefinition.SubtypeName;
                Vector3I axis;
                if (!liftAxes.TryGetValue(thr.EntityId, out axis)) axis = thr.GridThrustDirection;
                if (sub.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    axis.Y > 0)
                    liftHasH2 = true;
            }
            if (!liftHasH2) return null;

            var h2Fill = 1.0;
            var tanks = 0;
            foreach (var tank in grid.GetFatBlocks<IMyGasTank>())
            {
                if (tank == null) continue;
                var sub = tank.BlockDefinition.SubtypeName;
                if (sub.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) < 0) continue;
                tanks++;
                h2Fill = Math.Min(h2Fill, tank.FilledRatio);
            }
            if (tanks == 0) return "hydrogen lift has no hydrogen tank";
            if (h2Fill * 100.0 < H2ReservePct)
                return "H2 reserve: " + Math.Round(h2Fill * 100.0, 1) + "% < " + H2ReservePct + "%";
            return null;
        }

        private Vector3D UpVector(Vector3D pos)
        {
            float ig;
            var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out ig);
            var g = (double)gravity.Length();
            return g > LevelMath.MinGravityMs2
                ? new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g)
                : Vector3D.UnitY;
        }

        private bool ProbeGround(Vector3D pos, Vector3D up, out double agl, out Vector3D hitPos)
        {
            agl = -1;
            hitPos = pos;
            var from = pos - up * 10.0;
            var to = pos - up * 8000.0;
            // Terrain lives in voxel maps, not in the physics world: CastRay alone
            // returned false over bare planet voxels (measured 2026-11-10), which
            // made level mode refuse with "no ground reference". LosRay covers
            // planets, asteroids and physics bodies.
            var result = LosRay.Cast(from, to);
            if (result.First == null) return false;
            hitPos = result.First.Position;
            agl = Vector3D.Dot(pos - hitPos, up);
            return true;
        }

        public void ApplyGyro(IMyCubeGrid grid, Vector3D rotWorld)
        {
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                if (!gyro.Enabled) gyro.Enabled = true;
                var local = Vector3D.TransformNormal(rotWorld, MatrixD.Transpose((MatrixD)gyro.WorldMatrix));
                gyro.GyroOverride = true;
                gyro.GyroPower = 1.0f;
                gyro.Pitch = (float)LevelMath.Clamp(local.X, -1.0, 1.0);
                gyro.Yaw = (float)LevelMath.Clamp(local.Y, -1.0, 1.0);
                gyro.Roll = (float)LevelMath.Clamp(local.Z, -1.0, 1.0);
            }
        }

        /// <summary>
        /// Distribute a desired force (grid local, N) over the thruster banks by
        /// their real per-direction thrust. A bank whose axis opposes the force
        /// is set to 0 so it never fights the controller.
        /// </summary>
        public void ApplyThrust(IMyCubeGrid grid, Vector3D forceLocal)
        {
            foreach (var bank in Banks(grid))
            {
                var dir = new Vector3D(bank.Direction.X, bank.Direction.Y, bank.Direction.Z);
                if (dir.LengthSquared() < 0.5) dir = Vector3D.UnitY;
                dir.Normalize();
                var component = Vector3D.Dot(forceLocal, dir);
                var pct = (float)LevelMath.AxisOverride(component, bank.CapacityN);
                foreach (var thr in bank.Thrusters)
                {
                    if (thr == null) continue;
                    if (!thr.Enabled) thr.Enabled = true;
                    thr.ThrustOverridePercentage = pct;
                }
            }
        }

        private sealed class Bank
        {
            public Vector3I Direction;
            public double CapacityN;
            public List<IMyThrust> Thrusters = new List<IMyThrust>();
        }

        private static List<Bank> Banks(IMyCubeGrid grid)
        {
            var result = new List<Bank>();
            var index = new Dictionary<string, Bank>();
            // A hull whose thrusters report (0,0,0) (SAT-R-0002: all 12) would
            // otherwise collapse into one bogus bank and the controller would
            // push every thruster along the same axis. Classify geometrically.
            var geometry = ThrusterGeometry.Classify(grid);
            var axes = new Dictionary<long, Vector3I>();
            foreach (var a in geometry.Thrusters)
            {
                if (a.Thruster != null) axes[a.Thruster.EntityId] = a.GridAxis;
            }
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                Vector3I d;
                if (!axes.TryGetValue(thr.EntityId, out d)) d = thr.GridThrustDirection;
                if (d == Vector3I.Zero) continue;   // unclassifiable: never drive it
                var key = d.X + "," + d.Y + "," + d.Z;
                Bank bank;
                if (!index.TryGetValue(key, out bank))
                {
                    bank = new Bank { Direction = d };
                    index[key] = bank;
                    result.Add(bank);
                }
                bank.Thrusters.Add(thr);
                bank.CapacityN += thr.MaxEffectiveThrust;
            }
            ApplyDirectionConvention(grid, result);
            return result;
        }

        /// <summary>
        /// Decide, per hull, whether the engine's `GridThrustDirection` is the
        /// PUSH direction or the EXHAUST direction, and flip every bank's
        /// direction so `Direction` always means "where this bank pushes".
        ///
        /// The convention is not documented and it is not stable across hulls:
        /// measured 2026-11-10 on SAT-R-0001 all six lift thrusters reported
        /// (0,-1,0) while the hull's local up is +Y — the exhaust direction —
        /// so `UpThrust` found 0 N of lift and every level/land job refused with
        /// "lift thrust 0 kN < 1.05 x weight" on a hull that hovers at 2.8 TWR.
        ///
        /// The decision is measured, not assumed: in gravity the biggest bank
        /// aligned with the vertical axis IS the lift (nothing else holds a hull
        /// up), so if that bank faces local DOWN the whole report is
        /// exhaust-signed and every bank is flipped.
        /// </summary>
        private static void ApplyDirectionConvention(IMyCubeGrid grid, List<Bank> banks)
        {
            if (banks.Count == 0) return;
            var phys = grid.Physics;
            var gravity = phys != null ? (Vector3D)phys.Gravity : Vector3D.Zero;
            if (gravity.LengthSquared() < 0.01)
            {
                try
                {
                    float ig;
                    gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(grid.PositionComp.GetPosition(), out ig);
                }
                catch { }
            }
            if (gravity.LengthSquared() < 0.01) return;
            var localUp = Vector3D.TransformNormal(Vector3D.Normalize(-gravity), MatrixD.Transpose(grid.WorldMatrix));

            Bank strongest = null;
            double strongestAlignment = 0;
            foreach (var bank in banks)
            {
                var dir = new Vector3D(bank.Direction.X, bank.Direction.Y, bank.Direction.Z);
                if (dir.LengthSquared() < 0.5) continue;
                dir.Normalize();
                var a = Vector3D.Dot(dir, localUp);
                if (Math.Abs(a) < 0.5) continue;                    // not vertical
                if (strongest != null && bank.CapacityN <= strongest.CapacityN) continue;
                strongest = bank;
                strongestAlignment = a;
            }
            if (strongest == null || strongestAlignment > 0) return;  // engine already reports push

            foreach (var bank in banks) bank.Direction = new Vector3I(-bank.Direction.X, -bank.Direction.Y, -bank.Direction.Z);
        }

        /// <summary>Thrust available along world "up", N (from the grid's real banks).</summary>
        public static double UpThrust(Vector3D up, IMyCubeGrid grid)
        {
            var localUp = Vector3D.TransformNormal(up, MatrixD.Transpose(grid.WorldMatrix));
            double total = 0;
            foreach (var bank in Banks(grid))
            {
                var dir = new Vector3D(bank.Direction.X, bank.Direction.Y, bank.Direction.Z);
                if (dir.LengthSquared() > 0.5) dir.Normalize();
                if (Vector3D.Dot(dir, localUp) > 0.5) total += bank.CapacityN;
            }
            return total;
        }

        /// <summary>
        /// T61: only a REAL pilot takes the ship off the plugin's control loop.
        /// An occupied passenger seat (CanControlShip false) is not a pilot, so
        /// the ship keeps flying with the passenger aboard.
        /// </summary>
        private static string UnderControl(IMyCubeGrid grid)
        {
            var pilot = ControlReport.Classify(grid, null).Pilot;
            if (pilot == null) return null;
            var seat = string.IsNullOrEmpty(pilot.Seat) ? "controller" : pilot.Seat;
            return seat + " (" + (string.IsNullOrEmpty(pilot.ControllerType) ? "controller" : pilot.ControllerType) + ")";
        }

        /// <summary>Take the ship out of autopilot and zero every override before the loop starts.</summary>
        public void Prepare(IMyCubeGrid grid)
        {
            if (grid == null) return;
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                try { if (rc.IsAutoPilotEnabled) rc.SetAutoPilotEnabled(false); } catch { }
            }
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                if (!thr.Enabled) thr.Enabled = true;
                thr.ThrustOverridePercentage = 0f;
            }
        }

        public void ReleaseOverrides(IMyCubeGrid grid)
        {
            if (grid == null) return;
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                try { thr.ThrustOverridePercentage = 0f; } catch { }
            }
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                try
                {
                    gyro.Pitch = 0; gyro.Yaw = 0; gyro.Roll = 0;
                    gyro.GyroOverride = false;
                }
                catch { }
            }
        }

        private static IMyCubeGrid FindGrid(long id)
        {
            IMyEntity ent;
            if (!MyAPIGateway.Entities.TryGetEntityById(id, out ent)) return null;
            return ent as IMyCubeGrid;
        }

        /// <summary>
        /// Dampeners are a per-controller block setting, not a grid property:
        /// set every ship controller on the grid. A controller that flies the
        /// hull with thrust overrides must turn them OFF (they would fight the
        /// overrides), and every job hands the grid back with them ON.
        /// </summary>
        public static void SetDampeners(IMyCubeGrid grid, bool on)
        {
            if (grid == null) return;
            foreach (var c in grid.GetFatBlocks<IMyShipController>())
            {
                if (c == null) continue;
                try { c.DampenersOverride = on; } catch { }
            }
        }

        /// <summary>Autopilot off on every remote control of the grid.</summary>
        public static void AutopilotOff(IMyCubeGrid grid)
        {
            if (grid == null) return;
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                try { if (rc.IsAutoPilotEnabled) rc.SetAutoPilotEnabled(false); } catch { }
            }
        }

        private JObject Status(Job job, IMyCubeGrid grid)
        {
            var row = new JObject
            {
                ["gridId"] = "grid:" + job.GridId,
                ["mode"] = job.Mode,
                ["state"] = job.State,
                ["note"] = job.Note,
                ["targetAglM"] = Math.Round(job.TargetAglM, 1),
                ["maxLateralMps"] = job.MaxLateralMps,
                ["maxTiltDeg"] = job.MaxTiltDeg,
                ["peakTiltDeg"] = Math.Round(job.PeakTilt, 2),
                ["maxSpeedMps"] = Math.Round(job.MaxSpeedSeen, 2),
                ["verticalAccelCmdMs2"] = Math.Round(job.LastVerticalAccelCmd, 3),
                ["horizontalAccelCmdMs2"] = Math.Round(job.LastHorizontalAccelCmd, 3),
                ["gyroSign"] = job.GyroSign,
                ["signFlips"] = job.SignFlips,
                ["yawSignProven"] = job.YawSignProven,
                ["yawDampOverride"] = Math.Round(job.YawDampOverride, 3),
                ["elapsedSec"] = Math.Round(_now - job.StartedAt, 1),
            };
            if (job.MaxAglSeen > double.MinValue) row["maxAglM"] = Math.Round(job.MaxAglSeen, 1);
            if (job.MinAglSeen < double.MaxValue) row["minAglM"] = Math.Round(job.MinAglSeen, 1);
            if (grid != null && grid.Physics != null)
            {
                row["position"] = Vec(grid.PositionComp.GetPosition());
                row["velocity"] = Vec((Vector3D)grid.Physics.LinearVelocity);
            }
            return row;
        }

        private static JObject Vec(Vector3D v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }

        private static string Fmt(Vector3D v)
        {
            return "(" + Math.Round(v.X, 1) + "," + Math.Round(v.Y, 1) + "," + Math.Round(v.Z, 1) + ")";
        }

        private void Log(string level, string message)
        {
            try { _log(level, "level: " + message); } catch { }
        }
    }
}
