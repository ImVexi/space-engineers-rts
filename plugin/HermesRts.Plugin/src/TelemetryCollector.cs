using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Builds telemetry for grids owned by our faction/owners only. No enemy
    /// data is produced here: contacts must come from sensors/cameras (the
    /// detection gate is not implemented in this skeleton).
    /// </summary>
    public sealed class TelemetryCollector
    {
        private readonly ILoaderAdapter _loader;
        private readonly PluginConfig _config;

        public TelemetryCollector(ILoaderAdapter loader, PluginConfig config)
        {
            _loader = loader;
            _config = config;
        }

        public JObject Collect(long tick)
        {
            var grids = new JArray();
            // T61: one player scan for the whole frame: the passenger rule needs
            // identity names and who is seated where, and doing it per grid would
            // walk the player list once per grid.
            var presence = ControlReport.ScanPlayers(null);
            foreach (var grid in _loader.GetGrids())
            {
                if (grid == null || grid.Closed) continue;
                if (!IsOwned(grid)) continue;
                var entry = ToJson(grid, presence);
                if (entry != null) grids.Add(entry);
            }

            var frame = new JObject
            {
                ["schemaVersion"] = 1,
                ["type"] = "telemetry",
                ["tick"] = tick,
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["grids"] = grids,
                // T61: online characters, same cadence as the grid sample.
                ["players"] = PlayersJson(),
                ["contacts"] = new JArray(),
                ["links"] = new JArray(),
                ["ledgerDelta"] = new JArray(),
            };

            // Sun direction: MySector.DirectionToSunNormalized is the engine value
            // (unit vector, world space). Read on the game thread; if the build
            // did not expose it, say so instead of guessing a direction.
            try
            {
                var d = Sandbox.Game.World.MySector.DirectionToSunNormalized;
                frame["sun"] = new JObject { ["x"] = Math.Round(d.X, 6), ["y"] = Math.Round(d.Y, 6), ["z"] = Math.Round(d.Z, 6) };
                frame["sunState"] = "readable";
            }
            catch (Exception ex)
            {
                frame["sunState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }
            frame["playersState"] = LastPlayersState;
            // T79: the backend's SimSpeed fallback reads this on the live server
            // (RemoteApiEnabled=false). A failed read says so, never a fake 1.0.
            frame["simRatio"] = SimRatioRead.Read();
            return frame;
        }

        /// <summary>
        /// T61 online characters. A read failure yields an empty array with the
        /// reason set, never invented players: `playersState` says which.
        /// </summary>
        private JArray PlayersJson()
        {
            try
            {
                var rows = PlayerRead.CollectJson(null);
                _lastPlayersState = "readable";
                return rows;
            }
            catch (Exception ex)
            {
                _lastPlayersState = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
                return new JArray();
            }
        }

        /// <summary>`readable` when the last player sample succeeded.</summary>
        public string LastPlayersState { get { return _lastPlayersState ?? "readable"; } }

        private string _lastPlayersState;

        /// <summary>
        /// Ownership is explicit: configured Steam IDs and/or faction tag. With
        /// neither configured this returns false for every grid (fail closed).
        /// </summary>
        private bool IsOwned(IMyCubeGrid grid)
        {
            return Ownership.IsOwned(grid, _config);
        }

        private JObject ToJson(IMyCubeGrid grid, IList<ControlReport.Presence> presence)
        {
            var pos = grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero;
            Vector3 velocity = Vector3.Zero;
            float mass = 0f;
            if (grid.Physics != null)
            {
                velocity = grid.Physics.LinearVelocity;
                mass = grid.Physics.Mass;
            }

            var entry = new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["pos"] = Vec(pos.X, pos.Y, pos.Z),
                ["vel"] = Vec(velocity.X, velocity.Y, velocity.Z),
                ["massKg"] = mass,
                ["link"] = LinkState(grid),
            };

            // MEASURED ATTITUDE RATE (2026-11-11 flight set 6). The backend
            // holds a hull between the lateral leg and the `land_at` handover
            // until its angular rate is damped, and `land_at` refuses a start
            // on the same number. Without this field the backend has no rate to
            // wait on and can only guess with a timer. Same sample the plugin's
            // own `StartRefusal` uses (`angularVelocity.Length()` in deg/s).
            try
            {
                if (grid.Physics != null)
                {
                    var omega = (Vector3D)grid.Physics.AngularVelocity;
                    entry["angularVelocity"] = Vec(omega.X, omega.Y, omega.Z);
                    entry["spinDegS"] = Math.Round(omega.Length() * 180.0 / Math.PI, 3);
                }
            }
            catch (Exception ex)
            {
                entry["spinState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }

            // Hull geometry for every ground computation: the reported position
            // is the PIVOT, which can sit above or below the block envelope, so
            // AGL measured from it is not the hull's clearance. Signed metres
            // from the pivot to the lowest hull point along local down
            // (negative = the pivot is below the hull, measured on SAT-R-0001).
            try
            {
                Vector3D up, bottom;
                var keel = GridGeometry.KeelDepthM(grid, out up, out bottom);
                entry["keelDepthM"] = Math.Round(keel, 2);
                entry["hullUp"] = Vec(up.X, up.Y, up.Z);
                entry["hullBottom"] = Vec(bottom.X, bottom.Y, bottom.Z);
                entry["keelSource"] = "local-aabb";
            }
            catch (Exception ex)
            {
                entry["keelState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }

            // Live attitude. The save-quaternion fallback is stale between
            // autosaves, so the map/camera read this instead: the grid's real
            // world matrix, sampled every telemetry frame.
            try
            {
                var matrix = grid.PositionComp != null ? grid.PositionComp.WorldMatrixRef : MatrixD.Identity;
                var q = QuaternionD.CreateFromRotationMatrix(matrix);
                entry["rot"] = new JObject
                {
                    ["x"] = Math.Round(q.X, 7),
                    ["y"] = Math.Round(q.Y, 7),
                    ["z"] = Math.Round(q.Z, 7),
                    ["w"] = Math.Round(q.W, 7),
                };
                entry["forward"] = Vec(matrix.Forward.X, matrix.Forward.Y, matrix.Forward.Z);
                entry["up"] = Vec(matrix.Up.X, matrix.Up.Y, matrix.Up.Z);
                entry["right"] = Vec(matrix.Right.X, matrix.Right.Y, matrix.Right.Z);
            }
            catch (Exception ex)
            {
                entry["rotState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }

            // T61 passenger rule: pilot vs passengers vs a player standing inside
            // the hull. `underControl` here is PILOT ONLY (compatibility field);
            // the backend stops sending orders only for a pilot.
            try
            {
                entry["control"] = ControlReport.Classify(grid, presence).ToJson();
            }
            catch (Exception ex)
            {
                entry["controlState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }

            double power = PowerFraction(grid);
            if (power >= 0) entry["powerFraction"] = power;

            double fuel = FuelFraction(grid);
            if (fuel >= 0) entry["fuelFraction"] = fuel;

            // Explicit percentages for the demo/naming readout, same samples as
            // the fractions above (no second source, no estimate).
            if (power >= 0) entry["batteryPct"] = Math.Round(power * 100.0, 1);
            if (fuel >= 0) entry["h2Pct"] = Math.Round(fuel * 100.0, 1);

            double solarMax;
            double solarNow = SolarOutputMw(grid, out solarMax);
            entry["solarOutputMw"] = Math.Round(solarNow, 3);
            entry["solarMaxMw"] = Math.Round(solarMax, 3);

            return entry;
        }

        /// <summary>
        /// Current solar output: ratio reported by the panel times the panel
        /// component's MaxOutput. Both come from the live block; a grid without
        /// panels reports 0.
        /// </summary>
        private static double SolarOutputMw(IMyCubeGrid grid, out double maxMw)
        {
            double now = 0;
            maxMw = 0;
            foreach (var panel in grid.GetFatBlocks<SpaceEngineers.Game.Entities.Blocks.MySolarPanel>())
            {
                if (panel == null) continue;
                try
                {
                    var comp = panel.SolarComponent;
                    if (comp == null) continue;
                    maxMw += comp.MaxOutput;
                    // CurrentProductionRatio is not public on the concrete block in
                    // 01_210_014; read the same live value reflectively (read-only).
                    var prop = panel.GetType().GetProperty("CurrentProductionRatio",
                        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
                    if (prop != null)
                        now += Convert.ToDouble(prop.GetValue(panel, null)) * comp.MaxOutput;
                }
                catch { /* panel without a live component: contributes nothing */ }
            }
            return now;
        }

        private static JObject Vec(double x, double y, double z)
        {
            return new JObject { ["x"] = x, ["y"] = y, ["z"] = z };
        }

        /// <summary>Stored power / capacity across batteries; -1 when there are none.</summary>
        private static double PowerFraction(IMyCubeGrid grid)
        {
            double stored = 0, capacity = 0;
            // VERIFY: GetFatBlocks<T>() availability in the plugin build.
            foreach (var battery in grid.GetFatBlocks<IMyBatteryBlock>())
            {
                if (battery == null) continue;
                stored += battery.CurrentStoredPower;
                capacity += battery.MaxStoredPower;
            }
            if (capacity <= 0) return -1;
            return Math.Max(0, Math.Min(1, stored / capacity));
        }

        /// <summary>Capacity-weighted hydrogen fill; -1 when there are no tanks.</summary>
        private static double FuelFraction(IMyCubeGrid grid)
        {
            double filled = 0, capacity = 0;
            foreach (var tank in grid.GetFatBlocks<IMyGasTank>())
            {
                if (tank == null || tank.Capacity <= 0) continue;
                filled += tank.FilledRatio * tank.Capacity;
                capacity += tank.Capacity;
            }
            if (capacity <= 0) return -1;
            return Math.Max(0, Math.Min(1, filled / capacity));
        }

        /// <summary>
        /// Local link hint only. A real comms graph is backend work (P5).
        /// VERIFY: antenna broadcasting + powered is a coarse proxy.
        /// </summary>
        private static string LinkState(IMyCubeGrid grid)
        {
            var sawAntenna = false;
            foreach (var antenna in grid.GetFatBlocks<IMyRadioAntenna>())
            {
                if (antenna == null) continue;
                sawAntenna = true;
                if (antenna.Enabled && antenna.IsWorking) return "up";
            }
            return sawAntenna ? "down" : "unknown";
        }
    }
}
