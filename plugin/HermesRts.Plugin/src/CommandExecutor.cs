using System;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using Sandbox.ModAPI.Ingame;
using VRageMath;
// Reflected 01_210_014: the block object implements the Sandbox.ModAPI
// interfaces; the Ingame.* ones are the script-safe twins. Disambiguate.
using IMyRemoteControl = Sandbox.ModAPI.IMyRemoteControl;
using IMyShipConnector = Sandbox.ModAPI.IMyShipConnector;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Executes PAM-like orders against a grid's remote control. Every method
    /// is gated by the command_execution flag and by safe mode. Nothing here is
    /// verified against a running server.
    /// </summary>
    public sealed class CommandExecutor
    {
        private readonly ILoaderAdapter _loader;
        private readonly FeatureFlags _flags;
        private readonly SafeMode _safeMode;
        private readonly Action<string, string> _log;

        public CommandExecutor(ILoaderAdapter loader, FeatureFlags flags, SafeMode safeMode, Action<string, string> log)
        {
            _loader = loader;
            _flags = flags;
            _safeMode = safeMode;
            _log = log;
        }

        /// <summary>Returns true on accepted order; on false, error explains why.</summary>
        public bool Execute(JObject order, out string error)
        {
            error = null;
            if (!_flags.CommandExecution)
            {
                error = "command_execution is disabled";
                return false;
            }
            if (_safeMode.Active)
            {
                error = "safe mode active";
                return false;
            }

            var orderType = (string)order["orderType"];
            var entity = (string)order["entityId"];
            if (string.IsNullOrEmpty(entity))
            {
                error = "missing entityId";
                return false;
            }

            long entityId;
            if (!long.TryParse(entity.Replace("grid:", ""), out entityId))
            {
                error = "entityId is not a grid id: " + entity;
                return false;
            }

            var grid = _loader.GetGridById(entityId);
            if (grid == null)
            {
                error = "grid not found: " + entity;
                return false;
            }

            var prm = order["params"] as JObject ?? new JObject();

            switch (orderType)
            {
                case "move":
                case "waypoint":
                case "drive":
                    return Move(grid, prm, out error);
                case "hold":
                    return Hold(grid, prm, out error);
                case "stop":
                    return Stop(grid, out error);
                case "dock":
                    return SetConnector(grid, prm, true, out error);
                case "undock":
                    return SetConnector(grid, prm, false, out error);
                default:
                    error = "unsupported orderType: " + orderType;
                    return false;
            }
        }

        private bool Move(VRage.Game.ModAPI.IMyCubeGrid grid, JObject prm, out string error)
        {
            error = null;
            var rc = FirstRemoteControl(grid);
            if (rc == null)
            {
                error = "no functional remote control";
                return false;
            }

            Vector3D target;
            if (!TryTarget(prm, out target))
            {
                error = "params.x/y/z (or params.target) are required";
                return false;
            }

            double speed = 10;
            var speedToken = prm["speed"];
            if (speedToken != null) double.TryParse(speedToken.ToString(), out speed);

            try
            {
                // VERIFY: IMyRemoteControl autopilot surface on SE 01_210_014.
                WakeControl(grid, rc);
                rc.ClearWaypoints();
                rc.AddWaypoint(new MyWaypointInfo("hermes", target));
                // FlightMode exists on the script API surface in 01_210_014
                // (reflected this build: Sandbox.ModAPI.Ingame.IMyRemoteControl
                // .FlightMode). Pin it instead of relying on the prefab default.
                rc.FlightMode = FlightMode.OneWay;
                // Collision avoidance off: it steers with lateral thrust around
                // imagined obstacles and can fight the waypoint. Docking mode off
                // for the same reason (slow approach when close).
                rc.SetCollisionAvoidance(false);
                rc.SetDockingMode(false);
                // Dampeners on: after the autopilot drops at the waypoint the
                // grid brakes instead of drifting.
                rc.DampenersOverride = true;
                rc.SpeedLimit = (float)Math.Max(1, speed); // VERIFY: may be obsolete in favour of Autopilot.SpeedLimit
                rc.SetAutoPilotEnabled(true);
                // An ack is not evidence the world changed: read the state back.
                bool engaged = rc.IsAutoPilotEnabled;
                var wps = new System.Collections.Generic.List<Sandbox.ModAPI.Ingame.MyWaypointInfo>();
                try { rc.GetWaypointInfo(wps); } catch { }
                _log("info", "move accepted for " + grid.EntityId + " -> " + target +
                    " speed=" + speed + " flightMode=" + rc.FlightMode +
                    " waypoints=" + wps.Count + " distanceToTarget=" +
                    Math.Round((target - grid.PositionComp.GetPosition()).Length(), 1) +
                    " collisionAvoidance=off dockingMode=off dampeners=on" +
                    " autopilot=" + engaged +
                    " physics=" + DescribePhysics(grid));
                if (!engaged)
                {
                    error = "autopilot did not engage: SetAutoPilotEnabled(true) read back false";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = "autopilot rejected move: " + ex.Message;
                return false;
            }
        }

        private bool Hold(VRage.Game.ModAPI.IMyCubeGrid grid, JObject prm, out string error)
        {
            error = null;
            var rc = FirstRemoteControl(grid);
            if (rc == null)
            {
                error = "no functional remote control";
                return false;
            }

            try
            {
                Vector3D target;
                if (!TryTarget(prm, out target))
                    target = grid.PositionComp.GetPosition();
                double speed = 5;
                var speedToken = prm["speed"];
                if (speedToken != null) double.TryParse(speedToken.ToString(), out speed);

                rc.ClearWaypoints();
                rc.AddWaypoint(new MyWaypointInfo("hermes-hold", target));
                rc.SetCollisionAvoidance(true);
                rc.DampenersOverride = true;
                rc.SpeedLimit = (float)Math.Max(1, speed);
                WakeControl(grid, rc);
                rc.SetAutoPilotEnabled(true);
                bool engaged = rc.IsAutoPilotEnabled;
                _log("info", "hold accepted for " + grid.EntityId + " at " + target +
                    " autopilot=" + engaged + " physics=" + DescribePhysics(grid));
                if (!engaged)
                {
                    error = "autopilot did not engage for hold";
                    return false;
                }
                return true;
            }
            catch (Exception ex)
            {
                error = "autopilot rejected hold: " + ex.Message;
                return false;
            }
        }

        private bool Stop(VRage.Game.ModAPI.IMyCubeGrid grid, out string error)
        {
            error = null;
            var rc = FirstRemoteControl(grid);
            if (rc == null)
            {
                error = "no functional remote control";
                return false;
            }
            try
            {
                rc.SetAutoPilotEnabled(false);
                rc.ClearWaypoints();
                _log("info", "stop accepted for " + grid.EntityId);
                return true;
            }
            catch (Exception ex)
            {
                error = "stop failed: " + ex.Message;
                return false;
            }
        }

        private bool SetConnector(VRage.Game.ModAPI.IMyCubeGrid grid, JObject prm, bool connect, out string error)
        {
            error = null;
            var wanted = (string)prm["connector"];
            IMyShipConnector chosen = null;

            foreach (var connector in grid.GetFatBlocks<IMyShipConnector>())
            {
                if (connector == null) continue;
                if (string.IsNullOrEmpty(wanted) || connector.CustomName.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    chosen = connector;
                    break;
                }
            }

            if (chosen == null)
            {
                error = "no connector matched '" + (wanted ?? "<first>") + "'";
                return false;
            }

            try
            {
                // VERIFY: Connect()/Disconnect() on the plugin connector interface.
                if (connect) chosen.Connect();
                else chosen.Disconnect();
                _log("info", (connect ? "dock" : "undock") + " accepted for " + grid.EntityId);
                return true;
            }
            catch (Exception ex)
            {
                error = "connector action failed: " + ex.Message;
                return false;
            }
        }

        /// <summary>
        /// A spawned NPC grid can arrive with its physics body asleep (the world
        /// runs Selective Physics Updates and no player is near it), in which case
        /// the autopilot is set but the grid never integrates. Enabling and
        /// activating the body is a no-op when it is already simulating.
        /// </summary>
        private static void WakeControl(VRage.Game.ModAPI.IMyCubeGrid grid, IMyRemoteControl rc)
        {
            try
            {
                var fb = rc as Sandbox.ModAPI.IMyFunctionalBlock;
                if (fb != null && !fb.Enabled) fb.Enabled = true;
                var phys = grid.Physics;
                if (phys != null)
                {
                    if (!phys.Enabled) phys.Enabled = true;
                    phys.Activate();
                }
            }
            catch { /* leave the order to fail visibly instead of throwing here */ }
        }

        private static string DescribePhysics(VRage.Game.ModAPI.IMyCubeGrid grid)
        {
            try
            {
                var phys = grid.Physics;
                if (phys == null) return "none";
                return "enabled=" + phys.Enabled + ",active=" + phys.IsActive +
                    ",static=" + phys.IsStatic + ",vel=" + phys.LinearVelocity;
            }
            catch (Exception ex) { return "unreadable(" + ex.Message + ")"; }
        }

        private static IMyRemoteControl FirstRemoteControl(VRage.Game.ModAPI.IMyCubeGrid grid)
        {
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                // VERIFY: IsFunctional on the terminal block interface.
                if (rc != null && rc.IsFunctional) return rc;
            }
            return null;
        }

        private static bool TryTarget(JObject prm, out Vector3D target)
        {
            target = Vector3D.Zero;
            var nested = prm["target"] as JObject;
            var source = nested ?? prm;
            var x = source["x"];
            var y = source["y"];
            var z = source["z"];
            if (x == null || y == null || z == null) return false;

            double dx, dy, dz;
            if (!double.TryParse(x.ToString(), out dx)) return false;
            if (!double.TryParse(y.ToString(), out dy)) return false;
            if (!double.TryParse(z.ToString(), out dz)) return false;
            target = new Vector3D(dx, dy, dz);
            return true;
        }
    }
}
