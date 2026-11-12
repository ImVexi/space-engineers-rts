using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using Sandbox.Game.Entities;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRage.ModAPI;
using VRageMath;
using IMyThrust = Sandbox.ModAPI.IMyThrust;
using IMyGyro = Sandbox.ModAPI.IMyGyro;
using IMyShipController = Sandbox.ModAPI.IMyShipController;
using IMyRemoteControl = Sandbox.ModAPI.IMyRemoteControl;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Final-descent landing controller (`land_at`), test build only.
    ///
    /// WHY IT LIVES ON THE GAME THREAD. The backend controls at telemetry
    /// cadence (2-5 s) and measured 2026-11-10 that a dampener-pulse final
    /// descent from there oscillates: decisions 5-8 s apart, every off-pulse
    /// added 20-35 m/s, impact ~19 m/s. SE's autopilot will not fly to a
    /// waypoint straight below either — it climbs away. The last 150 m need a
    /// loop that runs every tick, so the backend sends ONE order and monitors.
    ///
    /// LIFECYCLE (each phase runs every 0.1 s on the game thread):
    ///
    ///   settling    THE GYRO SIGN IS PROVEN HERE, FIRST, ALWAYS. On the first
    ///               tick — settled or not, spinning or not — a small known yaw
    ///               (about 1 deg/s for 0.4 s) is commanded and the CHANGE of
    ///               the angular rate along that axis decides the sign. Until it
    ///               has decided, no correction is applied above 10 % gain or
    ///               2 deg/s^2 of commanded angular acceleration; after it, the
    ///               gyro holds the hull on local up and damps every rate with
    ///               dampeners ON and the banks at 0. The descent starts only
    ///               under 0.5 deg/s, at most 15 s in (an arrival spin up to
    ///               30 deg/s is accepted: the settle's job is to damp it. The
    ///               backend settles the hull before handover — set 6's 80.5
    ///               deg/s handover is damped there, not by widening this gate).
    ///   descending  agl = |pos - planetCentre| - groundRadius - keelDepth
    ///               v_des = LandMath.SinkSetpoint(agl)
    ///               a_up  = clamp(k*(-v_des - v_up), -0.5 g, +authority)
    ///               thrust = clamp(m*(g + a_up), 0, lift capacity)
    ///               with the gyro still holding level and dampeners OFF.
    ///   safe-hover  WHAT EVERY ABORT DOES. The gyro keeps holding level, the
    ///               lift bank is driven at the weight command (weight / lift
    ///               capacity, plus a vertical-speed damper so a sinking hull
    ///               is ARRESTED, not merely slowed) and the dampeners go ON.
    ///               The overrides are handed back only after |v| <= 0.5 m/s
    ///               AND tilt < 5 deg for 2 s, or when the hull is on the
    ///               ground. A tumbling hull gets recovery, never abandonment.
    ///   landed      touchdown (hull bottom &lt;= 2 m, |v| &lt;= 0.5 m/s) or 0.5 s
    ///               of contact (stopped while the lift bank is under weight).
    ///
    /// WHY THE OLD CODE CRASHED SAT-R-0001. Its first in-game abort (27 deg
    /// tilt) called the same cleanup as a landing: gyro released, thrust
    /// released, dampeners on — 240 m up, with a hull that was still spinning.
    /// It fell and broke up (24 -> 8 blocks). The abort path is now the hover
    /// above, and the tilt gate moved to 35 deg because the sign-learning it
    /// raced was too slow: it needed ~1 s of +0.02 deg growth, so the abort
    /// fired first. Sign learning now flips on 0.3 deg of growth inside 1 s and
    /// the settle phase proves the sign up front with a measured test command.
    /// </summary>
    public sealed class LandController
    {
        private const double TickIntervalSec = 0.1;
        private const double LogIntervalSec = 5.0;
        /// <summary>One `land_status` line per second while falling/braking/descending.</summary>
        private const double StatusLogIntervalSec = 1.0;
        private const double LateralGain = 0.6;          // 1/s on horizontal velocity
        private const double MaxLateralAccelG = 0.15;
        private const int ContactTicksRequired = 5;      // 0.5 s of terrain carrying the hull
        private const double MinLiftRatioAbort = 1.01;

        public static readonly LandController Instance = new LandController();

        private sealed class Job
        {
            public long GridId;
            public double GroundRadiusM;
            public double KeelDepthM;
            public double SinkMps;
            public double FinalSinkMps;
            public double FinalBandM;
            /// <summary>Free-fall speed cap from the order, m/s (0 = no cap).</summary>
            public double MaxFallMps;
            /// <summary>settling|fall|brake|descending|safe-hover|landed|aborted</summary>
            public string Phase = "settling";
            /// <summary>
            /// T61: a passenger (or a player standing inside the hull) is aboard.
            /// The free-fall phase is then refused: SE throws loose characters
            /// around under a ballistic fall, so the dampened descent flies it.
            /// </summary>
            public bool CarryingPassengers;
            public string PassengerNote = "";
            public string Reason = "";
            /// <summary>Why the descent stopped, kept while the safe hover flies.</summary>
            public string AbortReason = "";
            public double StartedAt;
            public double LastTickAt;
            public double LastLogAt;
            public double EndedAt = -1;
            public double ElapsedSec;

            // --- fall / brake (the plugin owns the descent from ANY height) ---
            public double FallStartedAt = -1;
            public double FallSec;
            public double BrakeStartedAt = -1;
            public double BrakeSec;
            /// <summary>Measured shed authority used this tick, m/s^2.</summary>
            public double ABrakeMs2;
            /// <summary>Hull-bottom AGL the brake starts at, recomputed every tick.</summary>
            public double BrakeAglM;
            public double BrakeStartAglM = double.NaN;
            public double BrakeStartMps = double.NaN;
            public bool FallCapHeld;

            public double PositionAglM;
            public double HullBottomAglM;
            public double VerticalSpeedMps;      // up-positive
            public double SinkTargetMps;         // down-positive
            public double ThrustFraction;
            public double ThrustN;
            public double LiftCapacityN;
            public double TiltDeg;
            public double PeakTiltDeg;
            public double MaxSinkSeenMps;
            public double MinAglSeenM = double.MaxValue;
            public double LiveKeelM;
            public double ControlKeelM;
            public string GroundSource = "radius";
            public double? LosAglM;
            public double SpinDegS;
            /// <summary>Last extra roll/pitch damping demand added to the attitude rot, rad/s.</summary>
            public double RateDampRadS;
            /// <summary>
            /// Last extra yaw (up-axis) rate damping demand added to the attitude
            /// rot, override units. Positive = about +up.
            /// </summary>
            public double YawDampOverride;
            /// <summary>
            /// The sign test proved a yaw response (sign != 0). Yaw rate damping
            /// is commanded ONLY while this is true: a guessed sign would spin
            /// the hull up instead of damping it. Revoked on any sign flip.
            /// </summary>
            public bool YawSignProven;

            // --- horizontal position hold (2026-11-11 set 3) ------------------
            /// <summary>
            /// The column the `land_at` order was given for: the hull's position
            /// when the order landed, which is the column its ground datum was
            /// sampled at. The hold flies back to it, in the local horizontal
            /// plane; nothing vertical is ever asked of it.
            /// </summary>
            public Vector3D TargetPos;
            public bool TargetSet;
            /// <summary>
            /// Where <see cref="TargetPos"/> came from: "order" (a `land_at`
            /// target inside the cap), "handover" (no target, or one too far),
            /// or "none" (an unreadable hull position). Reported in
            /// `land_status` so the flight proof can tell them apart.
            /// </summary>
            public string TargetSource = "none";
            /// <summary>
            /// Horizontal distance from the handover column to the ORDERED
            /// target, m; NaN when the order carried none.
            /// </summary>
            public double TargetOffsetFromHandoverM = double.NaN;
            /// <summary>
            /// Why an ordered target was refused for the hold, or null. Set at
            /// start only, so "target too far for hold" is a fact of the order.
            /// </summary>
            public string TargetRefused = null;
            /// <summary>Horizontal distance from the ordered column, m.</summary>
            public double LateralOffsetM;
            /// <summary>Horizontal speed of the hull, m/s (the `vh` in `land_status`).</summary>
            public double LateralVelMps;
            /// <summary>Last lateral tilt request actually applied, deg (magnitude).</summary>
            public double LateralTiltDeg;
            /// <summary>Cap in force this tick after the levelling budget, deg.</summary>
            public double LateralCapLastDeg;
            /// <summary>Why the hold is off, or null when it flew this tick.</summary>
            public string LateralHold = "refused: phase is not brake or descending";
            /// <summary>
            /// The reason last PRINTED in a `land_status` line. A standing
            /// condition ("refused: gyro sign unproven" lasts the whole descent
            /// when the sign test measured no response) is logged when it starts
            /// and when it changes, not on every tick - verify #4 showed it
            /// repeating once a second, reading like an active fault.
            /// </summary>
            public string LateralHoldLogged;
            /// <summary>When the hull entered the zero band (at or below 6 m AGL), s; -1 = outside.</summary>
            public double FinalBandSince = -1;

            public double ClimbFromAglM = double.MaxValue;
            public double ClimbSince = -1;
            public int ContactTicks;

            // --- stall touchdown (2026-11-11 flight proof, second landing) ----
            /// <summary>Where the still window began, m; valid when <see cref="StallAnchorSet"/>.</summary>
            public Vector3D StallAnchorPos;
            public bool StallAnchorSet;
            /// <summary>When the hull became still inside the final band, s; -1 = not yet.</summary>
            public double StallSince = -1;
            /// <summary>Hull-bottom AGL a `land_ground` update put under the contact gate; NaN = none.</summary>
            public double DatumAglM = double.NaN;

            // --- attitude: settle, sign test, sign learning -------------------
            public double GyroSign = 1.0;
            public int SignFlips;
            public bool SignTested;
            /// <summary>0 = not started; 1..SignTestTicks = commanding; then decide.</summary>
            public int SignTestTick;
            public int SignTestAttempt;
            public double SignTestBaseline;
            public double SignTestCommand;
            public Vector3D SignTestAxis = Vector3D.Zero;
            /// <summary>Measured rate CHANGE over the test window, deg/s.</summary>
            public double SignTestRateDegS;
            /// <summary>Measured deg/s of achieved rate per unit of gyro override.</summary>
            public double RatePerCommandDegS = LandMath.NominalRatePerCommandDegS;
            /// <summary>Full gain and the loose acceleration cap are allowed from here.</summary>
            public double SafeAttitudeUntil = 0;
            public double LastSignFlipAt = -1;
            /// <summary>Last gyro command sent, for the per-tick acceleration ramp.</summary>
            public Vector3D LastGyroCmd = Vector3D.Zero;
            public double SettleStartedAt;
            public double SettleSec;
            public bool Settled;
            public double TiltRef;
            public double TiltRefAt = -1;

            // --- safe hover ---------------------------------------------------
            public double HoverStartedAt = -1;
            public double HoverSec;
            public double CalmSince = -1;
            public double HoverThrustFraction;
            public double HoverSpeedAtAbort;
            public double HoverTiltAtAbort;
            /// <summary>Up-authority cap for the hold, x g (full brake for a fast arrival).</summary>
            public double HoverUpAccelG = LandMath.SafeHoverUpAccelG;

            // --- live ground datum (defect b, 2026-11-11) ---------------------
            /// <summary>Accepted `land_ground` updates since the handover.</summary>
            public int GroundUpdates;
            public double LastGroundUpdateAt = -1;
            /// <summary>The radius the last accepted update REPLACED, m.</summary>
            public double PreviousGroundRadiusM;
            /// <summary>Signed change of the last accepted update, m.</summary>
            public double LastGroundDeltaM;
            /// <summary>Last refusal of an update, kept for `land_status`.</summary>
            public string GroundUpdateRefusal = null;
        }

        private readonly Dictionary<long, Job> _jobs = new Dictionary<long, Job>();
        private Action<string, string> _log = (l, m) => { };
        private double _now;

        public void SetLogger(Action<string, string> log)
        {
            _log = log ?? ((l, m) => { });
        }

        // ------------------------------------------------------------------ API

        /// <summary>
        /// Start the per-tick final descent for one grid. The parameters are the
        /// ones the backend's ONE `land_at` order carries.
        /// </summary>
        public JObject Start(
            long gridId, double groundRadiusM, double keelDepthM,
            double sinkMps, double finalSinkMps, double finalBandM, double maxFallMps)
        {
            return Start(gridId, groundRadiusM, keelDepthM, sinkMps, finalSinkMps, finalBandM, maxFallMps, null);
        }

        /// <summary>
        /// `land_at` with an OPTIONAL requested target position (2026-11-11
        /// flight set 5). The backend flies a lateral leg above the requested
        /// column before handing over, so the order can now say WHERE the hull
        /// is meant to come down instead of leaving the hold to fly back to the
        /// handover column (where the hull already is). A target outside
        /// <see cref="LandMath.LateralTargetMaxM"/> is REFUSED for the hold and
        /// logged ("target too far for hold"): the hull never chases a far
        /// point with 5 deg of bank. All hold gates, caps and abort thresholds
        /// are unchanged either way.
        /// </summary>
        public JObject Start(
            long gridId, double groundRadiusM, double keelDepthM,
            double sinkMps, double finalSinkMps, double finalBandM, double maxFallMps,
            Vector3D? targetPos)
        {
            var grid = FindGrid(gridId);
            if (grid == null) return Refusal(gridId, "grid not in scene");

            var pos = grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero;
            Vector3D centre;
            string planetName;
            var hasPlanet = PlanetUnder(pos, out centre, out planetName);
            float ig;
            var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out ig);
            var g = (double)gravity.Length();
            var up = g > LevelMath.MinGravityMs2
                ? new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g)
                : Vector3D.UnitY;
            var mass = grid.Physics != null ? (double)grid.Physics.Mass : 0.0;
            var liftN = LevelFlightController.UpThrust(up, grid);
            var tilt = LevelMath.TiltDeg(Vector3D.Dot(grid.WorldMatrix.Up, up));
            if (!(groundRadiusM > 0) || double.IsNaN(groundRadiusM))
                return Refusal(gridId, "groundRadiusM " + groundRadiusM + " is not a ground radius");

            // START CHECKS: where is the hull bottom really? A start 49 m BELOW
            // the ground datum was accepted by the old code and immediately
            // reported as "touchdown"; a hull already sitting on the ground was
            // flown. Both are refusals now, with the numbers in the reason.
            var controlKeel = TrueKeelM(grid, up);
            if (double.IsNaN(controlKeel)) controlKeel = double.IsNaN(keelDepthM) ? 0.0 : keelDepthM;
            var posAgl = hasPlanet ? (pos - centre).Length() - groundRadiusM : double.NaN;
            var hullBottomAgl = LandMath.HullBottomAglM(posAgl, controlKeel);
            var spin = 0.0;
            try
            {
                if (grid.Physics != null)
                    spin = LandMath.SpinDegS(((Vector3D)grid.Physics.AngularVelocity).Length());
            }
            catch { }

            var refusal = LandMath.StartRefusal(
                grid.IsStatic, grid.Physics != null, hasPlanet, g, tilt, liftN, mass, UnderControl(grid) != null,
                hullBottomAgl, spin);
            if (refusal != null) return Refusal(gridId, refusal);

            var job = new Job
            {
                GridId = grid.EntityId,
                GroundRadiusM = groundRadiusM,
                KeelDepthM = double.IsNaN(keelDepthM) ? 0.0 : keelDepthM,
                SinkMps = sinkMps > 0 ? sinkMps : 5.0,
                FinalSinkMps = finalSinkMps >= 0 ? finalSinkMps : 0.4,
                FinalBandM = finalBandM > 0 ? finalBandM : 15.0,
                MaxFallMps = maxFallMps > 0 ? maxFallMps : LandMath.DefaultMaxFallMps,
                StartedAt = _now,
                LastTickAt = _now,
                SettleStartedAt = _now,
                FallStartedAt = _now,
                Phase = "settling",
                SpinDegS = spin,
            };
            job.LiftCapacityN = liftN;
            job.TiltDeg = tilt;
            job.PeakTiltDeg = tilt;
            job.LiveKeelM = GridGeometry.KeelDepthM(grid);
            job.ControlKeelM = controlKeel;
            job.PositionAglM = posAgl;
            job.HullBottomAglM = hullBottomAgl;
            job.TiltRef = tilt;
            job.ABrakeMs2 = LandMath.BrakeAccelMs2(liftN, mass, g);
            job.BrakeAglM = LandMath.BrakeAglM(0, job.ABrakeMs2, job.FinalBandM);
            // The ordered column, for the horizontal hold: this is the column the
            // order's ground datum was sampled at, so it is the one the hull has
            // to come down over. NaN-safe: a hold with no target never flies.
            job.TargetPos = pos;
            job.TargetSet = !double.IsNaN(pos.X) && !double.IsNaN(pos.Y) && !double.IsNaN(pos.Z);
            job.TargetSource = job.TargetSet ? "handover" : "none";
            // An ORDERED target (2026-11-11 flight set 5) wins over the handover
            // column, but only inside the cap: a target 182 m away is the
            // backend's lateral leg's job, not the hold's. The offset is measured
            // TANGENTIALLY (the hold only ever spends tilt in the horizontal
            // plane), so a target 40 m lower over the same column is 0 m away.
            if (targetPos.HasValue)
            {
                var d = targetPos.Value - pos;
                job.TargetOffsetFromHandoverM = LandMath.TangentialOffsetM(d.X, d.Y, d.Z, up.X, up.Y, up.Z);
                var refused = LandMath.TargetRefusal(job.TargetOffsetFromHandoverM);
                if (refused == null)
                {
                    job.TargetPos = targetPos.Value;
                    job.TargetSource = job.TargetSet ? "order" : "none";
                }
                else
                {
                    job.TargetRefused = refused;
                    Log("warn", "land_at grid:" + grid.EntityId + " " + refused);
                }
            }

            // T61 passenger rule: a pilot stops the job (checked above); a
            // passenger only changes HOW it is flown. No free fall with people
            // aboard who are not strapped into a pilot seat.
            var crew = ControlReport.Classify(grid, ControlReport.ScanPlayers(null));
            job.CarryingPassengers = crew.HasPassengers || crew.HasStanding;
            job.PassengerNote = crew.CarryingSentence() ?? "";

            _jobs[grid.EntityId] = job;
            // Autopilot off, every override zeroed, dampeners ON: the settle
            // phase owns the gyro, the dampeners keep the hull where it is.
            LevelFlightController.AutopilotOff(grid);
            LevelFlightController.Instance.Prepare(grid);
            LevelFlightController.SetDampeners(grid, true);

            Log("info", "land_at grid:" + grid.EntityId + " from " + Math.Round(job.HullBottomAglM, 1) +
                " m hull-bottom AGL (pivot " + Math.Round(job.PositionAglM, 1) + ", belly keel " +
                Math.Round(job.ControlKeelM, 2) + ", order keel " + Math.Round(job.KeelDepthM, 2) +
                "), sink " + job.SinkMps + " m/s -> " + job.FinalSinkMps + " under " + job.FinalBandM +
                " m, fall cap " + job.MaxFallMps + " m/s, lift " + Math.Round(liftN / 1000) + " kN vs weight " +
                Math.Round(mass * g / 1000) + " kN (a_brake " + Math.Round(job.ABrakeMs2, 1) +
                " m/s2, brake height " + Math.Round(job.BrakeAglM, 1) + " m), tilt " + Math.Round(tilt, 1) +
                " deg, spin " + Math.Round(spin, 2) + " deg/s, hold target " + job.TargetSource +
                (double.IsNaN(job.TargetOffsetFromHandoverM)
                    ? ""
                    : " (" + Math.Round(job.TargetOffsetFromHandoverM, 1) + " m from the handover column)") +
                ": settling attitude before any descent");
            return Status(job);
        }

        public JObject Stop(long gridId, string reason)
        {
            return Stop(gridId, reason, false);
        }

        /// <summary>
        /// Live ground datum update (defect b, 2026-11-11). `land_at`
        /// carried ONE `groundRadiusM`, sampled at the column the handover
        /// happened on; the descent then travels hundreds of metres and the
        /// terrain under the hull is a different number. Measured 2026-11-10 the
        /// datum was ~10 m low at the final column, and a 10 m error at the
        /// flare is a brake decision on the wrong ground.
        ///
        /// The backend re-samples the height field at the hull's live up vector
        /// and sends `land_ground` whenever it moves by more than
        /// <see cref="LandMath.GroundUpdateMinDeltaM"/>. The controller
        /// re-derives the AGL on the next tick, so the brake/flare/touchdown
        /// decisions all use the current column's ground.
        ///
        /// A wild jump (a broken sample) is refused and logged, never applied:
        /// a datum that moves a quarter of a kilometre in one update is a bug.
        /// </summary>
        public JObject UpdateGround(long gridId, double groundRadiusM)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job))
                return new JObject
                {
                    ["gridId"] = "grid:" + gridId,
                    ["updated"] = false,
                    ["reason"] = "no land job for this grid: the datum is set by land_at",
                };
            if (job.Phase == "landed" || job.Phase == "aborted")
                return new JObject
                {
                    ["gridId"] = "grid:" + gridId,
                    ["updated"] = false,
                    ["reason"] = "job is " + job.Phase + ": no descent left to correct",
                };

            string refusal;
            if (!LandMath.AcceptGroundUpdate(groundRadiusM, job.GroundRadiusM, out refusal))
            {
                job.GroundUpdateRefusal = refusal;
                Log("warn", "land ground REFUSED grid:" + gridId + ": " + refusal);
                return new JObject
                {
                    ["gridId"] = "grid:" + gridId,
                    ["updated"] = false,
                    ["reason"] = refusal,
                    ["groundRadiusM"] = Math.Round(job.GroundRadiusM, 2),
                };
            }

            var previous = job.GroundRadiusM;
            var delta = groundRadiusM - previous;
            if (Math.Abs(delta) < LandMath.GroundUpdateMinDeltaM)
                return new JObject
                {
                    ["gridId"] = "grid:" + gridId,
                    ["updated"] = false,
                    ["reason"] = "within " + LandMath.GroundUpdateMinDeltaM + " m of the current datum",
                    ["groundRadiusM"] = Math.Round(previous, 2),
                    ["deltaM"] = Math.Round(delta, 2),
                };

            job.GroundRadiusM = groundRadiusM;
            job.PreviousGroundRadiusM = previous;
            job.LastGroundDeltaM = delta;
            job.GroundUpdates++;
            job.LastGroundUpdateAt = _now;
            job.GroundUpdateRefusal = null;

            // The AGL the next tick will act on, computed NOW on the new datum
            // so the log line states the correction rather than the old number.
            var recalculated = double.NaN;
            var grid = FindGrid(gridId);
            if (grid != null && grid.PositionComp != null)
            {
                Vector3D centre;
                string planetName;
                var pos = grid.PositionComp.GetPosition();
                if (PlanetUnder(pos, out centre, out planetName))
                {
                    var posAgl = (pos - centre).Length() - job.GroundRadiusM;
                    recalculated = LandMath.HullBottomAglM(posAgl, job.ControlKeelM);
                }
            }
            // A datum that lands the hull inside the contact gate has landed it:
            // the remaining AGL the descent was flying to is gone, so there is
            // nothing left to fly. Only in a commanded descent — a datum update
            // during a fall or the settle must not shortcut the descent.
            if ((job.Phase == "brake" || job.Phase == "descending") && LandMath.IsDatumTouchdown(recalculated))
                job.DatumAglM = recalculated;
            Log("info", "land ground grid:" + gridId + " datum " + Math.Round(previous, 1) + " -> " +
                Math.Round(groundRadiusM, 1) + " m (" + (delta >= 0 ? "+" : "") + Math.Round(delta, 1) +
                "), hull-bottom AGL now " + Math.Round(recalculated, 1) + " m, update " + job.GroundUpdates +
                ", phase " + job.Phase +
                (!double.IsNaN(job.DatumAglM) ? " (touchdown reason=datum next tick)" : ""));
            var row = Status(job);
            row["updated"] = true;
            row["previousGroundRadiusM"] = Math.Round(previous, 2);
            row["deltaM"] = Math.Round(delta, 2);
            return row;
        }

        /// <summary>
        /// End a job. A running descent is NOT released into the air: it is
        /// moved to the safe hover and the overrides come back only once the
        /// hull is calm (or on the ground). `force` is the deliberate emergency
        /// release for an operator standing next to the ship.
        /// </summary>
        public JObject Stop(long gridId, string reason, bool force)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job))
                return new JObject { ["gridId"] = "grid:" + gridId, ["stopped"] = false, ["note"] = "no land job" };

            if (force || job.Phase == "landed" || job.Phase == "aborted")
            {
                job.Reason = reason ?? job.Reason;
                if (force && (job.Phase == "settling" || job.Phase == "descending" || job.Phase == "safe-hover"))
                    Release(job, "force-stopped: " + (reason ?? "land_stop"));
                else _jobs.Remove(gridId);
                return Status(job);
            }
            if (job.Phase == "safe-hover")
            {
                var calm = LandMath.SafeToRelease(CurrentSpeed(job), job.TiltDeg) && job.CalmSince >= 0;
                if (calm) Release(job, "stopped while hovering level: " + (reason ?? "land_stop"));
                else
                {
                    job.Reason = "stop requested (" + (reason ?? "land_stop") + "): holding the hover until the hull is level and still";
                    Log("warn", "land stop held grid:" + gridId + ": " + job.Reason);
                }
                return Status(job);
            }
            EnterSafeHover(job, "stopped: " + (reason ?? "land_stop"));
            return Status(job);
        }

        public void StopAll(string reason)
        {
            foreach (var id in _jobs.Keys.ToList())
            {
                try { Stop(id, reason); } catch (Exception ex) { Log("warn", "land stop failed: " + ex.Message); }
            }
        }

        public JObject StatusAll()
        {
            var arr = new JArray();
            foreach (var job in _jobs.Values) arr.Add(Status(job));
            return new JObject { ["jobs"] = arr, ["count"] = arr.Count };
        }

        public JObject StatusOne(long gridId)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job))
                return new JObject { ["gridId"] = "grid:" + gridId, ["active"] = false };
            return Status(job);
        }

        public bool HasJob(long gridId) { return _jobs.ContainsKey(gridId); }

        /// <summary>
        /// Is a land job FLYING this grid right now? A finished job keeps its
        /// record for `land_status`, but it no longer holds the dampeners or the
        /// overrides, so it must not make the dead-man exempt a grid.
        /// </summary>
        public bool HasActiveJob(long gridId)
        {
            Job job;
            if (!_jobs.TryGetValue(gridId, out job)) return false;
            return job.Phase == "settling" || job.Phase == "fall" || job.Phase == "brake" ||
                   job.Phase == "descending" || job.Phase == "safe-hover";
        }

        // ---------------------------------------------------------------- tick

        /// <summary>Called from Plugin.Tick on the game thread.</summary>
        public void Tick(double dt)
        {
            if (_jobs.Count == 0) return;
            _now += dt;
            foreach (var job in _jobs.Values.ToList())
            {
                // A finished job keeps its record for `land_status`, but flies
                // nothing: the overrides were cleared when it ended.
                if (job.Phase != "settling" && job.Phase != "fall" && job.Phase != "brake" &&
                    job.Phase != "descending" && job.Phase != "safe-hover") continue;
                if (_now - job.LastTickAt < TickIntervalSec) continue;
                job.LastTickAt = _now;
                try { Control(job); }
                catch (Exception ex) { Abort(job, "controller error: " + ex.GetType().Name + ": " + ex.Message); }
            }
        }

        private void Control(Job job)
        {
            var grid = FindGrid(job.GridId);
            if (grid == null) { Lost(job, "grid no longer in scene"); return; }
            if (grid.Physics == null) { Lost(job, "no physics body"); return; }
            if (grid.IsStatic) { Abort(job, "grid became static"); return; }

            var pos = grid.PositionComp.GetPosition();
            float ig;
            var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out ig);
            var g = (double)gravity.Length();
            var up = g > LevelMath.MinGravityMs2
                ? new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g)
                : Vector3D.UnitY;

            var vel = (Vector3D)grid.Physics.LinearVelocity;
            var ang = (Vector3D)grid.Physics.AngularVelocity;
            var mass = (double)grid.Physics.Mass;
            var matrix = grid.WorldMatrix;
            var vz = Vector3D.Dot(vel, up);

            job.VerticalSpeedMps = vz;
            job.MaxSinkSeenMps = Math.Max(job.MaxSinkSeenMps, -vz);
            job.SpinDegS = LandMath.SpinDegS(ang.Length());
            job.ElapsedSec = _now - job.StartedAt;

            var tilt = LevelMath.TiltDeg(Vector3D.Dot(matrix.Up, up));
            job.TiltDeg = tilt;
            job.PeakTiltDeg = Math.Max(job.PeakTiltDeg, tilt);

            var liftN = LevelFlightController.UpThrust(up, grid);
            job.LiftCapacityN = liftN;

            Vector3D centre;
            string planetName;
            var hasPlanet = PlanetUnder(pos, out centre, out planetName);
            if (hasPlanet)
            {
                var liveKeel = TrueKeelM(grid, up);
                job.ControlKeelM = double.IsNaN(liveKeel) ? job.KeelDepthM : liveKeel;
                job.PositionAglM = (pos - centre).Length() - job.GroundRadiusM;
                job.HullBottomAglM = LandMath.HullBottomAglM(job.PositionAglM, job.ControlKeelM);
                job.MinAglSeenM = Math.Min(job.MinAglSeenM, job.HullBottomAglM);
            }
            else job.HullBottomAglM = double.NaN;

            // The hover owns everything while it runs: no descent rule may
            // change its mind, and its own release gates are the only way out.
            if (job.Phase == "safe-hover")
            {
                Hold(job, grid, up, g, mass, liftN, vel, ang, matrix, tilt, hasPlanet);
                return;
            }

            // A player on the sticks has the ship: hand it over cleanly.
            var manual = UnderControl(grid);
            if (manual != null) { Release(job, "manual control: " + manual); return; }

            if (!hasPlanet) { Abort(job, "lost the planet under the hull: holding on gravity alone"); return; }

            // --- abort guards -------------------------------------------------
            if (job.ElapsedSec > LandMath.MaxJobSec)
            { Abort(job, "120 s elapsed at " + Math.Round(job.HullBottomAglM, 1) + " m hull-bottom AGL"); return; }
            if (tilt > LandMath.MaxTiltDeg)
            { Abort(job, "tilt " + Math.Round(tilt, 1) + " deg exceeds " + LandMath.MaxTiltDeg + " deg"); return; }
            // The 10 deg/s rule ends a DESCENT, and only a descent: a hull that
            // is falling, braking or on the controlled schedule cannot be
            // landing while it spins that fast. It must NOT end the SETTLE —
            // whose entire job is to damp the spin the hull arrived with (both
            // 2026-11-10 attempts were killed here, in settling, before the
            // attitude loop had a chance to work) — nor the abort hold, which is
            // recovery. The settle has its own 15 s budget instead.
            if (LandMath.DescentPhase(job.Phase) && job.SpinDegS > LandMath.DescentSpinAbortDegS)
            {
                Abort(job, "spinning at " + Math.Round(job.SpinDegS, 1) + " deg/s in " + job.Phase +
                    ": the hull is not under attitude control");
                return;
            }
            if (liftN < MinLiftRatioAbort * mass * g)
            {
                Abort(job, "lift authority lost: " + Math.Round(liftN / 1000) + " kN < " +
                    Math.Round(MinLiftRatioAbort * mass * g / 1000) + " kN weight");
                return;
            }

            if (job.Phase == "settling") { Settle(job, grid, up, mass, g, ang, matrix, tilt, vz); return; }

            // --- the live brake schedule --------------------------------------
            // Recomputed EVERY tick from the current sink rate: the faster the
            // hull is falling, the higher the brake point. This is the property
            // the backend could not provide at telemetry cadence.
            var aBrake = LandMath.BrakeAccelMs2(liftN, mass, g);
            job.ABrakeMs2 = aBrake;
            var sinkNow = Math.Max(0.0, -vz);
            job.BrakeAglM = LandMath.BrakeAglM(sinkNow, aBrake, job.FinalBandM);

            if (job.Phase == "fall" &&
                LandMath.ShouldBrake(job.HullBottomAglM, vz, aBrake, job.FinalBandM))
            {
                job.Phase = "brake";
                job.BrakeStartedAt = _now;
                job.BrakeStartAglM = job.HullBottomAglM;
                job.BrakeStartMps = sinkNow;
                job.FallSec = _now - job.FallStartedAt;
                Log("info", "land BRAKE grid:" + job.GridId + " brake now at " +
                    Math.Round(job.HullBottomAglM, 1) + " m hull-bottom AGL doing " +
                    Math.Round(sinkNow, 1) + " m/s: stopping distance " +
                    Math.Round(sinkNow * sinkNow / (2.0 * aBrake), 1) + " m at a_brake " +
                    Math.Round(aBrake, 1) + " m/s2 x " + LandMath.BrakeMarginFactor + ", free fall lasted " +
                    Math.Round(job.FallSec, 1) + " s (fall cap " + job.MaxFallMps + " m/s)");
            }

            // --- fall: real free fall, thrust override 0, capped if asked ------
            if (job.Phase == "fall")
            {
                var frac = LandMath.FallThrustFraction(
                    mass, g, vz, job.MaxFallMps, liftN, LandMath.FallCapGain, LandMath.BrakeAuthorityG);
                job.ThrustFraction = frac;
                job.ThrustN = frac * liftN;
                if (frac > 0.01 && sinkNow >= job.MaxFallMps - 1.0) job.FallCapHeld = true;

                var velHf = vel - up * vz;
                var aHf = Lateral(velHf, g);
                double rotMagF;
                var rotF = LevelFlightController.AttitudeRotation(matrix, up, ang, out rotMagF);
                LearnSign(job, tilt, rotMagF);
                ApplyAttitude(job, grid, YawDamped(job, RateDamped(job, rotF, up, ang), up, ang));
                var forceWorldF = up * job.ThrustN + aHf * mass;
                LevelFlightController.Instance.ApplyThrust(
                    grid, Vector3D.TransformNormal(forceWorldF, MatrixD.Transpose(matrix)));
                LevelFlightController.SetDampeners(grid, false);
                LogTick(job, vz, 0, "fall");
                return;
            }

            // --- brake: PD to the descent schedule at the hull's own authority --
            // The normal descent caps acceleration at 0.5 g for smoothness; a
            // brake that did the same on a hull with 15 m/s2 of excess thrust
            // would commit to stopping in three times the distance.
            var braking = job.Phase == "brake";
            var accelCap = braking ? LandMath.BrakeAuthorityG : LandMath.MaxAccelG;
            var stopAccel = braking ? aBrake : LandMath.ScheduleStopAccelMs2;
            var vDes = LandMath.SinkSetpoint(
                job.HullBottomAglM, job.SinkMps, job.FinalSinkMps, job.FinalBandM, stopAccel);

            if (braking && sinkNow <= job.SinkMps)
            {
                job.Phase = "descending";
                job.BrakeSec = _now - job.BrakeStartedAt;
                job.ClimbFromAglM = job.HullBottomAglM;
                job.ClimbSince = -1;
                Log("info", "land DESCENT grid:" + job.GridId + " on the schedule after a " +
                    Math.Round(job.BrakeSec, 1) + " s brake at " + Math.Round(job.HullBottomAglM, 1) +
                    " m hull-bottom AGL, v " + Math.Round(vz, 2) + " m/s (brake began at " +
                    Math.Round(job.BrakeStartAglM, 1) + " m doing " + Math.Round(job.BrakeStartMps, 1) +
                    " m/s): controlled descent " + job.SinkMps + " m/s -> " + job.FinalSinkMps + " m/s");
            }

            // A hull that climbs for 5 s is not landing (an override fighting
            // itself, terrain pushing it off a slope, ...). Measured AGL is the
            // only honest judge: it must not rise above the best AGL seen.
            // Armed only in the CONTROLLED descent: during a fall the AGL only
            // drops, and a brake that overshoots upward by a metre is a
            // recovery, not a fault.
            if (job.Phase == "descending")
            {
                if (job.HullBottomAglM > job.ClimbFromAglM + LandMath.ClimbToleranceM)
                {
                    job.ClimbFromAglM = job.HullBottomAglM;
                    job.ClimbSince = _now;
                }
                if (job.ClimbSince >= 0 && _now - job.ClimbSince > LandMath.ClimbWindowSec)
                {
                    Abort(job, "hull-bottom AGL rising for " + LandMath.ClimbWindowSec + " s (" +
                        Math.Round(job.HullBottomAglM, 1) + " m, v " + Math.Round(vz, 2) + " m/s)");
                    return;
                }
            }

            // Ground cross-check: the terrain right under the hull cannot be
            // much nearer than the radius datum, or we are descending onto a
            // hill the datum does not know about.
            job.LosAglM = null;
            try
            {
                var ignore = new List<long> { grid.EntityId };
                // The belly: pos - up*keel (keel is negative when the hull is
                // above the pivot, so a negative keel starts the ray HIGHER).
                var from = pos - up * job.ControlKeelM;
                var los = LosRay.Cast(from, pos - up * 4000.0, ignore);
                if (los.First != null && string.Equals(los.First.Kind, "planet", StringComparison.Ordinal))
                    job.LosAglM = Vector3D.Dot(from - los.First.Position, up);
            }
            catch { }
            if (job.LosAglM.HasValue)
            {
                job.GroundSource = "radius+los";
                if (job.HullBottomAglM - job.LosAglM.Value > LandMath.GroundDisagreementM)
                {
                    Abort(job, "terrain " + Math.Round(job.LosAglM.Value, 1) + " m below the hull but the ground datum says " +
                        Math.Round(job.HullBottomAglM, 1) + " m: refusing to fly into a hill");
                    return;
                }
            }

            // --- control law ---------------------------------------------------
            job.SinkTargetMps = vDes;

            var maxUp = LandMath.MaxUpAccelMs2(liftN, mass, g, accelCap);
            var maxDown = LandMath.MaxAccelG * g;
            var aUp = LandMath.SinkAccel(vDes, vz, LandMath.VelocityGain, maxUp, maxDown);
            var thrustN = LandMath.LiftThrustN(mass, g, aUp, liftN);
            job.ThrustN = thrustN;
            job.ThrustFraction = LandMath.ThrustFraction(mass, g, aUp, liftN);

            // Lateral: damp horizontal velocity toward zero so the descent stays
            // over the column it began on. Never more than 0.15 g; a bank that
            // does not exist simply contributes nothing.
            var velH = vel - up * vz;
            var aH = Lateral(velH, g);

            // --- actuators: attitude first, then the banks ---------------------
            double rotMag;
            var rot = LevelFlightController.AttitudeRotation(matrix, up, ang, out rotMag);
            LearnSign(job, tilt, rotMag);
            // Horizontal position hold: a PD on the two TANGENTIAL axes toward
            // the ordered column, added to the levelling demand (never replacing
            // it) and only in brake/descend. It returns `rot` unchanged whenever
            // a gate refuses, so this line cannot change a tick it does not own.
            rot = HeldAttitude(job, rot, rotMag, pos, up, vel, vz, mass, g, liftN);
            // Defect c: the descent carries its own roll/pitch rate damping, so a
            // residual spin from a single gyro decays instead of riding the fall.
            ApplyAttitude(job, grid, YawDamped(job, RateDamped(job, rot, up, ang), up, ang));

            var forceWorld = up * thrustN + aH * mass;
            var forceLocal = Vector3D.TransformNormal(forceWorld, MatrixD.Transpose(matrix));
            LevelFlightController.Instance.ApplyThrust(grid, forceLocal);
            LevelFlightController.SetDampeners(grid, false);

            // --- touchdown / contact ------------------------------------------
            // A `land_ground` update that moved the datum past the remaining
            // AGL has already landed the hull (the update handler only sets
            // this inside a commanded descent).
            if (!double.IsNaN(job.DatumAglM))
            {
                End(job, "landed", "touchdown reason=datum: a land_ground update put the hull bottom at " +
                    Math.Round(job.DatumAglM, 2) + " m AGL (was " + Math.Round(job.HullBottomAglM + job.LastGroundDeltaM, 2) +
                    " m on the old datum), vertical speed " + Math.Round(vz, 2) + " m/s");
                return;
            }

            // STALL TOUCHDOWN. A ground datum a metre or two high lets the
            // hull rest with the measured AGL above the 2 m contact gate: it
            // sat at 2.96 m, -0.07 m/s, and crawled for ~41 s (2026-11-11,
            // second landing). Resting is landed. Three gates keep a hover out:
            // the job is in the CONTROLLED DESCENT with a sink commanded, the
            // AGL is inside the final band (capped at 6 m), and the hull has
            // not moved at all for StallHoldSec. A hull hovering at 20 m, or
            // one held by the safe-hover abort, fails the first gate twice.
            if (job.Phase == "descending" && vDes > 0)
            {
                var stallSpeed = vel.Length();
                var stallMoved = job.StallAnchorSet ? (pos - job.StallAnchorPos).Length() : double.MaxValue;
                // (Re)start the still window whenever the hull is moving, or has
                // drifted further than the window allows.
                if (stallMoved > LandMath.StallMoveM || !LandMath.StallStill(stallSpeed, 0))
                {
                    job.StallAnchorPos = pos;
                    job.StallAnchorSet = true;
                    job.StallSince = _now;
                    stallMoved = 0;
                }
                var stallSec = job.StallSince >= 0 ? _now - job.StallSince : 0.0;
                if (LandMath.IsStallTouchdown(
                        job.HullBottomAglM, job.FinalBandM, stallSpeed, stallMoved, stallSec))
                {
                    End(job, "landed", "touchdown reason=stall: hull bottom " +
                        Math.Round(job.HullBottomAglM, 2) + " m AGL (final band " +
                        Math.Round(job.FinalBandM, 1) + " m) unmoved for " + Math.Round(stallSec, 1) +
                        " s at " + Math.Round(stallSpeed, 2) + " m/s, vertical speed " +
                        Math.Round(vz, 2) + " m/s: the hull is resting, the datum is high");
                    return;
                }
            }
            else
            {
                job.StallSince = -1;
                job.StallAnchorSet = false;
            }

            if (LandMath.IsTouchdown(job.HullBottomAglM, vz))
            {
                End(job, "landed", "touchdown reason=contact: hull bottom " + Math.Round(job.HullBottomAglM, 2) +
                    " m AGL, vertical speed " + Math.Round(vz, 2) + " m/s");
                return;
            }
            if (LandMath.IsContact(job.HullBottomAglM, vz, thrustN, mass, g)) job.ContactTicks++;
            else job.ContactTicks = 0;
            if (job.ContactTicks >= ContactTicksRequired)
            {
                End(job, "landed", "touchdown reason=contact: hull bottom " + Math.Round(job.HullBottomAglM, 2) +
                    " m AGL, vertical speed " + Math.Round(vz, 2) + " m/s, lift " +
                    Math.Round(thrustN / 1000) + " kN < weight " + Math.Round(mass * g / 1000) + " kN");
                return;
            }

            LogTick(job, vz, vDes, job.Phase);
        }

        /// <summary>
        /// One `land_status` line per second from the controller itself, so an
        /// in-game run can be read straight out of plugin.log with no polling of
        /// the backend during the flight (a 1 Hz backend sampler is what starved
        /// the event loop and cost SAT-R-0001). Spin and tilt are always in the
        /// line: the settle trace has to show what the attitude loop is doing
        /// with the rate it inherited.
        /// </summary>
        private void LogTick(Job job, double vz, double vDes, string phase, string state = null)
        {
            if (_now - job.LastLogAt < StatusLogIntervalSec) return;
            job.LastLogAt = _now;
            // WHY the hold is off is a standing condition, not a per-tick event:
            // printed when it starts and when it changes (LandMath decides), and
            // always available as `lateralHold` in the JSON payload. The old
            // every-tick `why="refused: gyro sign unproven"` read like an active
            // refusal while the hull descended correctly at -0.4 m/s.
            var whyNow = job.LateralHold;
            var whyLog = LandMath.ShouldLogLateralHold(whyNow, job.LateralHoldLogged);
            if (whyLog) job.LateralHoldLogged = whyNow;
            Log("info", "land_status grid:" + job.GridId + " phase=" + phase +
                (state != null ? "(" + state + ")" : "") +
                " agl=" + Math.Round(job.HullBottomAglM, 1) + " v=" + Math.Round(vz, 2) +
                (vDes > 0 ? " vDes=" + Math.Round(vDes, 2) : "") +
                " tilt=" + Math.Round(job.TiltDeg, 1) + " spin=" + Math.Round(job.SpinDegS, 2) +
                " hhold err=" + Math.Round(job.LateralOffsetM, 1) +
                " vh=" + Math.Round(job.LateralVelMps, 2) +
                " tilt=" + Math.Round(job.LateralTiltDeg, 2) +
                " on=" + (job.LateralHold == null ? "true" : "false") +
                (whyLog ? " why=\"" + whyNow + "\"" : "") +
                // WHICH COLUMN the horizontal hold is flying (2026-11-11 flight
                // set 6, defect d). These were JSON-only until set 6, so a
                // flight log could not say whether the hold was on the ORDERED
                // column or the handover column: `hhold err=0` is meaningless
                // without it. Same names as the JSON payload and the order
                // result, so one grep works on all three.
                " holdTarget=" + job.TargetSource +
                (double.IsNaN(job.TargetOffsetFromHandoverM)
                    ? ""
                    : " holdTargetFromHandoverM=" + Math.Round(job.TargetOffsetFromHandoverM, 1)) +
                (job.TargetRefused != null ? " holdTargetRefusal=\"" + job.TargetRefused + "\"" : "") +
                " thrust=" + Math.Round(job.ThrustFraction * 100) +
                "% brakeAgl=" + Math.Round(job.BrakeAglM, 1) + " aBrake=" + Math.Round(job.ABrakeMs2, 1) +
                " t=" + Math.Round(job.ElapsedSec, 1) + "s src=" + job.GroundSource);
        }

        // --------------------------------------------------------------- settle

        /// <summary>
        /// ATTITUDE GATE. Before a metre of descent is flown the hull must stop
        /// turning: gyro override to a null rotation (hold local up, damp every
        /// rate) with the dampeners holding the altitude.
        ///
        /// THE SIGN IS PROVEN FIRST, ALWAYS. Measured 2026-11-10, twice: the old
        /// sign test only ran once the hull was ALREADY settled (|spin| &lt;=
        /// 0.5 deg/s). A hull arriving with 10 and 23 deg/s of residual spin
        /// never got there, so it took the fallback path that applied the
        /// FULL-GAIN correction on an UNVERIFIED default sign — the wrong one on
        /// this hull — and the wrong sign produced 15-68 deg/s^2: 7.5 deg of new
        /// tilt in 0.11 s, which tripped the 10 deg/s descent abort. No
        /// `land gyro sign test` line appeared in either attempt.
        ///
        /// So, on the FIRST tick of settling (settled or not, spinning or not):
        /// command a small known yaw (about 1 deg/s), hold it for 0.4 s, and read
        /// the CHANGE of the angular rate along that axis. The delta is the
        /// gyro's response; a residual spin cannot be mistaken for it. Until that
        /// has decided, no correction is applied at all except at 10 % gain and
        /// under a 2 deg/s^2 ramp (see <see cref="AttitudeVector"/>).
        /// </summary>
        private void Settle(
            Job job, IMyCubeGrid grid, Vector3D up, double mass, double g, Vector3D ang,
            MatrixD matrix, double tilt, double vz)
        {
            job.SettleSec = _now - job.SettleStartedAt;
            // The settle holds altitude with the dampeners, never with the banks.
            LevelFlightController.SetDampeners(grid, true);

            // --- the sign test: unconditional, from the first tick ------------
            if (!job.SignTested)
            {
                RunSignTest(job, grid, ang, matrix, tilt);
                LogTick(job, vz, 0, "settling", "sign-test");
                return;
            }

            double rotMag;
            var rot = LevelFlightController.AttitudeRotation(matrix, up, ang, out rotMag);
            ApplyAttitude(job, grid, YawDamped(job, rot, up, ang));
            LearnSign(job, tilt, rotMag);

            LogTick(job, vz, 0, "settling", job.Settled ? "settled" : "damping");

            if (LandMath.Settled(job.SpinDegS))
            {
                job.Settled = true;
                // T61: re-read the seats at the moment the descent phase is
                // chosen, so a passenger who boarded during the settle is seen.
                // (Seated passengers only here; the standing case is read at
                // Start, where the player scan is cheap because it runs once.)
                if (!job.CarryingPassengers)
                {
                    var settledCrew = ControlReport.Classify(grid, null);
                    job.CarryingPassengers = settledCrew.HasPassengers || settledCrew.HasStanding;
                    if (job.CarryingPassengers) job.PassengerNote = settledCrew.CarryingSentence() ?? "";
                }
                // T61: passengers aboard -> NO dampeners-off free fall. Go
                // straight to the dampened controlled descent (thrust-held
                // sink schedule); the fall phase exists only for empty hulls.
                if (job.CarryingPassengers)
                {
                    job.Phase = "descending";
                    job.ClimbFromAglM = job.HullBottomAglM;
                    job.ClimbSince = -1;
                    job.LastLogAt = _now - StatusLogIntervalSec;
                    LevelFlightController.SetDampeners(grid, true);
                    Log("info", "land DESCENT grid:" + job.GridId + " (settled in " +
                        Math.Round(job.SettleSec, 1) + " s): " + job.PassengerNote +
                        " — dampened descent from " + Math.Round(job.HullBottomAglM, 1) +
                        " m hull-bottom AGL at " + Math.Round(job.SinkMps, 1) + " m/s, no free fall");
                    return;
                }
                // The plugin owns the WHOLE descent now. From any height: fall
                // (dampeners off, lift 0) until the live brake height, then the
                // brake, then the controlled descent. A start already inside the
                // brake height goes straight to the brake.
                job.Phase = "fall";
                job.FallStartedAt = _now;
                job.LastLogAt = _now - StatusLogIntervalSec;
                job.ClimbFromAglM = job.HullBottomAglM;
                // Dampeners OFF and every bank at zero THIS tick: the fall tick
                // is 0.1 s later and must not inherit a dampener-held hull.
                LevelFlightController.SetDampeners(grid, false);
                LevelFlightController.Instance.ApplyThrust(grid, Vector3D.Zero);
                Log("info", "land FALL grid:" + job.GridId + " (settled in " +
                    Math.Round(job.SettleSec, 1) + " s, spin " + Math.Round(job.SpinDegS, 2) +
                    " deg/s, tilt " + Math.Round(tilt, 1) + " deg, gyro sign " + job.GyroSign +
                    "): free fall from " + Math.Round(job.HullBottomAglM, 1) +
                    " m hull-bottom AGL, brake height " + Math.Round(job.BrakeAglM, 1) +
                    " m at a_brake " + Math.Round(job.ABrakeMs2, 1) + " m/s2, cap " + job.MaxFallMps +
                    " m/s");
                return;
            }
            if (job.SettleSec > LandMath.SettleMaxSec)
            {
                Abort(job, "still spinning at " + Math.Round(job.SpinDegS, 2) + " deg/s (over " +
                    LandMath.SettleRateDegS + " deg/s) after " + Math.Round(job.SettleSec, 1) +
                    " s of settling with the gyro sign proved as " + job.GyroSign);
            }
        }

        /// <summary>
        /// THE DETERMINISTIC GYRO SIGN TEST.
        ///
        /// Tick 0: take the hull-up axis, record the angular rate along it, send
        /// a small yaw command. Ticks 1..<see cref="LandMath.SignTestTicks"/>:
        /// hold that command (through the 2 deg/s^2 ramp, so even a wrong-sign
        /// test cannot build up speed). Then compare the rate along the axis
        /// with the baseline: the SIGN of the change IS the gyro sign.
        ///
        /// The command is a rate demand of about 1 deg/s for 0.4 s, which moves a
        /// 37 t hull a few tenths of a degree — invisible from the outside, and
        /// far below the 35 deg tilt gate.
        /// </summary>
        private void RunSignTest(Job job, IMyCubeGrid grid, Vector3D ang, MatrixD matrix, double tilt)
        {
            if (job.SignTestTick == 0)
            {
                var axis = matrix.Up;
                if (axis.LengthSquared() < 1e-6) axis = Vector3D.UnitY;
                axis.Normalize();
                job.SignTestAxis = axis;
                job.SignTestBaseline = Vector3D.Dot(ang, axis);
                job.SignTestCommand = LandMath.SignTestYawCommand *
                                      Math.Pow(LandMath.SignTestRetryScale, job.SignTestAttempt);
            }

            if (job.SignTestTick < LandMath.SignTestTicks)
            {
                ApplyRaw(job, grid, job.SignTestAxis * job.SignTestCommand);
                job.SignTestTick++;
                LogTest(job, tilt, "commanding");
                return;
            }

            var after = Vector3D.Dot(ang, job.SignTestAxis);
            var delta = after - job.SignTestBaseline;
            job.SignTestRateDegS = delta * 180.0 / Math.PI;
            var sign = LandMath.SignFromDelta(job.SignTestBaseline, after,
                LandMath.SignTestMinRateDegS * Math.PI / 180.0);

            if (sign == 0 && job.SignTestAttempt + 1 < LandMath.SignTestAttempts)
            {
                job.SignTestAttempt++;
                job.SignTestTick = 0;
                job.SignTestBaseline = 0;
                job.LastGyroCmd = Vector3D.Zero;
                Log("warn", "land gyro sign test grid:" + job.GridId + " saw only " +
                    Math.Round(job.SignTestRateDegS, 3) + " deg/s of change for a " +
                    job.SignTestCommand + " yaw command: retrying at " +
                    Math.Round(job.SignTestCommand * LandMath.SignTestRetryScale, 3));
                return;
            }

            if (sign != 0)
            {
                job.GyroSign = sign;
                job.RatePerCommandDegS = LandMath.RatePerCommandDegS(job.SignTestRateDegS, job.SignTestCommand);
                // The test commands YAW about the hull's up axis and reads the
                // rate CHANGE along it, so a non-zero sign is direct evidence for
                // the yaw axis too. It is the ONLY thing that may enable the yaw
                // rate damper: a guessed sign there would spin the hull up.
                job.YawSignProven = true;
            }
            else job.YawSignProven = false;
            job.SignTested = true;
            job.SafeAttitudeUntil = _now + LandMath.SignSettleInSec;
            job.TiltRef = tilt;
            job.TiltRefAt = _now;
            Log(sign == 0 ? "warn" : "info", "land gyro sign test grid:" + job.GridId +
                " measured " + Math.Round(job.SignTestRateDegS, 2) + " deg/s of rate CHANGE for a +" +
                job.SignTestCommand + " yaw command over " + (LandMath.SignTestTicks * TickIntervalSec) +
                " s -> sign " + job.GyroSign + " (command scale " + Math.Round(job.RatePerCommandDegS, 1) +
                " deg/s per unit, spin " + Math.Round(job.SpinDegS, 1) + " deg/s, tilt " +
                Math.Round(tilt, 1) + " deg, yaw-damp " + (job.YawSignProven ? "armed" : "OFF (no yaw sign evidence)") + ")" +
                (sign == 0 ? ": NO measurable response, keeping the default sign and 10 % gain" : ""));
        }

        private void LogTest(Job job, double tilt, string state)
        {
            if (_now - job.LastLogAt < StatusLogIntervalSec) return;
            job.LastLogAt = _now;
            Log("info", "land_status grid:" + job.GridId + " phase=settling(" + state + ")" +
                " agl=" + Math.Round(job.HullBottomAglM, 1) + " spin=" + Math.Round(job.SpinDegS, 2) +
                " tilt=" + Math.Round(tilt, 1) + " yawCmd=" + job.SignTestCommand +
                " sample=" + job.SignTestTick + "/" + LandMath.SignTestTicks +
                " dRate=" + Math.Round(job.SignTestRateDegS, 3) + " attempt=" + (job.SignTestAttempt + 1) +
                " t=" + Math.Round(job.SettleSec, 1) + "s");
        }

        // ------------------------------------------------------- attitude loop

        /// <summary>
        /// Is the gyro sign trusted enough for the FULL correction? Only after
        /// the sign test has decided AND the settle-in window has passed; a flip
        /// re-opens that window (the flip is evidence the sign was wrong).
        /// </summary>
        private bool FullGainAllowed(Job job)
        {
            return job.SignTested && _now >= job.SafeAttitudeUntil;
        }

        /// <summary>
        /// Add the descent's own roll/pitch rate damping to an attitude demand
        /// (defect c, 2026-11-11).
        ///
        /// `AttitudeRotation` already carries `-angularVelocity * 1.1`, but a
        /// single-gyro hull answered it with a residual ~1.5 deg/s that rode the
        /// whole descent (measured in the 2026-11-10 landings, and an 18 deg/s
        /// spike at 11.9 m aborted one). The demand is computed on the
        /// HORIZONTAL (roll/pitch) component of the measured rate only - yaw is
        /// not part of a landing and damping it would fight the settle - and it
        /// is added AFTER the level correction, so a tilt correction cannot
        /// swamp it. The gain/cap/deadband policy is LandMath.RateDampDemandRadS.
        /// </summary>
        private Vector3D RateDamped(Job job, Vector3D rot, Vector3D up, Vector3D ang)
        {
            var rateUp = Vector3D.Dot(ang, up);
            var horiz = ang - up * rateUp;
            var rate = horiz.Length();
            if (rate <= 1e-9) return rot;
            var axis = horiz / rate;
            var demand = LandMath.RateDampDemandRadS(rate, FullGainAllowed(job));
            if (demand == 0.0) return rot;
            job.RateDampRadS = demand;
            return rot + axis * demand;
        }

        /// <summary>
        /// Add the up-axis (yaw) rate damper to an attitude demand (2026-11-11
        /// spin). `RateDamped` damps roll/pitch only by design, so a landing hull
        /// could spin about its own up axis at 32 deg/s during a brake and trip
        /// the 10 deg/s descent abort with the gyro never asked to stop it.
        ///
        /// The term is a pure RATE term: it drives `omega . up` toward zero, never
        /// toward a heading. It is added among the tilt correction (never instead
        /// of it) and is fitted into the override budget the tilt correction
        /// leaves, so pitch/roll keep priority. It is commanded only when the sign
        /// test proved a yaw response (<see cref="Job.YawSignProven"/>) and the
        /// settle-in window has passed; otherwise it is zero - no guess, no spin.
        /// </summary>
        private Vector3D YawDamped(Job job, Vector3D rot, Vector3D up, Vector3D ang)
        {
            var rateUpDegS = Vector3D.Dot(ang, up) * 180.0 / Math.PI;
            var proven = job.YawSignProven && FullGainAllowed(job);
            var demand = LandMath.YawRateDampOverride(rateUpDegS, job.RatePerCommandDegS, proven);
            demand = LandMath.YawWithinAttitudeBudget(rot.Length(), demand);
            job.YawDampOverride = demand;
            if (demand == 0.0) return rot;
            return rot + up * demand;
        }

        /// <summary>
        /// HORIZONTAL POSITION HOLD (2026-11-11 set 3). `land_at` used to fly
        /// attitude only, so a residual horizontal velocity integrated for the
        /// whole descent: measured 176.4 m of drift from the ordered column on a
        /// 745 m drop (51.5 m on the short one). This adds a PD on the two
        /// TANGENTIAL axes toward the ordered column, as a tilt request in
        /// degrees, on top of the levelling demand.
        ///
        /// It is additive and bounded, never authoritative: the levelling
        /// demand keeps priority (`LandMath.LateralBudget` gives the hold only
        /// what is left of 7 deg), the per-band cap narrows to 2 deg below 15 m
        /// and to 0 at or below 6 m, and the total is clamped to the same 0.9
        /// override `AttitudeRotation` uses. The 35 deg abort and the 10 deg/s
        /// spin abort are untouched, so the hold only ever commands INSIDE the
        /// existing envelope.
        ///
        /// Every gate refuses with a REASON that reaches `land_status`: the
        /// phase (never fall/settle/safe-hover), the gyro sign proof, the
        /// lift-axis proof, the 1.2 lift ratio, the touchdown band. An unproven
        /// axis is not damped, guessed, or flown.
        /// </summary>
        private Vector3D HeldAttitude(
            Job job, Vector3D rot, double rotMag, Vector3D pos, Vector3D up,
            Vector3D vel, double vz, double mass, double g, double liftN)
        {
            job.LateralOffsetM = 0.0;
            job.LateralVelMps = 0.0;
            job.LateralTiltDeg = 0.0;
            job.LateralCapLastDeg = 0.0;

            if (!job.TargetSet || !LandMath.LateralHoldPhase(job.Phase))
            {
                job.LateralHold = "refused: phase is not brake or descending";
                return rot;
            }

            // Time inside the zero band, so "the last 2 s" is a fact and not a
            // guess about when contact will happen.
            var zeroAgl = job.FinalBandM > 0
                ? Math.Min(job.FinalBandM, LandMath.LateralZeroAglM)
                : LandMath.LateralZeroAglM;
            if (job.HullBottomAglM <= zeroAgl)
            {
                if (job.FinalBandSince < 0) job.FinalBandSince = _now;
            }
            else job.FinalBandSince = -1;
            var secInBand = job.FinalBandSince >= 0 ? _now - job.FinalBandSince : 0.0;

            var cap = LandMath.LateralCapDeg(job.HullBottomAglM, job.FinalBandM, secInBand);

            // The offset, projected onto the local horizontal plane. Nothing
            // vertical is ever asked of the hold: a bank that chases altitude
            // fights the sink schedule the descent is flying.
            var toTarget = job.TargetPos - pos;
            var offsetH = toTarget - up * Vector3D.Dot(toTarget, up);
            var offsetM = offsetH.Length();
            var velH = vel - up * vz;
            job.LateralVelMps = velH.Length();
            var dir = offsetH;
            if (offsetM < 0.5) dir = -velH;   // on the column: bleed the drift, do not orbit
            var dirLen = dir.Length();
            var side = Vector3D.Zero;
            if (dirLen > 1e-6)
            {
                dir /= dirLen;
                side = Vector3D.Cross(up, dir);
                if (side.LengthSquared() > 1e-9) side.Normalize();
                else side = Vector3D.Zero;
            }
            else dir = Vector3D.Zero;

            var weightN = mass * g;
            var liftRatio = weightN > 0 ? liftN / weightN : 0.0;
            // The gyro proof is the sign test AND the settle-in window: the same
            // gate the yaw damper and the full-gain attitude loop use, revoked
            // on any sign flip (LandMath.SignFlipDue).
            var gyroProven = job.YawSignProven && FullGainAllowed(job);
            var liftProven = LandMath.LiftAxisProven(liftN, weightN);
            var refusal = LandMath.LateralRefusal(
                job.Phase, gyroProven, liftProven, liftRatio, cap, job.SpinDegS);
            if (refusal == null && dir == Vector3D.Zero)
                refusal = "refused: on the column with no drift to bleed";
            if (refusal == null)
            {
                // What the levelling demand leaves of the 7 deg budget. If it is
                // all gone the hold simply does not fly this tick.
                var levelTiltDeg = rotMag / LandMath.AttitudeTiltGain * 180.0 / Math.PI;
                var capEff = LandMath.LateralBudget(levelTiltDeg, cap);
                job.LateralCapLastDeg = capEff;
                if (capEff <= 0.0) refusal = "refused: levelling has the whole attitude budget";
                else
                {
                    var tx = LandMath.LateralTiltDeg(
                        Vector3D.Dot(offsetH, dir), Vector3D.Dot(velH, dir), capEff);
                    var ty = LandMath.LateralTiltDeg(
                        Vector3D.Dot(offsetH, side), Vector3D.Dot(velH, side), capEff);
                    LandMath.ClampLateralDeg(ref tx, ref ty, capEff);
                    var tiltVec = dir * tx + side * ty;
                    job.LateralTiltDeg = tiltVec.Length();
                    job.LateralHold = null;
                    // Rotating `up` toward the requested tilt direction is a
                    // rotation about `up x tiltVec` by its magnitude; expressed
                    // in the same override units AttitudeRotation returns.
                    var delta = Vector3D.Cross(up, tiltVec) * LandMath.TiltToRotationOverride(1.0);
                    var total = rot + delta;
                    var totalMag = total.Length();
                    if (totalMag > LandMath.AttitudeOverrideCap)
                        total *= LandMath.AttitudeOverrideCap / totalMag;
                    return total;
                }
            }

            job.LateralCapLastDeg = job.LateralCapLastDeg > 0 ? job.LateralCapLastDeg : cap;
            job.LateralHold = refusal;
            return rot;
        }

        /// <summary>
        /// Send an attitude correction (world frame rotation demand). The sign,
        /// the gain scale and the per-tick acceleration ramp are applied HERE, so
        /// no call site can apply a full-gain correction on an unproven sign.
        /// </summary>
        private void ApplyAttitude(Job job, IMyCubeGrid grid, Vector3D rot)
        {
            var scale = LandMath.AttitudeGainScale(FullGainAllowed(job));
            ApplyRaw(job, grid, rot * (job.GyroSign * scale));
        }

        /// <summary>
        /// Send a raw world-frame rotation demand through the acceleration ramp:
        /// the command may move by at most
        /// <see cref="LandMath.MaxCommandDeltaPerTick"/> per tick. While the sign
        /// is unproven the cap is 2 deg/s^2 — a wrong-sign tick then cannot do
        /// more than nudge the hull, and the flip rule catches it.
        /// </summary>
        private void ApplyRaw(Job job, IMyCubeGrid grid, Vector3D desired)
        {
            var cap = FullGainAllowed(job)
                ? LandMath.ProvenSignAngularAccelDegS2
                : LandMath.UnprovenSignAngularAccelDegS2;
            var maxStep = LandMath.MaxCommandDeltaPerTick(cap, TickIntervalSec, job.RatePerCommandDegS);
            var delta = desired - job.LastGyroCmd;
            if (maxStep > 0 && delta.Length() > maxStep)
                desired = job.LastGyroCmd + delta * (maxStep / delta.Length());
            job.LastGyroCmd = desired;
            LevelFlightController.Instance.ApplyGyro(grid, desired);
        }


        // ----------------------------------------------------------- safe hover

        /// <summary>
        /// THE SAFE ABORT HOLD. Every abort lands here instead of letting go:
        /// gyro holding level, lift bank at the weight command (plus a vertical
        /// speed damper), dampeners ON. The overrides are released only after
        /// 2 s of |v| &lt;= 0.5 m/s and tilt &lt; 5 deg, or on the ground.
        /// </summary>
        private void Hold(
            Job job, IMyCubeGrid grid, Vector3D up, double g, double mass, double liftN,
            Vector3D vel, Vector3D ang, MatrixD matrix, double tilt, bool hasPlanet)
        {
            if (job.HoverStartedAt < 0) job.HoverStartedAt = _now;
            job.HoverSec = _now - job.HoverStartedAt;

            var manual = UnderControl(grid);
            if (manual != null) { Release(job, "manual control during the abort hold: " + manual); return; }

            var vz = Vector3D.Dot(vel, up);
            var aUp = LandMath.HoverAccel(vz, g, LandMath.SafeHoverGain, job.HoverUpAccelG);
            var thrustN = LandMath.LiftThrustN(mass, g, aUp, liftN);
            job.ThrustN = thrustN;
            job.ThrustFraction = LandMath.ThrustFraction(mass, g, aUp, liftN);
            job.HoverThrustFraction = LandMath.HoverFraction(mass, g, liftN);

            var velH = vel - up * vz;
            var aH = Lateral(velH, g);

            double rotMag;
            var rot = LevelFlightController.AttitudeRotation(matrix, up, ang, out rotMag);
            LearnSign(job, tilt, rotMag);
            ApplyAttitude(job, grid, YawDamped(job, rot, up, ang));
            var forceWorld = up * thrustN + aH * mass;
            LevelFlightController.Instance.ApplyThrust(grid, Vector3D.TransformNormal(forceWorld, MatrixD.Transpose(matrix)));
            LevelFlightController.SetDampeners(grid, true);

            // --- release gates -------------------------------------------------
            var speed = vel.Length();
            var calm = LandMath.SafeToRelease(speed, tilt);
            if (calm)
            {
                if (job.CalmSince < 0) job.CalmSince = _now;
            }
            else job.CalmSince = -1;

            var onGround = hasPlanet && !double.IsNaN(job.HullBottomAglM) &&
                           job.HullBottomAglM <= LandMath.SafeHoverGroundAglM;
            if (onGround)
            {
                Release(job, "safe abort on the ground (" + Math.Round(job.HullBottomAglM, 2) +
                    " m hull-bottom AGL): " + job.AbortReason);
                return;
            }
            if (job.CalmSince >= 0 && _now - job.CalmSince >= LandMath.SafeHoverCalmSec)
            {
                Release(job, "safe abort released after " + Math.Round(_now - job.CalmSince, 1) +
                    " s level (tilt " + Math.Round(tilt, 1) + " deg) and still (" + Math.Round(speed, 2) +
                    " m/s): " + job.AbortReason);
                return;
            }

            if (_now - job.LastLogAt > LogIntervalSec)
            {
                job.LastLogAt = _now;
                Log("info", "land HOVER grid:" + job.GridId + " agl=" + Math.Round(job.HullBottomAglM, 1) +
                    " v=" + Math.Round(vz, 2) + " speed=" + Math.Round(speed, 2) +
                    " tilt=" + Math.Round(tilt, 1) + " spin=" + Math.Round(job.SpinDegS, 2) +
                    " thrust=" + Math.Round(job.ThrustFraction * 100) + "% (hover " +
                    Math.Round(job.HoverThrustFraction * 100) + "%) holding for " +
                    Math.Round(job.HoverSec, 1) + " s: " + job.AbortReason);
            }
        }

        private static Vector3D Lateral(Vector3D velH, double g)
        {
            var aH = -velH * LateralGain;
            var aHmag = aH.Length();
            var aHcap = MaxLateralAccelG * g;
            if (aHmag > aHcap && aHmag > 0) aH *= aHcap / aHmag;
            return aH;
        }

        /// <summary>
        /// Sign learning in ONE place: tilt growing by 0.3 deg inside a rolling
        /// 1 s window while a correction is commanded proves the gyro is pushing
        /// the wrong way, so flip immediately. (The old rule needed a slow
        /// +0.02 deg per tick and ~1 s to arm; a hostile hull outran it.)
        ///
        /// MORE THAN ONE FLIP IS ALLOWED. The old rule gave up after the first
        /// flip, and the in-game run that needed the second one had no recourse.
        /// Every flip re-opens the settle-in window, so the freshly flipped sign
        /// is flown at 10 % gain and under the 2 deg/s^2 ramp until it proves
        /// itself; a flip that was itself wrong therefore cannot hurt the hull.
        /// The cooldown keeps a hull that is merely oscillating from flapping the
        /// sign every tick.
        /// </summary>
        private void LearnSign(Job job, double tilt, double rotMag)
        {
            if (!(rotMag > 0.02)) { job.TiltRefAt = -1; return; }
            if (job.TiltRefAt < 0) { job.TiltRef = tilt; job.TiltRefAt = _now; return; }
            var window = _now - job.TiltRefAt;
            if (tilt < job.TiltRef - 0.02)
            {
                // responding the right way: restart the window from this low
                job.TiltRef = tilt;
                job.TiltRefAt = _now;
                return;
            }
            if (job.SignFlips > 0 && _now - job.LastSignFlipAt < LandMath.SignFlipCooldownSec)
            {
                if (window > LandMath.SignFlipWindowSec) { job.TiltRef = tilt; job.TiltRefAt = _now; }
                return;
            }
            if (LandMath.SignFlipDue(tilt, job.TiltRef, window, rotMag))
            {
                job.SignFlips++;
                job.GyroSign = -job.GyroSign;
                job.LastSignFlipAt = _now;
                // A flip means the sign we trusted was wrong. The yaw damper was
                // enabled on exactly that evidence, so it goes off and STAYS off:
                // re-proving it would mean another yaw pulse mid-descent, and a
                // wrong yaw sign is the one error that makes a spin worse. No
                // evidence, no yaw damping.
                job.YawSignProven = false;
                job.YawDampOverride = 0.0;
                // A flip says the sign we were trusting was wrong: drop straight
                // back to 10 % gain and the 2 deg/s^2 cap for one second.
                job.SafeAttitudeUntil = _now + LandMath.SignSettleInSec;
                job.LastGyroCmd = Vector3D.Zero;
                job.TiltRef = tilt;
                job.TiltRefAt = _now;
                Log("warn", "land gyro sign flipped to " + job.GyroSign + " (flip " + job.SignFlips +
                    "; tilt grew to " + Math.Round(tilt, 1) + " deg in " + Math.Round(window, 2) +
                    " s while correcting): 10 % gain and the 2 deg/s2 ramp re-armed for " +
                    LandMath.SignSettleInSec + " s");
                return;
            }
            if (window > LandMath.SignFlipWindowSec) { job.TiltRef = tilt; job.TiltRefAt = _now; }
        }

        // ------------------------------------------------------------- endings

        /// <summary>Put the job into the safe hover. NOTHING is released here.</summary>
        private void EnterSafeHover(Job job, string reason)
        {
            if (job.Phase == "safe-hover") return;
            job.Phase = "safe-hover";
            job.AbortReason = reason;
            job.Reason = "SAFE ABORT: " + reason;
            job.HoverStartedAt = _now;
            job.HoverSec = 0;
            job.CalmSince = -1;
            job.HoverSpeedAtAbort = CurrentSpeed(job);
            job.HoverTiltAtAbort = job.TiltDeg;
            job.HoverUpAccelG = Math.Abs(job.VerticalSpeedMps) > 3.0
                ? LandMath.BrakeAuthorityG
                : LandMath.SafeHoverUpAccelG;
            job.LastLogAt = -LogIntervalSec;   // log the first hover tick at once

            var grid = FindGrid(job.GridId);
            try { LevelFlightController.SetDampeners(grid, true); } catch { }
            Log("warn", "land SAFE ABORT grid:" + job.GridId + " at " + Math.Round(job.HullBottomAglM, 1) +
                " m hull-bottom AGL, v " + Math.Round(job.VerticalSpeedMps, 2) + " m/s, tilt " +
                Math.Round(job.TiltDeg, 1) + " deg, spin " + Math.Round(job.SpinDegS, 2) + " deg/s: " + reason +
                " -> holding hover (thrust " + Math.Round(LandMath.HoverFraction(
                    GridMass(grid), GridGravityMs2(grid), job.LiftCapacityN) * 100) +
                "% of lift), gyro holding level, dampeners on; overrides released only when level and still");
            // Fly the hover on THIS tick too: no tick of free fall between the
            // abort and the first hold command.
            try
            {
                if (grid != null && grid.Physics != null)
                {
                    var pos = grid.PositionComp.GetPosition();
                    float ig;
                    var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out ig);
                    var g = (double)gravity.Length();
                    var up = g > LevelMath.MinGravityMs2
                        ? new Vector3D(-gravity.X / g, -gravity.Y / g, -gravity.Z / g)
                        : Vector3D.UnitY;
                    var vel = (Vector3D)grid.Physics.LinearVelocity;
                    var ang = (Vector3D)grid.Physics.AngularVelocity;
                    var matrix = grid.WorldMatrix;
                    var tilt = LevelMath.TiltDeg(Vector3D.Dot(matrix.Up, up));
                    bool hasPlanet;
                    Vector3D centre;
                    string planetName;
                    hasPlanet = PlanetUnder(pos, out centre, out planetName);
                    Hold(job, grid, up, g, (double)grid.Physics.Mass, job.LiftCapacityN,
                        vel, ang, matrix, tilt, hasPlanet);
                }
            }
            catch (Exception ex) { Log("warn", "safe hover first tick failed: " + ex.Message); }
        }

        /// <summary>An abort of the DESCENT: always into the hover, never a release.</summary>
        private void Abort(Job job, string reason)
        {
            if (job.Phase == "safe-hover")
            {
                job.AbortReason = reason;
                return;
            }
            Log("warn", "land job aborted grid:" + job.GridId + ": " + reason);
            EnterSafeHover(job, reason);
        }

        /// <summary>Grid/body gone: there is nothing left to hold.</summary>
        private void Lost(Job job, string reason)
        {
            job.Phase = "aborted";
            job.Reason = reason + " (nothing left to hold)";
            job.AbortReason = reason;
            job.EndedAt = _now;
            job.ElapsedSec = _now - job.StartedAt;
            Log("warn", "land job lost grid:" + job.GridId + ": " + job.Reason);
        }

        /// <summary>Hand the overrides back. Only called when it is safe to.</summary>
        private void Release(Job job, string reason)
        {
            job.Phase = "aborted";
            job.Reason = reason;
            job.AbortReason = job.AbortReason.Length > 0 ? job.AbortReason : reason;
            job.EndedAt = _now;
            job.ElapsedSec = _now - job.StartedAt;
            var grid = FindGrid(job.GridId);
            try { LevelFlightController.Instance.ReleaseOverrides(grid); } catch { }
            try { LevelFlightController.SetDampeners(grid, true); } catch { }
            try { LevelFlightController.AutopilotOff(grid); } catch { }
            Log("info", "land aborted grid:" + job.GridId + " after " + Math.Round(job.ElapsedSec, 1) +
                " s: " + reason + " (overrides cleared, dampeners on)");
        }

        /// <summary>A real landing: overrides cleared, dampeners on, job kept for `land_status`.</summary>
        private void End(Job job, string phase, string reason)
        {
            job.Phase = phase;
            job.Reason = reason;
            job.EndedAt = _now;
            job.ElapsedSec = _now - job.StartedAt;
            var grid = FindGrid(job.GridId);
            try { LevelFlightController.Instance.ReleaseOverrides(grid); } catch { }
            try { LevelFlightController.SetDampeners(grid, true); } catch { }
            try { LevelFlightController.AutopilotOff(grid); } catch { }
            Log("info", "land " + phase + " grid:" + job.GridId + " after " + Math.Round(job.ElapsedSec, 1) +
                " s: " + reason + " (overrides cleared, dampeners on)");
        }

        private double CurrentSpeed(Job job)
        {
            var grid = FindGrid(job.GridId);
            if (grid == null || grid.Physics == null) return double.NaN;
            return ((Vector3D)grid.Physics.LinearVelocity).Length();
        }

        private static double GridMass(IMyCubeGrid grid)
        {
            return grid != null && grid.Physics != null ? (double)grid.Physics.Mass : 0.0;
        }

        private static double GridGravityMs2(IMyCubeGrid grid)
        {
            try
            {
                if (grid == null || grid.PositionComp == null) return 0.0;
                float ig;
                var gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(grid.PositionComp.GetPosition(), out ig);
                return (double)gravity.Length();
            }
            catch { return 0.0; }
        }

        private JObject Refusal(long gridId, string reason)
        {
            Log("warn", "land start refused grid:" + gridId + ": " + reason);
            return new JObject
            {
                ["gridId"] = "grid:" + gridId,
                ["started"] = false,
                ["refused"] = reason,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }

        private JObject Status(Job job)
        {
            var row = new JObject
            {
                ["gridId"] = "grid:" + job.GridId,
                ["active"] = job.Phase == "settling" || job.Phase == "fall" || job.Phase == "brake" ||
                             job.Phase == "descending" || job.Phase == "safe-hover",
                ["phase"] = job.Phase,
                ["carryingPassengers"] = job.CarryingPassengers,
                ["passengers"] = job.PassengerNote,
                ["reason"] = job.Reason,
                ["abortReason"] = job.AbortReason,
                ["hullBottomAglM"] = Math.Round(job.HullBottomAglM, 2),
                ["positionAglM"] = Math.Round(job.PositionAglM, 2),
                ["verticalSpeedMps"] = Math.Round(job.VerticalSpeedMps, 3),
                ["sinkTargetMps"] = Math.Round(job.SinkTargetMps, 3),
                ["thrustFraction"] = Math.Round(job.ThrustFraction, 4),
                ["hoverThrustFraction"] = Math.Round(job.HoverThrustFraction, 4),
                ["thrustN"] = Math.Round(job.ThrustN, 0),
                ["liftCapacityN"] = Math.Round(job.LiftCapacityN, 0),
                ["tiltDeg"] = Math.Round(job.TiltDeg, 2),
                ["peakTiltDeg"] = Math.Round(job.PeakTiltDeg, 2),
                ["spinDegS"] = Math.Round(job.SpinDegS, 3),
                ["settled"] = job.Settled,
                ["settleSec"] = Math.Round(job.SettleSec, 2),
                ["signTested"] = job.SignTested,
                ["signTestRateDegS"] = Math.Round(job.SignTestRateDegS, 3),
                ["signTestAttempts"] = job.SignTestAttempt + 1,
                ["ratePerCommandDegS"] = Math.Round(job.RatePerCommandDegS, 1),
                ["fullGain"] = FullGainAllowed(job),
                ["safeHoverSec"] = Math.Round(job.HoverSec, 2),
                ["safeHoverSpeedAtAbortMps"] = Math.Round(job.HoverSpeedAtAbort, 3),
                ["safeHoverTiltAtAbortDeg"] = Math.Round(job.HoverTiltAtAbort, 2),
                ["safeHoverCalmSec"] = job.CalmSince >= 0 ? Math.Round(_now - job.CalmSince, 2) : 0,
                ["sinkMps"] = job.SinkMps,
                ["finalSinkMps"] = job.FinalSinkMps,
                ["finalBandM"] = job.FinalBandM,
                ["maxFallMps"] = job.MaxFallMps,
                ["brakeAglM"] = Math.Round(job.BrakeAglM, 1),
                ["aBrakeMs2"] = Math.Round(job.ABrakeMs2, 2),
                ["brakeStartAglM"] = double.IsNaN(job.BrakeStartAglM) ? 0 : Math.Round(job.BrakeStartAglM, 1),
                ["brakeStartMps"] = double.IsNaN(job.BrakeStartMps) ? 0 : Math.Round(job.BrakeStartMps, 2),
                ["fallSec"] = Math.Round(job.FallSec, 2),
                ["brakeSec"] = Math.Round(job.BrakeSec, 2),
                ["fallCapHeld"] = job.FallCapHeld,
                ["groundRadiusM"] = Math.Round(job.GroundRadiusM, 1),
                ["keelDepthM"] = Math.Round(job.KeelDepthM, 2),
                ["liveKeelM"] = Math.Round(job.LiveKeelM, 2),
                ["controlKeelM"] = Math.Round(job.ControlKeelM, 2),
                ["groundSource"] = job.GroundSource,
                ["maxSinkSeenMps"] = Math.Round(job.MaxSinkSeenMps, 2),
                ["elapsedSec"] = Math.Round(job.ElapsedSec, 2),
                ["gyroSign"] = job.GyroSign,
                ["signFlips"] = job.SignFlips,
                ["groundUpdates"] = job.GroundUpdates,
                ["groundUpdateAgoSec"] = job.LastGroundUpdateAt >= 0 ? Math.Round(_now - job.LastGroundUpdateAt, 1) : -1,
                ["lastGroundDeltaM"] = Math.Round(job.LastGroundDeltaM, 2),
                ["rateDampRadS"] = Math.Round(job.RateDampRadS, 4),
                ["yawDampOverride"] = Math.Round(job.YawDampOverride, 3),
                ["yawSignProven"] = job.YawSignProven,
                ["lateralOffsetM"] = Math.Round(job.LateralOffsetM, 1),
                ["lateralSpeedMps"] = Math.Round(job.LateralVelMps, 2),
                ["lateralCapDeg"] = Math.Round(job.LateralCapLastDeg, 2),
                ["lateralTiltDeg"] = Math.Round(job.LateralTiltDeg, 2),
                ["lateralHold"] = job.LateralHold ?? "on",
                ["holdTargetSource"] = job.TargetSource,
                ["holdTargetFromHandoverM"] = double.IsNaN(job.TargetOffsetFromHandoverM)
                    ? 0
                    : Math.Round(job.TargetOffsetFromHandoverM, 1),
            };
            if (job.TargetRefused != null) row["holdTargetRefusal"] = job.TargetRefused;
            if (job.GroundUpdateRefusal != null) row["groundUpdateRefusal"] = job.GroundUpdateRefusal;
            if (job.MinAglSeenM < double.MaxValue) row["minAglM"] = Math.Round(job.MinAglSeenM, 2);
            if (job.LosAglM.HasValue) row["losAglM"] = Math.Round(job.LosAglM.Value, 2);
            return row;
        }

        // ------------------------------------------------------------- helpers

        /// <summary>
        /// TRUE signed pivot -> lowest-hull-point distance along
        /// <paramref name="up"/>, m: positive when the hull extends BELOW the
        /// pivot. Returns <see cref="double.NaN"/> for a degenerate AABB.
        ///
        /// This is NOT `GridGeometry.KeelDepthM`. Measured in game 2026-11-10:
        /// SAT-R-0001's AABB is local Y 8.75 .. 18.75 (the whole hull sits
        /// above the pivot), so the lowest block is 8.75 m above the pivot,
        /// while `KeelDepthM` reported -18.75 — it keeps the corner with the
        /// SMALLEST "below the pivot" value, i.e. the hull's TOP/roof, and the
        /// `hullBottom` it returns is the roof corner (18.74 m up). Flying the
        /// last 150 m on the order's keel would put the belly ~10 m inside the
        /// ground before the touchdown rule fired, so the controller measures
        /// the belly itself and reports the order's value next to it.
        /// </summary>
        private static double TrueKeelM(IMyCubeGrid grid, Vector3D up)
        {
            if (grid == null || grid.PositionComp == null) return double.NaN;
            var box = grid.PositionComp.LocalAABB;
            if (!(box.Max.X > box.Min.X) && !(box.Max.Y > box.Min.Y) && !(box.Max.Z > box.Min.Z))
                return double.NaN;
            var pos = grid.PositionComp.GetPosition();
            var matrix = grid.PositionComp.WorldMatrixRef;
            double lowest = double.MinValue;   // most positive "metres below the pivot"
            for (int i = 0; i < 8; i++)
            {
                var local = new Vector3(
                    (i & 1) == 0 ? box.Min.X : box.Max.X,
                    (i & 2) == 0 ? box.Min.Y : box.Max.Y,
                    (i & 4) == 0 ? box.Min.Z : box.Max.Z);
                var world = Vector3D.Transform(local, matrix);
                var below = -Vector3D.Dot(world - pos, up);   // metres below the pivot
                if (below > lowest) lowest = below;
            }
            return lowest == double.MinValue ? double.NaN : lowest;
        }

        /// <summary>
        /// The planet whose centre is nearest to <paramref name="pos"/>. The
        /// landing order carries the ground RADIUS but not the centre, and
        /// hull-bottom AGL is measured from the centre.
        /// </summary>
        private static bool PlanetUnder(Vector3D pos, out Vector3D centre, out string name)
        {
            centre = Vector3D.Zero;
            name = null;
            var best = double.MaxValue;
            try
            {
                foreach (var entity in MyEntities.GetEntities())
                {
                    var planet = entity as MyPlanet;
                    if (planet == null || planet.Closed || planet.PositionComp == null) continue;
                    var c = planet.PositionComp.GetPosition();
                    var d = (pos - c).Length();
                    if (d >= best) continue;
                    best = d;
                    centre = c;
                    try { name = planet.StorageName ?? planet.DisplayName; } catch { name = "planet"; }
                }
            }
            catch { return false; }
            return best < double.MaxValue;
        }

        /// <summary>
        /// T61: only a REAL pilot stops a landing job. An occupied passenger
        /// seat (CanControlShip false) is not a pilot.
        /// </summary>
        private static string UnderControl(IMyCubeGrid grid)
        {
            if (grid == null) return null;
            var pilot = ControlReport.Classify(grid, null).Pilot;
            if (pilot == null) return null;
            var seat = string.IsNullOrEmpty(pilot.Seat) ? "controller" : pilot.Seat;
            return seat + " (" + (string.IsNullOrEmpty(pilot.ControllerType) ? "controller" : pilot.ControllerType) + ")";
        }

        private static IMyCubeGrid FindGrid(long id)
        {
            IMyEntity ent;
            if (!MyAPIGateway.Entities.TryGetEntityById(id, out ent)) return null;
            return ent as IMyCubeGrid;
        }

        private void Log(string level, string message)
        {
            try { _log(level, "land: " + message); } catch { }
        }
    }
}
