using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;
using Sandbox.Game.Entities;
using Sandbox.Game.GameSystems;
using Sandbox.ModAPI;
using Sandbox.ModAPI.Interfaces;
using VRage.Game;
using VRage.Game.ModAPI;
using VRage.ModAPI;
using VRageMath;
using IMyRemoteControl = Sandbox.ModAPI.IMyRemoteControl;
using IMyFunctionalBlock = Sandbox.ModAPI.IMyFunctionalBlock;
using IMyRadioAntenna = Sandbox.ModAPI.IMyRadioAntenna;
using IMyLaserAntenna = Sandbox.ModAPI.IMyLaserAntenna;
using IMyThrust = Sandbox.ModAPI.IMyThrust;
using IMyBatteryBlock = Sandbox.ModAPI.IMyBatteryBlock;
using IMyReactor = Sandbox.ModAPI.IMyReactor;
using IMyGasTank = Sandbox.ModAPI.IMyGasTank;
using IMyGyro = Sandbox.ModAPI.IMyGyro;
using IMyProgrammableBlock = Sandbox.ModAPI.IMyProgrammableBlock;
using IngameLaser = Sandbox.ModAPI.Ingame.IMyLaserAntenna;
using IngameTerminal = Sandbox.ModAPI.Ingame.IMyTerminalBlock;

namespace HermesRts.Plugin
{

    /// <summary>
    /// Production action channel (`orderType: "action"`). Compiled into BOTH
    /// build flavours so the live build is a control plane, not a read-only map:
    /// reads, autopilot move/hold/stop, dampeners, thrust and gyro overrides,
    /// level flight and the land controller, block properties (including antenna
    /// radius), laser aiming and station conversion.
    ///
    /// Nothing admin lives here (no spawn, clone, delete, teleport, world-matrix
    /// write, ownership takeover, velocity zeroing or save). Those dispatch from
    /// the test-only subclass in TestHarness.cs; on this channel they are refused
    /// with "not available in survival build: ...", in the test build too. All
    /// safety logic stays here and applies to both channels: the dampener
    /// dead-man lease (NoteBackendOrder), safe mode (checked by the caller),
    /// manual-control silence (the controllers) and game-thread queueing (Plugin).
    /// </summary>
    public class HermesActions
    {
        protected readonly PluginConfig _config;
        protected readonly Action<string, string> _log;
        protected readonly bool _survivalMode;
        private readonly CommandExecutor _executor;
        private readonly SafeMode _safeMode;

        public HermesActions(PluginConfig config, Action<string, string> log, CommandExecutor executor = null, SafeMode safeMode = null)
        {
            _config = config;
            _log = log;
            _executor = executor;
            _safeMode = safeMode;
            _survivalMode = !FeatureFlags.TestBuildAllowed(config);
            // The dead-man restores dampeners ON ITSELF after 6 s without a
            // backend order on a grid it does not own (measured 2026-11-10: a
            // starved backend left a falling hull with dampeners off for 12.3 s
            // and it hit the ground at 57 m/s). Runs from Plugin.Tick, i.e. the
            // game thread. Both builds: it is the last line of defence, not a
            // test feature.
            DampenerDeadman.Instance.Restore = (gridId, source, idleSec) =>
            {
                var grid = FindGridEntity(gridId);
                string note = grid == null ? "grid not in scene" : "dampeners restored";
                if (grid != null) LevelFlightController.SetDampeners(grid, true);
                _log("warn", "deadman_dampeners_restored grid:" + gridId + " after " +
                    Math.Round(idleSec, 1) + " s with no backend order (" + source + "): " + note);
            };
        }

        // ---------------------------------------------------------- dispatch

        /// <summary>The `action` name of an order: frame first, then params.</summary>
        public static string ActionOf(JObject order)
        {
            if (order == null) return null;
            var a = (string)order["action"];
            if (string.IsNullOrEmpty(a))
            {
                var p = order["params"] as JObject;
                a = p != null ? (string)p["action"] : null;
            }
            return string.IsNullOrEmpty(a) ? null : a.Trim().ToLowerInvariant();
        }

        /// <summary>
        /// Production channel (`orderType: "action"`), dispatched in BOTH build
        /// flavours. Only the legitimate set is reachable: an admin or unknown
        /// name throws "not available in survival build: ...". The test build
        /// answers the same way, so a client that puts an admin action on the
        /// production channel gets a policy refusal, not a half-executed cheat.
        /// </summary>
        public JObject ExecuteAction(string action, JObject p)
        {
            // Renew the dampener lease before dispatch: an order that fails
            // still proves the backend is alive and still trying.
            NoteBackendOrder(p);
            // Same rule the native executor applies: after the backend has been
            // silent long enough to trip safe mode, the production channel stops
            // accepting world orders until the watchdog clears. The dampener
            // dead-man keeps flying the hull safely in the meantime.
            if (_safeMode != null && _safeMode.Active)
                throw new InvalidOperationException("safe mode active");
            var name = Normalize(action);
            if (ActionChannelRules.Classify(name) != ActionChannel.Production)
                throw new InvalidOperationException(ActionChannelRules.Unavailable(action));
            return Dispatch(name, p, false);
        }

        /// <summary>Ack-shaped wrapper for the socket: false + error, never a throw.</summary>
        public bool TryAction(string action, JObject p, out JObject result, out string error)
        {
            result = null;
            error = null;
            try
            {
                result = ExecuteAction(action, p);
                return true;
            }
            catch (InvalidOperationException ex)
            {
                error = ex.Message;
                _log("warn", "action refused: " + error);
                return false;
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
                _log("error", "action " + action + " threw: " + error);
                return false;
            }
        }

        /// <summary>
        /// Test channel (`orderType: "test"`), test build only. Legitimate
        /// actions take exactly the production path; admin names go to the
        /// <see cref="TryAdmin"/> override, which exists only in the test build.
        /// </summary>
        public JObject Execute(string action, JObject p)
        {
            NoteBackendOrder(p);
            var name = Normalize(action);
            JObject admin;
            if (ActionChannelRules.Classify(name) == ActionChannel.Admin && TryAdmin(name, p, out admin))
                return admin;
            return Dispatch(name, p, true);
        }

        /// <summary>Test-build hook for admin actions. The live build has no override.</summary>
        protected virtual bool TryAdmin(string action, JObject p, out JObject result)
        {
            result = null;
            return false;
        }

        /// <summary>
        /// Test-path station conversion (zero the velocity, then convert). That
        /// zeroing is a teleport, so only the test build overrides this; the
        /// live conversion stops on dampeners instead (SurvivalStationConverter).
        /// </summary>
        protected virtual JObject ConvertToStationTestPath(IMyCubeGrid grid, JObject p)
        {
            throw new InvalidOperationException(
                ActionChannelRules.Unavailable("convert_to_station test path"));
        }

        /// <summary>
        /// A native autopilot order (move/hold/stop/dock) carried on the
        /// production channel: rebuild the envelope CommandExecutor reads and
        /// run it. No `write` path is added here; the executor's own guards
        /// (remote control present, autopilot engaged, dampeners on) apply.
        /// </summary>
        private JObject Native(string orderType, JObject p)
        {
            if (_executor == null)
                throw new InvalidOperationException(ActionChannelRules.Unavailable(orderType));
            var order = new JObject
            {
                ["orderType"] = orderType,
                ["entityId"] = p["entityId"],
                ["params"] = p.DeepClone(),
            };
            string error;
            if (!_executor.Execute(order, out error))
                throw new InvalidOperationException(error ?? ("native order " + orderType + " refused"));
            return new JObject
            {
                ["action"] = orderType,
                ["channel"] = ActionChannelRules.ProductionOrderType,
                ["native"] = true,
            };
        }

        private static string Normalize(string action)
        {
            return string.IsNullOrEmpty(action) ? string.Empty : action.Trim().ToLowerInvariant();
        }

        /// <summary>Entry point: dispatch one action. Throws on failure.</summary>
        private JObject Dispatch(string action, JObject p, bool allowAdmin)
        {
            switch (action)
            {
                // ---- reads (no world write)
                case "identity": return EnsureIdentity(p);
                case "ownership_check": return OwnershipCheck(p);
                case "profile": return Profile(p);
                case "inspect": return Inspect(p);
                case "list_tagged": return ListTagged(p);
                case "list_grids": return ListGrids();
                case "radio_links": return RadioLinks(p);
                case "laser_state": return LaserState(p);
                case "is_under_control": return IsUnderControlAction(p);
                case "deadman_status": return DeadmanStatus();
                case "diag": return Diag(p);
                // T79: the live server has RemoteApiEnabled=false. This is the
                // backend's legitimate SimSpeed source there (read-only).
                case "sim_ratio": return SimRatioRead.Read();
                case "connector_state": return ConnectorState(p);
                case "probe_ground": return ProbeGround(p);
                case "probe_los": return ProbeLos(p);
                case "get_block_props": return GetBlockProps(p);
                case "list_players": return ListPlayers();
                case "planets": return ListPlanets();
                case "suit_radio": return SuitRadio(p);
                case "dock_state": return DockStateRead(p);
                case "gps_list": return GpsList(p);
                case "gps_add": return GpsAdd(p);
                case "gps_remove": return GpsRemove(p);

                // ---- flight and ship handling
                // Native autopilot types may also arrive as `action` (the
                // backend normally sends them as their own orderType). Same
                // executor, same guards: a move is a move whichever envelope
                // carries it.
                case "move": return Native(action, p);
                case "waypoint": return Native(action, p);
                case "drive": return Native(action, p);
                case "hold": return Native(action, p);
                case "stop": return Native(action, p);
                case "brake": return Native("stop", p);
                case "dock": return Native(action, p);
                case "undock": return Native(action, p);
                case "set_dampeners": return SetDampeners(p);
                case "wake": return Wake(p);
                case "physics_wake": return PhysicsWake(p);
                case "gyro_fix": return GyroFix(p);
                case "set_block_props": return SetBlockProps(p);
                case "rename_block": return RenameBlock(p);
                case "rename_grid": return RenameGrid(p);
                case "ai_off": return DisableAi(p);
                case "level_hold": return LevelHold(p);
                case "level_move": return LevelMove(p);
                case "level_stop": return LevelStop(p);
                case "level_status": return LevelStatus(p);
                case "land_at": return LandAt(p);
                case "land_ground": return LandGround(p);
                case "land_status": return LandStatus(p);
                case "land_stop": return LandStop(p);
                case "convert_to_ship": return ConvertToShip(p);
                case "convert_to_station": return ConvertToStation(p);

                // ---- lasers
                case "laser_target": return LaserTarget(p);
                case "laser_connect": return LaserConnect(p, true);
                case "laser_disconnect": return LaserConnect(p, false);

                default:
                    if (!allowAdmin)
                        throw new InvalidOperationException(ActionChannelRules.Unavailable(action));
                    throw new InvalidOperationException("unknown test action: " + action);
            }
        }



        /// <summary>Block subtypes whose enabled state is part of "built-in AI off".</summary>
        protected static readonly string[] AiBlockSubtypes =
        {
            "ProgrammableBlock", "MyProgrammableBlock",
            "TimerBlock", "MyTimerBlock",
            "EventControllerBlock", "MyEventControllerBlock",
            "FlightMovementBlock", "MyFlightMovementBlock",
            "BasicMissionAutopilot", "MyBasicMissionAutopilot",
            "DefensiveCombatBlock", "OffensiveCombatBlock",
            "PathRecorderBlock", "MyPathRecorderBlock",
        };






        // ---------------------------------------------------------------- identity

        /// <summary>
        /// Reads the identity of the first configured owner Steam id. Survival
        /// build: read-only. It never creates a faction or an NPC identity, and
        /// it refuses plainly when no owner is configured.
        /// </summary>
        protected JObject EnsureIdentity(JObject p)
        {
            if (_config.OwnerSteamIds == null || _config.OwnerSteamIds.Length == 0)
                throw new InvalidOperationException(
                    "no owner configured: set ownerSteamIds in plugin.json (HERMES_OWNER_STEAM_IDS)");
            var steam = _config.OwnerSteamIds[0];
            long identity;
            try
            {
                identity = MyAPIGateway.Players.TryGetIdentityId((ulong)steam);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("player identity lookup failed: " + ex.Message);
            }
            if (identity == 0)
                throw new InvalidOperationException(
                    "owner Steam id " + steam + " has no identity in this world (has the player joined?)");
            return new JObject
            {
                ["source"] = "player-identity",
                ["identityId"] = identity.ToString(),
                ["steamId"] = steam.ToString(),
                ["verifiedMember"] = true,
            };
        }


        protected JObject OwnershipCheck(JObject p)
        {
            var grid = RequireGrid(p);
            long ownerId = OwnerParam(p);
            if (ownerId == 0 && _config.OwnerSteamIds != null && _config.OwnerSteamIds.Length > 0)
                ownerId = MyAPIGateway.Players.TryGetIdentityId((ulong)_config.OwnerSteamIds[0]);
            var result = OwnershipStats(grid, ownerId);
            result["ownerIdRequested"] = ownerId.ToString();
            result["changeIssued"] = false;
            return result;
        }


        protected JObject OwnershipStats(IMyCubeGrid grid, long ownerId)
        {
            var blocks = new List<IMySlimBlock>();
            grid.GetBlocks(blocks);
            int total = blocks.Count, terminal = 0, matching = 0, unownedArmor = 0, ownable = 0;
            var nonMatching = new JArray();
            foreach (var b in blocks)
            {
                if (b.FatBlock != null)
                {
                    terminal++;
                    var cube = b.FatBlock as Sandbox.Game.Entities.MyCubeBlock;
                    bool canOwn = cube != null && cube.IDModule != null;
                    if (canOwn) ownable++;
                    if (canOwn && b.FatBlock.OwnerId == ownerId) matching++;
                    else if (canOwn && nonMatching.Count < 15)
                    {
                        // Provenance for blocks the grid-level call did not move.
                        nonMatching.Add(new JObject
                        {
                            ["subtype"] = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "",
                            ["name"] = SafeName(b.FatBlock),
                            ["ownerId"] = b.FatBlock.OwnerId.ToString(),
                            ["hasIdModule"] = canOwn,
                        });
                    }
                }
                else if (b.OwnerId == 0) unownedArmor++;
            }

            var big = new JArray();
            bool bigOwnerMatches = false;
            foreach (var o in grid.BigOwners)
            {
                // Identity ids exceed 2^53; emit strings so a JS client cannot
                // round them (that bug cost one run).
                big.Add(o.ToString());
                if (o == ownerId) bigOwnerMatches = true;
            }

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["blocksTotal"] = total,
                ["terminalBlocks"] = terminal,
                ["blocksMatchingOwner"] = matching,
                ["unownedArmorBlocks"] = unownedArmor,
                ["ownableTerminalBlocks"] = ownable,
                ["unownableTerminalBlocks"] = terminal - ownable,
                ["nonMatchingCount"] = ownable - matching,
                ["nonMatching"] = nonMatching,
                ["bigOwners"] = big,
                ["bigOwnerMatches"] = bigOwnerMatches,
                // Blocks with no IDModule (small thrusters, lights) cannot carry an
                // owner at all; "applied" therefore means every ownable block is
                // owned and the grid's big owner is the test identity.
                ["applied"] = ownable > 0 && matching == ownable && bigOwnerMatches,
            };
        }


        /// <summary>
        /// Turn a block on through the concrete game class. The mod-API
        /// interface for a remote control does not expose Enabled, so an
        /// interface cast silently no-ops and leaves the RC switched off.
        /// </summary>
        protected static bool EnsureEnabled(IMyCubeBlock block, out string state)
        {
            // Sandbox.ModAPI.IMyFunctionalBlock is the only surface in this build
            // that exposes Enabled for these blocks; the concrete class and the
            // Ingame interface do not. Report the read-back so a silent no-op is
            // visible instead of assumed.
            var fb = block as Sandbox.ModAPI.IMyFunctionalBlock;
            if (fb == null) { state = "no-functional-interface"; return false; }
            bool before = fb.Enabled;
            if (before) { state = "already-on"; return false; }
            fb.Enabled = true;
            state = before + "->" + fb.Enabled;
            return true;
        }


        protected static bool IsAiBlock(IMyCubeBlock fb, string subtype)
        {
            // Type first (subtype names vary per mod/prefab), then name fragments.
            if (fb is IMyProgrammableBlock) return true;
            if (IsAiSubtype(subtype)) return true;
            if (string.IsNullOrEmpty(subtype)) return false;
            foreach (var s in AiSubtypeFragments)
                if (subtype.IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }


        protected static readonly string[] AiSubtypeFragments =
        {
            "TimerBlock", "EventController", "Autopilot", "FlightMovement",
            "DefensiveCombat", "OffensiveCombat", "PathRecorder", "BasicMission",
        };


        protected static bool IsAiSubtype(string subtype)
        {
            if (string.IsNullOrEmpty(subtype)) return false;
            foreach (var s in AiBlockSubtypes)
                if (string.Equals(subtype, s, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }


        // ----------------------------------------------------------------- profile

        protected JObject Profile(JObject p)
        {
            var grid = RequireGrid(p);
            var pos = grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero;
            float mass = grid.Physics != null ? grid.Physics.Mass : 0f;
            var vel = grid.Physics != null ? grid.Physics.LinearVelocity : Vector3.Zero;

            float gInterference = 0f;
            Vector3 gravity = Vector3.Zero;
            try { gravity = MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out gInterference); }
            catch (Exception ex) { _log("warn", "gravity sample failed: " + ex.Message); }

            var radio = new JArray();
            var laser = new JArray();
            var batteries = new JArray();
            var tanks = new JArray();
            var reactors = new JArray();
            var solarPanels = new JArray();

            double thrustTotal = 0, thrustEffective = 0, thrustAtmo = 0, thrustIon = 0, thrustH2 = 0;
            int thrusters = 0, gyros = 0, rcCount = 0, cockpits = 0, pbCount = 0, timers = 0, ecCount = 0;
            int dirUnclassified = 0;
            double batteryStored = 0, batteryCapacity = 0, reactorMax = 0;
            // T20: live power flows and fuel inventory.
            double batteryInMw = 0, batteryOutMw = 0, reactorOutMw = 0, solarActualMw = 0, solarMaxMw = 0;
            double uraniumKg = 0, uraniumVolumeM3 = 0, uraniumMaxVolumeM3 = 0;
            double antennaDrawMw = 0, laserDrawMw = 0, deviceDrawMw = 0;
            // H2 engines, wind turbines and any other producer: power that is
            // NOT solar and NOT a reactor still has to count as production.
            double otherGenerationMw = 0, otherGenerationMaxMw = 0;
            var otherGenerators = new JArray();
            // A block that throws must cost its own row, never the whole section:
            // before this, one bad block made `profile` fail outright and every
            // power/fuel field arrived null (BUG-A: SAT-L-0005).
            var readErrors = new JArray();
            var batteryErrors = new JArray();
            var tankErrors = new JArray();
            int tanksUnread = 0, batteriesUnread = 0;
            var containerGrids = new JArray();
            var electricityId = Sandbox.Game.EntityComponents.MyResourceDistributorComponent.ElectricityId;
            // T25: per-direction thrust envelope (grid local frame).
            var dirThrust = new Dictionary<string, double>();
            var dirCount = new Dictionary<string, int>();
            var dirReported = new Dictionary<string, int>();
            var dirDerived = new Dictionary<string, int>();
            // Some builds report GridThrustDirection=(0,0,0) for thrusters that
            // clearly have an axis (SAT-R-0002: 12 lifters, all zeros). Classify
            // geometrically and say which source each bank came from.
            var thrusterGeometry = ThrusterGeometry.Classify(grid);
            var axisByBlock = new Dictionary<long, ThrusterGeometry.Axis>();
            foreach (var classified in thrusterGeometry.Thrusters)
            {
                if (classified.Thruster != null) axisByBlock[classified.Thruster.EntityId] = classified;
            }

            var blocks = new List<IMySlimBlock>();
            grid.GetBlocks(blocks);
            double integrity = 0, maxIntegrity = 0;
            foreach (var b in blocks)
            {
                integrity += b.BuildIntegrity;
                maxIntegrity += b.MaxIntegrity;
                if (b.FatBlock == null) continue;
                var subtype = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "";

                try
                {

                var antenna = b.FatBlock as IMyRadioAntenna;
                if (antenna != null)
                {
                    var draw = SinkDrawMw(b.FatBlock, electricityId);
                    antennaDrawMw += draw;
                    radio.Add(new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["subtype"] = subtype,
                        ["radiusM"] = antenna.Radius,
                        ["enabled"] = antenna.Enabled,
                        ["working"] = antenna.IsWorking,
                        ["broadcasting"] = antenna.EnableBroadcasting,
                        ["drawMw"] = Math.Round(draw, 4),
                    });
                }

                var la = b.FatBlock as IMyLaserAntenna;
                if (la != null)
                {
                    var draw = SinkDrawMw(b.FatBlock, electricityId);
                    laserDrawMw += draw;
                    var entry = new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["subtype"] = subtype,
                        ["enabled"] = la.Enabled,
                        ["working"] = la.IsWorking,
                        ["rangeM"] = la.Range,
                        ["requiresLos"] = la.RequireLoS,
                        ["status"] = la.Status.ToString(),
                        ["drawMw"] = Math.Round(draw, 4),
                        ["targetX"] = la.TargetCoords.X,
                        ["targetY"] = la.TargetCoords.Y,
                        ["targetZ"] = la.TargetCoords.Z,
                    };
                    laser.Add(entry);
                }

                var thr = b.FatBlock as IMyThrust;
                if (thr != null)
                {
                    thrusters++;
                    thrustTotal += thr.MaxThrust;
                    thrustEffective += thr.MaxEffectiveThrust;
                    if (subtype.IndexOf("Atmospheric", StringComparison.OrdinalIgnoreCase) >= 0) thrustAtmo += thr.MaxThrust;
                    else if (subtype.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) >= 0) thrustH2 += thr.MaxThrust;
                    else thrustIon += thr.MaxThrust;

                    ThrusterGeometry.Axis classified;
                    Vector3I d;
                    var fromGeometry = false;
                    if (axisByBlock.TryGetValue(thr.EntityId, out classified))
                    {
                        d = classified.GridAxis;
                        fromGeometry = !classified.Reported;
                    }
                    else
                    {
                        d = thr.GridThrustDirection;
                    }
                    if (d == Vector3I.Zero) dirUnclassified++;
                    var key = d.X + "," + d.Y + "," + d.Z;
                    double have;
                    dirThrust.TryGetValue(key, out have);
                    dirThrust[key] = have + thr.MaxEffectiveThrust;
                    int n;
                    dirCount.TryGetValue(key, out n);
                    dirCount[key] = n + 1;
                    if (fromGeometry)
                    {
                        int g;
                        dirDerived.TryGetValue(key, out g);
                        dirDerived[key] = g + 1;
                    }
                    else
                    {
                        int r;
                        dirReported.TryGetValue(key, out r);
                        dirReported[key] = r + 1;
                    }
                }

                var gyro = b.FatBlock as IMyGyro;
                if (gyro != null) gyros++;

                var rc = b.FatBlock as IMyRemoteControl;
                if (rc != null) rcCount++;

                if (b.FatBlock is IMyCockpit) cockpits++;
                if (b.FatBlock is IMyProgrammableBlock) pbCount++;
                if (subtype.IndexOf("TimerBlock", StringComparison.OrdinalIgnoreCase) >= 0) timers++;
                if (subtype.IndexOf("EventController", StringComparison.OrdinalIgnoreCase) >= 0) ecCount++;

                var bat = b.FatBlock as IMyBatteryBlock;
                if (bat != null)
                {
                    batteryStored += bat.CurrentStoredPower;
                    batteryCapacity += bat.MaxStoredPower;
                    double inMw = bat.CurrentInput;
                    double outMw = 0;
                    var concrete = b.FatBlock as Sandbox.Game.Entities.MyBatteryBlock;
                    if (concrete != null) outMw = concrete.CurrentOutput;
                    batteryInMw += inMw;
                    batteryOutMw += outMw;
                    batteries.Add(new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["storedMWh"] = Math.Round(bat.CurrentStoredPower, 4),
                        ["capacityMWh"] = Math.Round(bat.MaxStoredPower, 4),
                        ["inputMw"] = Math.Round(inMw, 4),
                        ["outputMw"] = Math.Round(outMw, 4),
                        ["charging"] = inMw > 0.0005 && outMw < inMw,
                    });
                }

                var tank = b.FatBlock as IMyGasTank;
                if (tank != null)
                {
                    var entry = ReadTank(tank, "grid:" + grid.EntityId, out var tankError);
                    if (tankError != null) { tanksUnread++; tankErrors.Add(tankError); readErrors.Add(tankError.DeepClone()); }
                    tanks.Add(entry);
                }

                var reactor = b.FatBlock as IMyReactor;
                if (reactor != null)
                {
                    reactorMax += reactor.MaxOutput;
                    reactorOutMw += reactor.CurrentOutput;
                    double kg = 0, m3 = 0, maxM3 = 0;
                    try
                    {
                        var inv = reactor.GetInventory(0);
                        if (inv != null)
                        {
                            var amount = inv.GetItemAmount(VRage.Game.ModAPI.Ingame.MyItemType.MakeOre("Uranium"));
                            kg = (double)amount;
                            m3 = (double)inv.CurrentVolume;
                            maxM3 = (double)inv.MaxVolume;
                        }
                    }
                    catch (Exception ex) { _log("warn", "reactor inventory read failed: " + ex.Message); }
                    uraniumKg += kg;
                    uraniumVolumeM3 += m3;
                    uraniumMaxVolumeM3 += maxM3;
                    reactors.Add(new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["maxOutputMw"] = Math.Round(reactor.MaxOutput, 4),
                        ["outputMw"] = Math.Round(reactor.CurrentOutput, 4),
                        ["uraniumKg"] = Math.Round(kg, 1),
                        ["uraniumVolumeM3"] = Math.Round(m3, 3),
                        ["inventoryMaxVolumeM3"] = Math.Round(maxM3, 3),
                    });
                }

                var solar = b.FatBlock as SpaceEngineers.Game.ModAPI.IMySolarPanel;
                if (solar != null)
                {
                    solarActualMw += solar.CurrentOutput;
                    solarMaxMw += solar.MaxOutput;
                    solarPanels.Add(new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["actualMw"] = Math.Round(solar.CurrentOutput, 4),
                        ["maxMw"] = Math.Round(solar.MaxOutput, 4),
                    });
                }

                // H2 engines, wind turbines and modded generators: production the
                // old sum dropped entirely. Solar, reactors and batteries are
                // already counted above/below, so they are excluded here.
                var producer = b.FatBlock as Sandbox.ModAPI.IMyPowerProducer;
                if (producer != null && !(b.FatBlock is IMyBatteryBlock) && !(b.FatBlock is IMyReactor) && solar == null)
                {
                    double genOutMw = 0, genMaxMw = 0;
                    try
                    {
                        genOutMw = producer.CurrentOutput;
                        genMaxMw = producer.MaxOutput;
                    }
                    catch (Exception ex) { _log("warn", "generator read failed: " + ex.Message); }
                    var isH2 = subtype.IndexOf("HydrogenEngine", StringComparison.OrdinalIgnoreCase) >= 0 ||
                               subtype.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) >= 0;
                    var isWind = subtype.IndexOf("WindTurbine", StringComparison.OrdinalIgnoreCase) >= 0;
                    otherGenerationMw += genOutMw;
                    otherGenerationMaxMw += genMaxMw;
                    otherGenerators.Add(new JObject
                    {
                        ["name"] = SafeName(b.FatBlock),
                        ["subtype"] = subtype,
                        ["kind"] = isH2 ? "h2-engine" : isWind ? "wind" : "other",
                        ["outputMw"] = Math.Round(genOutMw, 4),
                        ["maxOutputMw"] = Math.Round(genMaxMw, 4),
                    });
                }

                if (b.FatBlock is Sandbox.Game.Entities.Cube.MyFunctionalBlock)
                {
                    // Batteries are STORAGE, not consumers: their charging input is
                    // reported separately (batteryInputMw) and must not sit inside the
                    // device draw, or it is subtracted twice (2026-11-11).
                    if (!(b.FatBlock is IMyBatteryBlock))
                        deviceDrawMw += SinkDrawMw(b.FatBlock, electricityId);
                }
                }
                catch (Exception ex)
                {
                    // Keep the row, keep the section: report the unread block.
                    readErrors.Add(new JObject
                    {
                        ["block"] = SafeName(b.FatBlock),
                        ["subtype"] = subtype,
                        ["error"] = ex.GetType().Name + ": " + ex.Message,
                    });
                }
            }

            // Power/fuel can live on a sub-grid (rotor/piston/hinge/wheel): a
            // docked hydrogen tank that is not enumerated reads as "0 L" and the
            // owner sees an empty ship that is actually full. Only when the main
            // grid contributed nothing do we widen the search, so counts never
            // double.
            if (tanks.Count == 0 || batteries.Count == 0)
            {
                foreach (var sub in ConstructGrids(grid))
                {
                    if (sub == null || sub.EntityId == grid.EntityId || sub.Closed) continue;
                    if (tanks.Count == 0)
                    {
                        foreach (var tank in sub.GetFatBlocks<IMyGasTank>())
                        {
                            if (tank == null) continue;
                            var entry = ReadTank(tank, "grid:" + sub.EntityId, out var tankError);
                            if (tankError != null) { tanksUnread++; tankErrors.Add(tankError); readErrors.Add(tankError.DeepClone()); }
                            tanks.Add(entry);
                            if (containerGrids.Count == 0 || (string)containerGrids[containerGrids.Count - 1]["gridId"] != "grid:" + sub.EntityId)
                                containerGrids.Add(new JObject { ["gridId"] = "grid:" + sub.EntityId, ["role"] = "subgrid", ["tanks"] = tanks.Count });
                        }
                    }
                    if (batteries.Count == 0)
                    {
                        foreach (var bat in sub.GetFatBlocks<IMyBatteryBlock>())
                        {
                            if (bat == null) continue;
                            double inMw = 0, outMw = 0;
                            string batError = null;
                            try
                            {
                                inMw = bat.CurrentInput;
                                var concrete = bat as Sandbox.Game.Entities.MyBatteryBlock;
                                if (concrete != null) outMw = concrete.CurrentOutput;
                            }
                            catch (Exception ex) { batError = ex.GetType().Name + ": " + ex.Message; }
                            if (batError != null) { batteriesUnread++; var be = new JObject { ["block"] = SafeName(bat), ["error"] = batError }; batteryErrors.Add(be); readErrors.Add(be.DeepClone()); }
                            batteryStored += bat.CurrentStoredPower;
                            batteryCapacity += bat.MaxStoredPower;
                            batteryInMw += inMw;
                            batteryOutMw += outMw;
                            batteries.Add(new JObject
                            {
                                ["name"] = SafeName(bat),
                                ["container"] = "grid:" + sub.EntityId,
                                ["storedMWh"] = Math.Round(bat.CurrentStoredPower, 4),
                                ["capacityMWh"] = Math.Round(bat.MaxStoredPower, 4),
                                ["inputMw"] = Math.Round(inMw, 4),
                                ["outputMw"] = Math.Round(outMw, 4),
                                ["charging"] = inMw > 0.0005 && outMw < inMw,
                                ["readState"] = batError == null ? "read" : "unread",
                            });
                        }
                    }
                }
            }

            double gravityMag = gravity.Length();
            double twr = mass > 0 && gravityMag > 0.01 ? thrustEffective / (mass * gravityMag) : -1;

            // Per-direction thrust, grid local: +Y is up, -Z is forward (SE).
            string[] dirNames = { "up", "down", "fwd", "back", "left", "right" };
            var dirVectors = new[]
            {
                new Vector3I(0, 1, 0), new Vector3I(0, -1, 0),
                new Vector3I(0, 0, -1), new Vector3I(0, 0, 1),
                new Vector3I(-1, 0, 0), new Vector3I(1, 0, 0),
            };
            var perDirection = new JObject();
            var byDirection = new JArray();
            foreach (var kv in dirThrust)
            {
                byDirection.Add(new JObject
                {
                    ["direction"] = kv.Key,
                    ["thrustN"] = Math.Round(kv.Value, 0),
                    ["count"] = dirCount.ContainsKey(kv.Key) ? dirCount[kv.Key] : 0,
                    ["reportedCount"] = dirReported.ContainsKey(kv.Key) ? dirReported[kv.Key] : 0,
                    ["derivedCount"] = dirDerived.ContainsKey(kv.Key) ? dirDerived[kv.Key] : 0,
                });
            }
            for (var i = 0; i < dirNames.Length; i++)
            {
                var key = dirVectors[i].X + "," + dirVectors[i].Y + "," + dirVectors[i].Z;
                perDirection[dirNames[i] + "N"] = dirThrust.ContainsKey(key) ? Math.Round(dirThrust[key], 0) : 0;
                perDirection[dirNames[i] + "Count"] = dirCount.ContainsKey(key) ? dirCount[key] : 0;
            }
            var upN = (double)perDirection["upN"];
            var downN = (double)perDirection["downN"];
            var latN = Math.Max((double)perDirection["fwdN"], (double)perDirection["backN"]) +
                       Math.Max((double)perDirection["leftN"], (double)perDirection["rightN"]);
            // A hull with lift but almost no down/lateral authority cannot be
            // flown by SE's autopilot (it tips to face the waypoint): level mode.
            var liftDominant = upN > 0 && (downN < upN * 0.25 || latN < upN * 0.25);

            var chargingState = PowerMath.ChargeState(batteryInMw, batteryOutMw);
            // Batteries are storage: production is what the generators make now,
            // consumption is what the non-battery consumers draw now. A
            // discharging battery covers the deficit, it is not production.
            var generationMw = PowerMath.GenerationMw(solarActualMw, reactorOutMw, otherGenerationMw);
            var consumerDrawMw = deviceDrawMw;
            var netMw = PowerMath.NetMw(generationMw, consumerDrawMw);
            var powerRunwayMin = PowerMath.RunwayMin(batteryStored, netMw);
            var powerRunwayReason = PowerMath.RunwayReason(batteries.Count > 0, chargingState, netMw);
            var uraniumDensity = uraniumVolumeM3 > 0.0001 ? uraniumKg / uraniumVolumeM3 : 0; // kg/m3, measured
            var uraniumCapacityKg = uraniumDensity > 0 ? uraniumDensity * uraniumMaxVolumeM3 : 0;

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["gridSize"] = grid.GridSizeEnum.ToString(),
                ["isStatic"] = grid.IsStatic,
                ["lockedBy"] = LockedBy(grid),
                ["position"] = Vec(pos),
                ["velocity"] = Vec(vel),
                ["massKg"] = mass,
                ["blocksTotal"] = blocks.Count,
                ["integrity"] = new JObject
                {
                    ["build"] = Math.Round(integrity, 1),
                    ["max"] = Math.Round(maxIntegrity, 1),
                    ["fraction"] = maxIntegrity > 0 ? Math.Round(integrity / maxIntegrity, 4) : 0,
                },
                ["radio"] = radio,
                ["laser"] = laser,
                ["thrusters"] = new JObject
                {
                    ["count"] = thrusters,
                    ["maxThrustN"] = Math.Round(thrustTotal, 0),
                    ["maxEffectiveThrustN"] = Math.Round(thrustEffective, 0),
                    ["ionN"] = Math.Round(thrustIon, 0),
                    ["atmoN"] = Math.Round(thrustAtmo, 0),
                    ["h2N"] = Math.Round(thrustH2, 0),
                },
                ["thrustPerDirection"] = perDirection,
                ["thrustBanks"] = byDirection,
                ["thrusterClassification"] = new JObject
                {
                    ["reportedCount"] = thrusterGeometry.ReportedCount,
                    ["derivedCount"] = thrusterGeometry.DerivedCount,
                    ["unclassifiedCount"] = dirUnclassified,
                    ["calibrated"] = thrusterGeometry.Calibrated,
                    ["calibrationAxis"] = thrusterGeometry.CalibrationAxis,
                    ["calibrationMatches"] = thrusterGeometry.CalibrationMatches,
                    ["calibrationSamples"] = thrusterGeometry.CalibrationSamples,
                    ["note"] = thrusterGeometry.Note,
                    ["thrusters"] = ThrusterGeometry.ToJson(thrusterGeometry),
                },
                ["flightMode"] = new JObject
                {
                    ["recommended"] = liftDominant ? "level" : "autopilot",
                    ["liftDominant"] = liftDominant,
                    ["note"] = liftDominant
                        ? "lift-dominant hull: level_hold/level_move (never face-the-waypoint autopilot)"
                        : "balanced thrust: SE autopilot is safe",
                },
                ["gyros"] = gyros,
                ["remoteControls"] = rcCount,
                ["cockpits"] = cockpits,
                ["programmableBlocks"] = pbCount,
                ["timers"] = timers,
                ["eventControllers"] = ecCount,
                ["control"] = ControlState(grid),
                ["power"] = new JObject
                {
                    ["batteryStoredMWh"] = Math.Round(batteryStored, 4),
                    ["batteryCapacityMWh"] = Math.Round(batteryCapacity, 4),
                    ["batteryPct"] = batteryCapacity > 0 ? Math.Round(batteryStored / batteryCapacity * 100.0, 1) : -1,
                    ["batteryInputMw"] = Math.Round(batteryInMw, 4),
                    ["batteryOutputMw"] = Math.Round(batteryOutMw, 4),
                    ["chargeState"] = chargingState,
                    ["netMw"] = Math.Round(netMw, 4),
                    ["generationMw"] = Math.Round(generationMw, 4),
                    ["otherGenerationMw"] = Math.Round(otherGenerationMw, 4),
                    ["otherGenerationMaxMw"] = Math.Round(otherGenerationMaxMw, 4),
                    ["generators"] = otherGenerators,
                    ["consumerDrawMw"] = Math.Round(consumerDrawMw, 4),
                    ["batteryChargeMw"] = Math.Round(batteryInMw, 4),
                    ["powerRunwayMin"] = powerRunwayMin == null ? (JToken)JValue.CreateNull() : Math.Round((double)powerRunwayMin, 1),
                    ["powerRunwayReason"] = powerRunwayReason,
                    ["runwayNote"] = powerRunwayMin == null
                        ? powerRunwayReason == "charging" ? "no runway: the batteries are charging, not draining"
                            : powerRunwayReason == "absent" ? "no runway: no battery on this grid"
                            : powerRunwayReason == "idle" ? "no runway: no projected drain"
                            : "no runway: no battery charge reading"
                        : "runway from the stored battery charge and the projected deficit",
                    ["reactorMaxMw"] = Math.Round(reactorMax, 4),
                    ["reactorOutputMw"] = Math.Round(reactorOutMw, 4),
                    ["solarActualMw"] = Math.Round(solarActualMw, 4),
                    ["solarMaxMw"] = Math.Round(solarMaxMw, 4),
                    ["solarEfficiency"] = solarMaxMw > 0.0001 ? Math.Round(solarActualMw / solarMaxMw, 3) : -1,
                    ["deviceDrawMw"] = Math.Round(deviceDrawMw, 4),
                    ["antennaDrawMw"] = Math.Round(antennaDrawMw, 4),
                    ["laserDrawMw"] = Math.Round(laserDrawMw, 4),
                    ["uraniumKg"] = Math.Round(uraniumKg, 1),
                    ["uraniumCapacityKg"] = Math.Round(uraniumCapacityKg, 1),
                    ["uraniumPct"] = uraniumCapacityKg > 0 ? Math.Round(uraniumKg / uraniumCapacityKg * 100.0, 1) : -1,
                    ["batteries"] = batteries,
                    ["reactors"] = reactors,
                    ["solar"] = solarPanels,
                    ["batteryCount"] = batteries.Count,
                    ["readState"] = batteries.Count == 0 ? "no-batteries"
                        : batteriesUnread >= batteries.Count ? "unread" : "read",
                    ["unread"] = batteryErrors,
                },
                ["fuel"] = new JObject
                {
                    ["tanks"] = tanks,
                    ["h2FillPct"] = H2FillPct(tanks),
                    ["h2TankCount"] = H2TankCount(tanks),
                    ["readState"] = H2TankCount(tanks) == 0 ? "no-tanks"
                        : tanksUnread >= H2TankCount(tanks) ? "unread" : "read",
                    ["unread"] = tankErrors,
                    ["containerGrids"] = containerGrids,
                },
                ["gravity"] = new JObject
                {
                    ["x"] = Math.Round(gravity.X, 4),
                    ["y"] = Math.Round(gravity.Y, 4),
                    ["z"] = Math.Round(gravity.Z, 4),
                    ["magnitudeMs2"] = Math.Round(gravityMag, 4),
                    ["interference"] = Math.Round(gInterference, 4),
                },
                ["twr"] = twr > 0 ? Math.Round(twr, 3) : -1,
                ["twrNote"] = twr > 0 ? "measured: sum(MaxEffectiveThrust) / (physics mass * local gravity)" : "not computable (no gravity or no thrust)",
                ["readErrors"] = readErrors,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }


        // ---------------------------------------------------------------- ground

        /// <summary>
        /// Read-only state of the things that decide whether a grid can be flown:
        /// physics body state and the remote control's autopilot state. Exists so
        /// a "move accepted" order can be checked against the world, not the ack.
        /// </summary>
        protected static JToken ReadOnOff(IMyCubeBlock block)
        {
            var fb = block as Sandbox.ModAPI.IMyFunctionalBlock;
            return fb == null ? JValue.CreateNull() : new JValue(fb.Enabled);
        }


        /// <summary>
        /// Read-only deep state of every block that could be moving the grid
        /// without an override: gyro power/enabled state, thruster enabled
        /// state, per-block CustomData (MES/RivalAI/script tags), the entity's
        /// mod Storage keys, and which AI-ish assemblies are loaded. Exists to
        /// separate "something else is driving the grid" from "our own control
        /// path cannot aim it".
        /// </summary>
        protected JObject Inspect(JObject p)
        {
            var grid = RequireGrid(p);

            var gyros = new JArray();
            int gyroPowerZero = 0, gyroDisabled = 0, gyroNotWorking = 0;
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                bool? en = EnabledOf(gyro);
                bool enabled = en == true;
                if (!enabled) gyroDisabled++;
                if (!gyro.IsWorking) gyroNotWorking++;
                if (gyro.GyroPower <= 0f) gyroPowerZero++;
                gyros.Add(new JObject
                {
                    ["name"] = SafeName(gyro),
                    ["enabled"] = en,
                    ["working"] = gyro.IsWorking,
                    ["functional"] = gyro.IsFunctional,
                    ["gyroPower"] = Math.Round(gyro.GyroPower, 4),
                    ["override"] = gyro.GyroOverride,
                    ["yaw"] = gyro.Yaw, ["pitch"] = gyro.Pitch, ["roll"] = gyro.Roll,
                    ["ownerId"] = gyro.OwnerId.ToString(),
                    ["customData"] = Trim(gyro.CustomData, 200),
                });
            }

            var thrusters = new JArray();
            int thrDisabled = 0, thrNotWorking = 0;
            float sumMax = 0f, sumEffective = 0f, sumCurrent = 0f;
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                bool? ten = EnabledOf(thr);
                bool enabled = ten == true;
                if (!enabled) thrDisabled++;
                if (!thr.IsWorking) thrNotWorking++;
                sumMax += thr.MaxThrust;
                sumEffective += thr.MaxEffectiveThrust;
                sumCurrent += thr.CurrentThrust;
                thrusters.Add(new JObject
                {
                    ["name"] = SafeName(thr),
                    ["enabled"] = ten,
                    ["axisWorld"] = Vec(thr.WorldMatrix.Forward),
                    ["working"] = thr.IsWorking,
                    ["currentThrustN"] = Math.Round(thr.CurrentThrust, 1),
                    ["maxThrustN"] = Math.Round(thr.MaxThrust, 1),
                    ["maxEffectiveThrustN"] = Math.Round(thr.MaxEffectiveThrust, 1),
                    ["overridePct"] = Math.Round(thr.ThrustOverridePercentage, 4),
                    ["overrideN"] = Math.Round(thr.ThrustOverride, 1),
                    ["ownerId"] = thr.OwnerId.ToString(),
                });
            }

            // Every block that carries CustomData or a role/CustomName tag:
            // this is where MES/RivalAI/SPRT scripts tag their grids, and where
            // the roles backend reads `[HERMES-ROLE:...]` from (CustomName or
            // CustomData on the block itself).
            var tagged = new JArray();
            // Role tags resolve from the same pass: any block's CustomName or
            // CustomData, not just a PB. Same parser as `list_tagged`.
            var roleHints = new JArray();
            var roleSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var blocks = new List<IMySlimBlock>();
            grid.GetBlocks(blocks);
            foreach (var b in blocks)
            {
                if (b.FatBlock == null) continue;
                var terminal = b.FatBlock as Sandbox.ModAPI.IMyTerminalBlock;
                var customName = SafeName(b.FatBlock);
                var data = terminal != null ? (terminal.CustomData ?? "") : "";
                if (customName.IndexOf('[') >= 0 || customName.IndexOf("hermes_role", StringComparison.OrdinalIgnoreCase) >= 0)
                    foreach (var hint in ShipRoleTags.Parse(customName, "block-name", customName))
                        AddRoleHint(roleHints, roleSeen, hint);
                if (data.IndexOf('[') >= 0 || data.IndexOf("hermes_role", StringComparison.OrdinalIgnoreCase) >= 0)
                    foreach (var hint in ShipRoleTags.Parse(data, "custom-data", customName))
                        AddRoleHint(roleHints, roleSeen, hint);
                if (string.IsNullOrEmpty(data) && customName.IndexOf("[", StringComparison.Ordinal) < 0) continue;
                tagged.Add(new JObject
                {
                    ["subtype"] = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "",
                    ["name"] = customName,
                    ["id"] = "block:" + b.FatBlock.EntityId,
                    ["customName"] = customName,
                    ["customData"] = Trim(data, 600),
                    ["data"] = Trim(data, 600),
                });
            }

            // Mods keep per-entity state in MyEntity.Storage; read it by
            // reflection so this file does not depend on an internal type.
            var storage = new JObject();
            try
            {
                var prop = grid.GetType().GetProperty("Storage");
                var dict = prop != null ? prop.GetValue(grid, null) as System.Collections.IDictionary : null;
                if (dict != null)
                    foreach (System.Collections.DictionaryEntry kv in dict)
                        storage[Convert.ToString(kv.Key)] = Trim(Convert.ToString(kv.Value), 400);
            }
            catch (Exception ex) { storage["__error"] = ex.Message; }

            // Which automation assemblies are actually loaded in this domain.
            var assemblies = new JArray();
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                string n;
                try { n = asm.GetName().Name ?? ""; } catch { continue; }
                if (n.IndexOf("MES", StringComparison.OrdinalIgnoreCase) < 0 &&
                    n.IndexOf("Modular", StringComparison.OrdinalIgnoreCase) < 0 &&
                    n.IndexOf("Rival", StringComparison.OrdinalIgnoreCase) < 0 &&
                    n.IndexOf("AiEnabled", StringComparison.OrdinalIgnoreCase) < 0 &&
                    n.IndexOf("Spawner", StringComparison.OrdinalIgnoreCase) < 0 &&
                    n.IndexOf("Bot", StringComparison.OrdinalIgnoreCase) < 0) continue;
                assemblies.Add(new JObject { ["name"] = n, ["version"] = asm.GetName().Version.ToString() });
            }

            var batteries = new JArray();
            float stored = 0f, capacity = 0f;
            foreach (var bat in grid.GetFatBlocks<IMyBatteryBlock>())
            {
                if (bat == null) continue;
                stored += bat.CurrentStoredPower;
                capacity += bat.MaxStoredPower;
                var fb = bat as IMyFunctionalBlock;
                batteries.Add(new JObject
                {
                    ["name"] = SafeName(bat),
                    ["enabled"] = EnabledOf(bat),
                    ["working"] = bat.IsWorking,
                    ["storedMWh"] = Math.Round(bat.CurrentStoredPower, 4),
                    ["capacityMWh"] = Math.Round(bat.MaxStoredPower, 4),
                    ["chargeMode"] = bat.ChargeMode.ToString(),
                });
            }

            var controllers = new JArray();
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                controllers.Add(new JObject
                {
                    ["kind"] = "remoteControl",
                    ["name"] = SafeName(rc),
                    ["enabled"] = EnabledOf(rc),
                    ["mainCockpit"] = rc.IsMainCockpit,
                    ["direction"] = rc.Direction.ToString(),
                    ["working"] = rc.IsWorking,
                    ["autopilot"] = rc.IsAutoPilotEnabled,
                    ["speedLimit"] = rc.SpeedLimit,
                    ["dampenersOverride"] = rc.DampenersOverride,
                    ["flightMode"] = rc.FlightMode.ToString(),
                    ["waypoints"] = WaypointCount(rc),
                    ["customName"] = rc.CustomName ?? "",
                    ["customData"] = Trim(rc.CustomData, 400),
                });
            }

            var aiBlocks = new JArray();
            foreach (var b in blocks)
            {
                if (b.FatBlock == null) continue;
                var subtype = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "";
                if (!IsAiBlock(b.FatBlock, subtype)) continue;
                var fb = b.FatBlock as IMyFunctionalBlock;
                aiBlocks.Add(new JObject
                {
                    ["subtype"] = subtype,
                    ["name"] = SafeName(b.FatBlock),
                    ["enabled"] = EnabledOf(b.FatBlock),
                    ["working"] = b.FatBlock.IsWorking,
                });
            }

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["massKg"] = grid.Physics != null ? Math.Round(grid.Physics.Mass, 1) : 0,
                ["blockCount"] = blocks.Count,
                ["geometry"] = GeometryOf(grid),
                ["orientation"] = new JObject
                {
                    ["forward"] = Vec(grid.WorldMatrix.Forward),
                    ["up"] = Vec(grid.WorldMatrix.Up),
                    ["right"] = Vec(grid.WorldMatrix.Right),
                },
                ["gravityVector"] = grid.Physics != null ? Vec(grid.Physics.Gravity) : null,
                ["isStatic"] = grid.IsStatic,
                ["physicsActive"] = grid.Physics != null && grid.Physics.IsActive,
                ["velocity"] = grid.Physics != null ? Vec(grid.Physics.LinearVelocity) : null,
                ["angularVelocity"] = grid.Physics != null ? Vec(grid.Physics.AngularVelocity) : null,
                ["gyros"] = gyros,
                ["gyroSummary"] = new JObject
                {
                    ["count"] = gyros.Count,
                    ["disabled"] = gyroDisabled,
                    ["notWorking"] = gyroNotWorking,
                    ["powerZero"] = gyroPowerZero,
                },
                ["thrusters"] = thrusters,
                ["thrusterSummary"] = new JObject
                {
                    ["count"] = thrusters.Count,
                    ["disabled"] = thrDisabled,
                    ["notWorking"] = thrNotWorking,
                    ["sumMaxN"] = Math.Round(sumMax, 1),
                    ["sumMaxEffectiveN"] = Math.Round(sumEffective, 1),
                    ["sumCurrentN"] = Math.Round(sumCurrent, 1),
                },
                ["batteries"] = batteries,
                ["powerSummary"] = new JObject
                {
                    ["storedMWh"] = Math.Round(stored, 4),
                    ["capacityMWh"] = Math.Round(capacity, 4),
                },
                ["controllers"] = controllers,
                ["aiBlocks"] = aiBlocks,
                ["taggedBlocks"] = tagged,
                ["roleHints"] = roleHints,
                ["roleTags"] = new JArray(RoleTagList(roleHints)),
                ["role"] = ShipRoleTags.Worst(RoleTagList(roleHints)),
                ["entityStorage"] = storage,
                ["aiAssemblies"] = assemblies,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }


        /// <summary>
        /// Hull geometry: the pivot is not the hull's centre or belly, so every
        /// ground computation needs the signed pivot -> lowest-point distance
        /// along local down (see GridGeometry).
        /// </summary>
        protected static JObject GeometryOf(IMyCubeGrid grid)
        {
            var geo = new JObject();
            try
            {
                Vector3D up, bottom, min, max;
                var keel = GridGeometry.KeelDepthM(grid, out up, out bottom);
                GridGeometry.LocalAabbM(grid, out min, out max);
                geo["keelDepthM"] = Math.Round(keel, 2);
                geo["up"] = Vec(up);
                geo["hullBottom"] = Vec(bottom);
                geo["localAABB"] = new JObject
                {
                    ["min"] = Vec(min),
                    ["max"] = Vec(max),
                };
                geo["source"] = "local-aabb";
            }
            catch (Exception ex)
            {
                geo["source"] = "unreadable";
                geo["error"] = ex.GetType().Name + ": " + ex.Message;
            }
            return geo;
        }


        /// <summary>
        /// Restore gyro attitude authority: full power, enabled, override off,
        /// no residual rotation input. Explicit and logged — a PB script can
        /// leave GyroPower=0, which leaves the autopilot "on" but unable to
        /// turn the ship.
        /// </summary>
        protected JObject GyroFix(JObject p)
        {
            var grid = RequireGrid(p);
            int fixedCount = 0, before = 0;
            var detail = new JArray();
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                var fb = gyro as IMyFunctionalBlock;
                float powerBefore = gyro.GyroPower;
                bool enabledBefore = fb != null && fb.Enabled;
                if (powerBefore < 1f) before++;
                if (fb != null && !fb.Enabled) fb.Enabled = true;
                gyro.GyroPower = 1f;
                gyro.GyroOverride = false;
                gyro.Yaw = 0f; gyro.Pitch = 0f; gyro.Roll = 0f;
                fixedCount++;
                detail.Add(new JObject
                {
                    ["name"] = SafeName(gyro),
                    ["powerBefore"] = Math.Round(powerBefore, 4),
                    ["enabledBefore"] = enabledBefore,
                    ["powerAfter"] = gyro.GyroPower,
                    ["enabledAfter"] = fb != null && fb.Enabled,
                    ["working"] = gyro.IsWorking,
                });
            }
            _log("info", "gyro_fix grid:" + grid.EntityId + " gyros=" + fixedCount + " powerWasBelowOne=" + before);
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["gyros"] = fixedCount,
                ["powerWasBelowOne"] = before,
                ["detail"] = detail,
            };
        }


        /// <summary>
        /// Read Enabled through the concrete MyFunctionalBlock. The
        /// Sandbox.ModAPI.IMyFunctionalBlock cast returns null for
        /// MyRemoteControl (proven on the test server: "no-functional-interface"),
        /// so interface reads silently report false.
        /// </summary>
        protected static bool? EnabledOf(IMyCubeBlock block)
        {
            var concrete = block as Sandbox.Game.Entities.Cube.MyFunctionalBlock;
            if (concrete != null) return concrete.Enabled;
            var fb = block as Sandbox.ModAPI.IMyFunctionalBlock;
            if (fb != null) return fb.Enabled;
            return null;
        }


        protected static int WaypointCount(IMyRemoteControl rc)
        {
            var list = new List<Sandbox.ModAPI.Ingame.MyWaypointInfo>();
            try { rc.GetWaypointInfo(list); } catch { return -1; }
            return list.Count;
        }


        protected static string Trim(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length <= max ? s : s.Substring(0, max) + "…";
        }


        protected JObject Diag(JObject p)
        {
            var grid = RequireGrid(p);
            var phys = grid.Physics;
            int thrusters = 0, thrustersFiring = 0, gyroOverrides = 0;
            float maxThrust = 0f, sumThrust = 0f;
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                thrusters++;
                var cur = thr.CurrentThrust;
                sumThrust += cur;
                if (cur > maxThrust) maxThrust = cur;
                if (cur > 1f) thrustersFiring++;
            }
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
                if (gyro != null && gyro.GyroOverride) gyroOverrides++;
            var rcOut = new JArray();
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                rcOut.Add(new JObject
                {
                    ["name"] = SafeName(rc),
                    ["enabled"] = ReadOnOff(rc),
                    ["typeName"] = rc.GetType().FullName,
                    ["functionalInterface"] = rc is Sandbox.ModAPI.IMyFunctionalBlock,
                    ["working"] = rc.IsWorking,
                    ["functional"] = rc.IsFunctional,
                    ["autopilot"] = rc.IsAutoPilotEnabled,
                    ["speedLimit"] = rc.SpeedLimit,
                    ["dampenersOverride"] = rc.DampenersOverride,
                });
            }

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["isStatic"] = grid.IsStatic,
                ["inScene"] = grid.InScene,
                ["closed"] = grid.Closed,
                ["physics"] = new JObject
                {
                    ["present"] = phys != null,
                    ["enabled"] = phys != null ? phys.Enabled : false,
                    ["isStatic"] = phys != null ? phys.IsStatic : false,
                    ["active"] = phys != null ? phys.IsActive : false,
                    ["massKg"] = phys != null ? phys.Mass : 0,
                    ["velocity"] = phys != null ? Vec(phys.LinearVelocity) : null,
                    ["angularVelocity"] = phys != null ? Vec(phys.AngularVelocity) : null,
                    ["gravity"] = phys != null ? Vec(phys.Gravity) : null,
                },
                ["position"] = Vec(grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero),
                ["thrust"] = new JObject
                {
                    ["thrusters"] = thrusters,
                    ["firing"] = thrustersFiring,
                    ["sumCurrentThrustN"] = Math.Round(sumThrust, 1),
                    ["maxCurrentThrustN"] = Math.Round(maxThrust, 1),
                    ["gyroOverrides"] = gyroOverrides,
                },
                ["remoteControls"] = rcOut,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }


        /// <summary>
        /// Force a grid's physics body to be enabled, awake and at rest, so a
        /// freshly spawned stand-in is actually simulated before it is ordered to
        /// fly. Used as an explicit, logged step, never silently.
        /// </summary>
        protected JObject PhysicsWake(JObject p)
        {
            var grid = RequireGrid(p);
            var phys = grid.Physics;
            if (phys == null) throw new InvalidOperationException("grid has no physics body");

            bool wasEnabled = phys.Enabled;
            bool wasActive = phys.IsActive;
            var wasVel = phys.LinearVelocity;
            phys.Enabled = true;
            phys.Activate();
            bool zero = p["zeroVelocity"] == null || (bool)p["zeroVelocity"];
            if (zero) phys.SetSpeeds(Vector3.Zero, Vector3.Zero);

            _log("info", "physics_wake grid:" + grid.EntityId + " enabled " + wasEnabled + "->" + phys.Enabled +
                " active " + wasActive + "->" + phys.IsActive + " vel " + wasVel + " zeroed=" + zero);

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["enabledBefore"] = wasEnabled,
                ["enabledAfter"] = phys.Enabled,
                ["activeBefore"] = wasActive,
                ["activeAfter"] = phys.IsActive,
                ["velocityBefore"] = Vec(wasVel),
                ["velocityAfter"] = Vec(phys.LinearVelocity),
                ["zeroed"] = zero,
            };
        }


        /// <summary>
        /// READ-ONLY antenna/network state for a set of grids. Every field is
        /// sampled from the live world; a pair whose direct link state cannot be
        /// read is reported UNVERIFIED, never inferred. Group membership comes
        /// from Sandbox.Game's MyAntennaSystem (in-process only).
        /// </summary>
        /// <summary>
        /// READ-ONLY radio state, answered from the engine's antenna system.
        ///
        /// Rewritten 2026-11-10: the previous version answered `sameLogicalGroup`
        /// from `MyCubeGridGroups.Logical`, which follows rotor/piston/connector
        /// mechanical groups. Measured control: two grids 200 m apart with both
        /// antennas on returned false, so the field was never a radio reading.
        /// This version reports
        ///   * per radio antenna: radius, power/broadcast state, and the receivers
        ///     the engine resolves in range (`MyDataBroadcaster.ReceiversInRange`);
        ///   * per grid: the broadcasters its receivers resolve
        ///     (`MyDataReceiver.BroadcastersInRange`) and the relayed set from
        ///     `MyAntennaSystem.GetAllRelayedBroadcasters`;
        ///   * per pair: whether each end actually hears the other, with distance.
        /// A field that cannot be read is UNVERIFIED with the exception text; it
        /// is never reported as "not linked".
        /// </summary>
        protected JObject RadioLinks(JObject p)
        {
            var ids = p["entityIds"] as JArray;
            if (ids == null || ids.Count == 0) throw new InvalidOperationException("params.entityIds is required");

            var perGrid = new JArray();
            var readers = new List<AntennaRead.GridRadio>();
            foreach (var token in ids)
            {
                string raw = token.Value<string>();
                long id = long.Parse(raw.Replace("grid:", ""));
                IMyEntity entity;
                if (!MyAPIGateway.Entities.TryGetEntityById(id, out entity)) throw new InvalidOperationException("grid not found: " + raw);
                var grid = entity as IMyCubeGrid;
                if (grid == null) throw new InvalidOperationException("not a grid: " + raw);

                var read = AntennaRead.Read(grid);
                readers.Add(read);
                var row = AntennaRead.ToJson(read);
                row["maxRadiusM"] = MaxRadius(grid);
                perGrid.Add(row);
            }

            // Pairwise: direct hear sets plus the relayed (multi-hop) view.
            var pairs = new JArray();
            for (var i = 0; i < readers.Count; i++)
            {
                for (var j = i + 1; j < readers.Count; j++)
                {
                    var a = readers[i];
                    var b = readers[j];
                    var distance = (a.Position - b.Position).Length();

                    var aDirect = Find(a.Hears, b.GridId);
                    var bDirect = Find(b.Hears, a.GridId);
                    var aHearsB = aDirect ?? Find(a.RelayedContacts, b.GridId);
                    var bHearsA = bDirect ?? Find(b.RelayedContacts, a.GridId);

                    string state;
                    if (a.RadioCount == 0 || b.RadioCount == 0) state = "missing-antenna";
                    else if (aHearsB != null && bHearsA != null) state = "linked-both-ways";
                    else if (aHearsB != null || bHearsA != null) state = "linked-one-way";
                    else state = "not-heard";

                    var pair = new JObject
                    {
                        ["a"] = "grid:" + a.GridId,
                        ["b"] = "grid:" + b.GridId,
                        ["distanceM"] = Math.Round(distance, 1),
                        ["aAntennasBroadcasting"] = a.WorkingBroadcasters,
                        ["bAntennasBroadcasting"] = b.WorkingBroadcasters,
                        ["aHearsB"] = aHearsB != null,
                        ["bHearsA"] = bHearsA != null,
                        ["aHearsBDirect"] = aDirect != null,
                        ["bHearsADirect"] = bDirect != null,
                        ["state"] = state,
                    };
                    if (aHearsB != null) pair["aHearsBVia"] = aHearsB.Via;
                    if (bHearsA != null) pair["bHearsAVia"] = bHearsA.Via;
                    if (aHearsB != null) pair["aHearsBAntenna"] = aHearsB.ViaAntenna;
                    if (bHearsA != null) pair["bHearsAAntenna"] = bHearsA.ViaAntenna;
                    pairs.Add(pair);
                }
            }

            var readableGrids = 0;
            foreach (var r in readers)
            {
                var unreadable = 0;
                foreach (var a in r.Antennas)
                {
                    var o = a as JObject;
                    if (o != null && (string)o["state"] == "UNVERIFIED") unreadable++;
                }
                if (unreadable == 0) readableGrids++;
            }

            return new JObject
            {
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["grids"] = perGrid,
                ["pairs"] = pairs,
                ["source"] = "Sandbox.Game.GameSystems.MyAntennaSystem + MyGridRadioSystem (engine antenna state)",
                ["radioState"] = readableGrids == readers.Count ? "readable" : "partial",
                ["pairwiseDirectLink"] = new JObject
                {
                    ["state"] = "readable",
                    ["value"] = pairs,
                    ["method"] = "per-antenna ReceiversInRange / BroadcastersInRange, plus GetAllRelayedBroadcasters",
                },
                ["logicalGroup"] = new JObject
                {
                    ["state"] = "readable",
                    ["semantics"] = "MyCubeGridGroups.Logical (rotor/piston/connector mechanical group). NOT radio reach; kept only for the backend's legacy reader.",
                },
                ["sameLogicalGroup"] = new JObject
                {
                    ["state"] = "unverified-legacy",
                    ["reason"] = "this field used to be quoted as connectivity; it is the mechanical group and is not evidence of a radio link",
                },
                ["note"] = "read-only: no block state written, no order issued",
            };
        }


        protected static AntennaRead.Contact Find(List<AntennaRead.Contact> contacts, long gridId)
        {
            foreach (var c in contacts)
            {
                if (c.GridId == gridId) return c;
            }
            return null;
        }


        /// <summary>Largest antenna radius on the grid (0 when there is none).</summary>
        protected static double MaxRadius(IMyCubeGrid grid)
        {
            double max = 0;
            foreach (var antenna in grid.GetFatBlocks<IMyRadioAntenna>())
            {
                if (antenna == null) continue;
                try { if (antenna.Radius > max) max = antenna.Radius; } catch { }
            }
            return Math.Round(max, 1);
        }


        protected static JObject ReadableField(object value)
        {
            return new JObject { ["state"] = "readable", ["value"] = value == null ? JValue.CreateNull() : JToken.FromObject(value) };
        }


        protected static JObject UnverifiedField(string reason)
        {
            return new JObject { ["state"] = "UNVERIFIED", ["reason"] = reason };
        }


        /// <summary>
        /// Raycast from a point along a direction. Now covers VOXELS as well as
        /// collision bodies: on 01_210_014 `MyAPIGateway.Physics.CastRay` returned
        /// `hit:false` for a straight-down ray over bare planet terrain on the
        /// test server (measured 2026-11-10), because terrain lives in a voxel map
        /// and not in the physics world as a collidable body. LosRay intersects
        /// both and reports which detector fired (`hitBy`, `hitType`).
        /// </summary>
        protected JObject ProbeGround(JObject p)
        {
            var pos = new Vector3D(D(p, "x"), D(p, "y"), D(p, "z"));
            var dir = Vector(p, "direction") ?? new Vector3(0, -1, 0);
            double length = p["length"] != null ? D(p, "length") : 5000;
            var from = pos;
            var to = pos + Vector3D.Normalize(new Vector3D(dir.X, dir.Y, dir.Z)) * length;

            var result = LosRay.Cast(from, to);
            var json = new JObject
            {
                ["hit"] = !result.Clear,
                ["from"] = Vec(from),
                ["to"] = Vec(to),
                ["probeKind"] = "terrain+entity",
            };
            if (result.First != null)
            {
                json["position"] = Vec(result.First.Position);
                json["normal"] = Vec(result.First.Normal);
                json["fraction"] = result.First.Fraction;
                json["entityId"] = result.First.EntityId;
                json["isGrid"] = result.First.Kind == "grid";
                json["hitType"] = result.First.Kind;
                json["hitBy"] = result.First.Source;
                json["distanceM"] = result.DistanceM;
                json["name"] = result.First.Name;
            }
            json["voxelBasesTested"] = result.VoxelBasesTested;
            if (!string.IsNullOrEmpty(result.Note)) json["note"] = result.Note;
            return json;
        }


        /// <summary>
        /// `probe_los {from,to}` — is the straight line between two points clear?
        /// Both ends accept {x,y,z} or a grid id ("grid:…" / entity id) whose
        /// centre is used. Hits are raycast against planet/asteroid voxel maps AND
        /// physics bodies (grids, characters); the nearest one wins and is
        /// returned with distance and type.
        /// </summary>
        protected JObject ProbeLos(JObject p)
        {
            var from = PointFrom(p, "from", "fromEntityId", out var fromError);
            if (fromError != null) throw new InvalidOperationException("params.from: " + fromError);
            var to = PointFrom(p, "to", "toEntityId", out var toError);
            if (toError != null) throw new InvalidOperationException("params.to: " + toError);

            var ignore = new List<long>();
            var ignoreToken = p["ignoreEntityIds"] as JArray;
            if (ignoreToken != null)
            {
                foreach (var t in ignoreToken)
                {
                    long id;
                    if (long.TryParse(t.ToString().Replace("grid:", ""), out id)) ignore.Add(id);
                }
            }
            var single = (string)p["ignoreEntityId"];
            if (!string.IsNullOrEmpty(single))
            {
                long id;
                if (long.TryParse(single.Replace("grid:", ""), out id)) ignore.Add(id);
            }

            var result = LosRay.Cast(from, to, ignore);
            var json = LosRay.ToJson(result);
            json["from"] = Vec(from);
            json["to"] = Vec(to);
            json["ignoredEntityIds"] = new JArray(ignore);
            return json;
        }


        /// <summary>Resolve a {x,y,z} parameter or an entity id to a world point.</summary>
        protected static Vector3D PointFrom(JObject p, string objectKey, string entityKey, out string error)
        {
            error = null;
            var nested = p[objectKey] as JObject;
            if (nested != null)
                return new Vector3D(D(nested, "x"), D(nested, "y"), D(nested, "z"));

            var raw = (string)p[objectKey];
            if (string.IsNullOrEmpty(raw)) raw = (string)p[entityKey];
            if (string.IsNullOrEmpty(raw))
            {
                error = "missing (expected {" + objectKey + ": {x,y,z}} or " + entityKey + ")";
                return Vector3D.Zero;
            }

            long id;
            if (!long.TryParse(raw.Replace("grid:", ""), out id))
            {
                error = "not a coordinate object or entity id: " + raw;
                return Vector3D.Zero;
            }
            IMyEntity entity;
            if (!MyAPIGateway.Entities.TryGetEntityById(id, out entity) || entity == null)
            {
                error = "entity not found: " + raw;
                return Vector3D.Zero;
            }
            return entity.PositionComp.GetPosition();
        }


        /// <summary>Read-only connector table (status, other end, distance).</summary>
        protected JObject ConnectorState(JObject p)
        {
            var ids = p["entityIds"] as JArray;
            if (ids == null)
            {
                var single = RequireGrid(p);
                var one = ConnectorRead.For(single);
                one["grids"] = new JArray(one.DeepClone());
                return one;
            }
            var arr = new JArray();
            foreach (var token in ids)
            {
                long id = long.Parse(token.ToString().Replace("grid:", ""));
                IMyEntity entity;
                if (!MyAPIGateway.Entities.TryGetEntityById(id, out entity)) continue;
                var grid = entity as IMyCubeGrid;
                if (grid == null) continue;
                arr.Add(ConnectorRead.For(grid));
            }
            return new JObject { ["grids"] = arr, ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
        }


        /// <summary>Bring a freshly spawned stand-in to a known powered state.</summary>
        protected JObject Wake(JObject p)
        {
            var grid = RequireGrid(p);
            int antennas = 0, reactors = 0, batteries = 0, controllers = 0, turnedOn = 0, gyros = 0, thrusters = 0;
            string st;
            var notes = new JArray();
            foreach (var a in grid.GetFatBlocks<IMyRadioAntenna>())
            {
                if (a == null) continue;
                if (EnsureEnabled(a, out st)) turnedOn++;
                a.EnableBroadcasting = true;
                antennas++;
            }
            foreach (var r in grid.GetFatBlocks<IMyReactor>())
            {
                if (r == null) continue;
                if (EnsureEnabled(r, out st)) turnedOn++;
                reactors++;
            }
            foreach (var b in grid.GetFatBlocks<IMyBatteryBlock>())
            {
                if (b == null) continue;
                if (EnsureEnabled(b, out st)) turnedOn++;
                batteries++;
            }
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                EnsureEnabled(rc, out st);
                notes.Add(new JObject { ["block"] = "remoteControl", ["name"] = SafeName(rc), ["enable"] = st, ["typeName"] = rc.GetType().FullName });
                rc.DampenersOverride = true;
                controllers++;
            }
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                EnsureEnabled(gyro, out st);
                notes.Add(new JObject { ["block"] = "gyro", ["name"] = SafeName(gyro), ["enable"] = st });
                gyros++;
            }
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                if (EnsureEnabled(thr, out st)) turnedOn++;
                thrusters++;
            }
            _log("info", "wake grid:" + grid.EntityId + " antennas=" + antennas + " reactors=" + reactors +
                " batteries=" + batteries + " rc=" + controllers + " gyros=" + gyros + " thrusters=" + thrusters +
                " turnedOn=" + turnedOn);
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["antennasEnabled"] = antennas,
                ["reactorsEnabled"] = reactors,
                ["batteriesEnabled"] = batteries,
                ["controllers"] = controllers,
                ["gyros"] = gyros,
                ["thrusters"] = thrusters,
                ["blocksTurnedOn"] = turnedOn,
                ["notes"] = notes,
            };
        }


        protected JObject SetDampeners(JObject p)
        {
            var grid = RequireGrid(p);
            bool on = p["on"] == null || (bool)p["on"];
            int applied = 0;
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                rc.DampenersOverride = on;
                applied++;
            }
            if (on) DampenerDeadman.Instance.NoteDampenersOn(grid.EntityId);
            else DampenerDeadman.Instance.NoteDampenersOff(grid.EntityId, PluginOwnsGrid(grid.EntityId), "set_dampeners off");
            return new JObject { ["gridId"] = "grid:" + grid.EntityId, ["dampenersOn"] = on, ["controllers"] = applied };
        }


        // -------------------------------------------------------- dampener dead-man

        /// <summary>Is a plugin-owned job (land / level) flying this grid right now?</summary>
        protected static bool PluginOwnsGrid(long gridId)
        {
            return LandController.Instance.HasActiveJob(gridId) || LevelFlightController.Instance.HasJob(gridId);
        }


        /// <summary>Renew the dampener lease for whatever grid this order names.</summary>
        protected void NoteBackendOrder(JObject p)
        {
            long id;
            if (TryGridId((string)p["gridId"] ?? (string)p["entityId"], out id))
                DampenerDeadman.Instance.NoteOrder(id);
        }


        protected static bool TryGridId(string raw, out long id)
        {
            id = 0;
            if (string.IsNullOrEmpty(raw)) return false;
            return long.TryParse(raw.Replace("grid:", "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out id);
        }


        /// <summary>The grid for an id, or null. Never throws (the dead-man runs in Tick).</summary>
        protected static IMyCubeGrid FindGridEntity(long gridId)
        {
            try
            {
                IMyEntity entity;
                if (!MyAPIGateway.Entities.TryGetEntityById(gridId, out entity) || entity == null) return null;
                return entity as IMyCubeGrid;
            }
            catch { return null; }
        }


        protected JObject DeadmanStatus()
        {
            return new JObject
            {
                ["timeoutSec"] = DampenerDeadman.TimeoutSec,
                ["leased"] = DampenerDeadman.Instance.LeaseCount,
                ["restored"] = DampenerDeadman.Instance.RestoredCount,
            };
        }


        protected JObject ListGrids()
        {
            var arr = new JArray();
            var entities = MyAPIGateway.Entities;
            var raw = new HashSet<IMyEntity>();
            entities.GetEntities(raw, e => e is IMyCubeGrid);
            foreach (var e in raw)
            {
                var g = e as IMyCubeGrid;
                if (g != null && !g.Closed) arr.Add(GridSummary(g));
            }
            return new JObject { ["count"] = arr.Count, ["grids"] = arr };
        }


        protected JObject GridSummary(IMyCubeGrid g)
        {
            var owners = new JArray();
            foreach (var o in g.BigOwners) owners.Add(o.ToString());
            return new JObject
            {
                ["gridId"] = "grid:" + g.EntityId,
                ["name"] = g.DisplayName ?? "",
                ["size"] = g.GridSizeEnum.ToString(),
                ["isStatic"] = g.IsStatic,
                ["massKg"] = g.Physics != null ? (double)g.Physics.Mass : 0,
                ["position"] = Vec(g.PositionComp != null ? g.PositionComp.GetPosition() : Vector3D.Zero),
                ["bigOwners"] = owners,
            };
        }


        // ------------------------------------------------- T6 designer actions

        /// <summary>
        /// Owner-tagged grids: any grid with a programmable block whose custom
        /// name contains `tag` (default [HERMES-TEST]). Each grid is profiled
        /// live with the same block scan as `profile`; nothing is inferred.
        /// </summary>
        /// <summary>
        /// Owner tags this harness understands. `[HERMES-BASE]` = control station,
        /// `[HERMES-TEST]` = drone / satellite hull.
        /// </summary>
        internal static readonly string[] OwnerTags = { "[HERMES-BASE]", "[HERMES-TEST]" };

        /// <summary>
        /// Every role hint on a grid: a token in any block's CustomName, or a
        /// `HERMES_ROLE=personal|base|off|managed` line in any block's CustomData.
        /// `list_tagged` and `inspect` parse this inside their own single block
        /// pass (via `ShipRoleTags.Parse`), so there is no extra grid walk here.
        /// </summary>
        private static void AddRoleHint(JArray hints, HashSet<string> seen, ShipRoleTags.Hint hint)
        {
            var key = hint.Role + "|" + hint.Source + "|" + hint.Token + "|" + hint.Block;
            if (!seen.Add(key)) return;
            hints.Add(new JObject
            {
                ["role"] = hint.Role,
                ["token"] = hint.Token,
                ["source"] = hint.Source,
                ["block"] = hint.Block,
            });
        }

        /// <summary>Distinct roles from a hint array, for `roleTags` / `role`.</summary>
        private static List<string> RoleTagList(JArray hints)
        {
            var roles = new List<string>();
            foreach (var h in hints)
            {
                var r = (string)h["role"];
                if (!string.IsNullOrEmpty(r) && !roles.Contains(r)) roles.Add(r);
            }
            return roles;
        }


        protected JObject ListTagged(JObject p)
        {
            // Back-compatible: an explicit `tag` filters to that one tag. With no
            // tag (and no `tags` array) every known owner tag is returned, so one
            // poll sees both the control station and the drone hulls.
            var wanted = new List<string>();
            var explicitFilter = false;
            if (p["tags"] is JArray ta)
            {
                explicitFilter = true;
                foreach (var t in ta) if (!string.IsNullOrWhiteSpace(t.ToString())) wanted.Add(t.ToString().Trim());
            }
            var single = (string)p["tag"];
            if (!string.IsNullOrWhiteSpace(single)) { wanted.Add(single.Trim()); explicitFilter = true; }
            if (wanted.Count == 0) wanted.AddRange(OwnerTags);
            string tag = wanted.Count == 1 ? wanted[0] : string.Join("|", wanted);
            // De-fanned (sim-speed audit #1): identity, counts and role tags come
            // from ONE block pass with no per-block JObject. The old shape nested
            // a full `profile` per tagged grid, which was 75 % of all plugin
            // profile work (17 profiles = 134 ms inside one tick). Callers that
            // genuinely need thrust/TWR/gravity ask for `withProfile: true`.
            bool withProfile = false;
            try { withProfile = p["withProfile"] != null && p.Value<bool>("withProfile"); } catch { }

            var grids = new JArray();
            var raw = new HashSet<IMyEntity>();
            MyAPIGateway.Entities.GetEntities(raw, e => e is IMyCubeGrid);
            foreach (var e in raw)
            {
                var grid = e as IMyCubeGrid;
                if (grid == null || grid.Closed) continue;

                var matches = new JArray();
                var gridTags = new JArray();
                string pbName = null;
                int radioCount = 0, laserCount = 0;
                double radioMax = 0, laserMax = 0;
                // Role tags ride on block CustomName/CustomData (roles backend) and
                // are parsed in THIS pass — one GetBlocks enumeration, no nested
                // Profile and no second walk of the grid.
                var roleHints = new JArray();
                var roleSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                // Block custom name/data, capped so a huge grid cannot turn this
                // read into a profile.
                var roleBlocks = new JArray();

                var slimBlocks = new List<IMySlimBlock>();
                grid.GetBlocks(slimBlocks);
                foreach (var slim in slimBlocks)
                {
                    var fat = slim.FatBlock;
                    if (fat == null) continue;
                    var terminal = fat as IMyTerminalBlock;
                    string customName = terminal != null ? (terminal.CustomName ?? "") : "";
                    string customData = terminal != null ? (terminal.CustomData ?? "") : "";

                    var pb = fat as IMyProgrammableBlock;
                    if (pb != null && customName.Length > 0)
                    {
                        foreach (var t in wanted)
                        {
                            if (customName.IndexOf(t, StringComparison.OrdinalIgnoreCase) < 0) continue;
                            if (!matches.Contains(customName)) matches.Add(customName);
                            if (!gridTags.Contains(t)) gridTags.Add(t);
                            if (pbName == null) pbName = customName;
                        }
                    }

                    var antenna = fat as IMyRadioAntenna;
                    if (antenna != null)
                    {
                        radioCount++;
                        double radius = antenna.Radius;
                        if (radius > radioMax) radioMax = radius;
                    }
                    var laser = fat as IMyLaserAntenna;
                    if (laser != null)
                    {
                        laserCount++;
                        double range = laser.Range;
                        if (range > laserMax) laserMax = range;
                    }

                    if (roleBlocks.Count < 64 && (customData.Length > 0 || customName.IndexOf("[", StringComparison.Ordinal) >= 0))
                    {
                        roleBlocks.Add(new JObject
                        {
                            ["id"] = "block:" + fat.EntityId,
                            ["name"] = customName,
                            ["customName"] = customName,
                            ["customData"] = customData,
                            ["subtype"] = slim.BlockDefinition != null ? slim.BlockDefinition.Id.SubtypeName : "",
                        });
                    }

                    // Roles: ANY block can carry the tag, not just the PB. The
                    // cheap pre-check keeps a grid of plain blocks at two
                    // IndexOf calls; the parser only runs on a possible hit
                    // (every token starts with `[`) or a `HERMES_ROLE=` line.
                    if (customName.IndexOf('[') >= 0 || customName.IndexOf("hermes_role", StringComparison.OrdinalIgnoreCase) >= 0)
                        foreach (var hint in ShipRoleTags.Parse(customName, "block-name", customName))
                            AddRoleHint(roleHints, roleSeen, hint);
                    if (customData.Length > 0 && (customData.IndexOf('[') >= 0 || customData.IndexOf("hermes_role", StringComparison.OrdinalIgnoreCase) >= 0))
                        foreach (var hint in ShipRoleTags.Parse(customData, "custom-data", customName))
                            AddRoleHint(roleHints, roleSeen, hint);
                }
                // A role tag on any block is enough to list the grid, but only
                // when no explicit tag filter was asked for: the designer's
                // `tag: [HERMES-TEST]` call keeps its exact meaning.
                if (matches.Count == 0 && (explicitFilter || roleHints.Count == 0)) continue;
                var roleTags = RoleTagList(roleHints);
                string roleWorst = ShipRoleTags.Worst(roleTags);

                var owners = new JArray();
                foreach (var o in grid.BigOwners) owners.Add(o.ToString());
                // T79: the faction tag of each big owner, so the live ownership
                // rule can accept a grid owned by a faction-mate. Same legitimate
                // read Ownership.cs uses; a failed lookup is null, never a guess.
                var ownerFactions = new JArray();
                var factions = MyAPIGateway.Session.Factions;
                foreach (var o in grid.BigOwners)
                {
                    try
                    {
                        var f = factions != null ? factions.TryGetPlayerFaction(o) : null;
                        ownerFactions.Add(f == null ? (JToken)JValue.CreateNull() : f.Tag);
                    }
                    catch { ownerFactions.Add(JValue.CreateNull()); }
                }

                // Only the optional path pays for a profile now, and only for a
                // grid the caller asked about.
                JObject prof = withProfile ? Profile(new JObject { ["entityId"] = "grid:" + grid.EntityId }) : null;
                double atmo = 0, ion = 0, h2 = 0;
                if (prof != null && prof["thrusters"] is JObject thrusters)
                {
                    atmo = (double)thrusters["atmoN"];
                    ion = (double)thrusters["ionN"];
                    h2 = (double)thrusters["h2N"];
                }
                double massKg = prof != null
                    ? (double)prof["massKg"]
                    : (grid.Physics != null ? (double)grid.Physics.Mass : 0);

                grids.Add(new JObject
                {
                    ["gridId"] = "grid:" + grid.EntityId,
                    ["name"] = grid.DisplayName ?? "",
                    ["tags"] = gridTags,
                    ["isStatic"] = grid.IsStatic,
                    ["lockedBy"] = LockedBy(grid),
                    ["tag"] = gridTags.Count > 0 ? gridTags[0] : null,
                    ["owner"] = grid.BigOwners.Count > 0 ? grid.BigOwners[0].ToString() : null,
                    ["owners"] = owners,
                    ["ownerFactions"] = ownerFactions,
                    ["pbName"] = pbName,
                    ["roleHints"] = roleHints,
                    ["roleTags"] = new JArray(roleTags),
                    ["role"] = roleWorst,
                    ["position"] = Vec(grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero),
                    ["matchedBlocks"] = matches,
                    // Block custom name/data for role tags: always present, cheap.
                    ["blocks"] = roleBlocks,
                    ["radioRangeM"] = radioMax > 0 ? (JToken)radioMax : JValue.CreateNull(),
                    ["radioCount"] = radioCount,
                    ["laserCount"] = laserCount,
                    ["laserRangeM"] = laserMax > 0 ? (JToken)laserMax : JValue.CreateNull(),
                    // Profile-derived scalars: null unless `withProfile` was asked.
                    ["thrust"] = prof != null
                        ? (JToken)new JObject { ["atmo"] = Math.Round(atmo, 0), ["ion"] = Math.Round(ion, 0), ["h2"] = Math.Round(h2, 0) }
                        : JValue.CreateNull(),
                    ["massKg"] = massKg,
                    ["twr"] = prof != null ? prof["twr"] : JValue.CreateNull(),
                    ["gravityMs2"] = prof != null && prof["gravity"] != null ? prof["gravity"]["magnitudeMs2"] : JValue.CreateNull(),
                    ["canGroundLaunch"] = prof != null ? (JToken)(atmo > 0 || h2 > 0) : JValue.CreateNull(),
                    ["blocksTotal"] = slimBlocks.Count,
                    ["profiled"] = prof != null,
                    ["notes"] = prof != null
                        ? "live profile of an owner-tagged grid; TWR and gravity are sampled at its current position"
                        : "cheap scan: identity, block counts and role tags (pass withProfile:true for thrust/TWR/gravity)",
                });
            }
            _log("info", "list_tagged " + tag + ": " + grids.Count + " grid(s)" + (withProfile ? " (withProfile)" : ""));
            return new JObject { ["tag"] = tag, ["count"] = grids.Count, ["grids"] = grids };
        }


        // ------------------------------------------------- generic block properties

        /// <summary>
        /// Data-driven configuration (test server): apply terminal properties and
        /// actions to every block matching `filter`. Property ids are validated
        /// against the block's own GetProperties() list, so a typo is reported per
        /// block instead of being silently dropped, and every value is read back
        /// after the write. `$max` / `$min` resolve to the property's own range, so
        /// "as far as this block goes" never needs a hard-coded number.
        /// </summary>
        protected JObject SetBlockProps(JObject p)
        {
            var grid = RequireGrid(p);
            var filter = p["filter"] as JObject ?? new JObject();
            var props = p["props"] as JObject ?? new JObject();
            var actionIds = new List<string>(BlockFilter.Terms(p["actions"]));

            var blocks = new JArray();
            int applied = 0, failed = 0;
            foreach (var fb in MatchingBlocks(grid, filter))
            {
                var terminal = fb as IMyTerminalBlock;
                var ingame = fb as Sandbox.ModAPI.Ingame.IMyTerminalBlock;
                if (terminal == null || ingame == null) continue;

                var entry = new JObject
                {
                    ["entityId"] = fb.EntityId.ToString(),
                    ["name"] = SafeName(fb),
                    ["subtype"] = SubtypeOf(fb),
                    ["type"] = TypeIdOf(fb),
                    ["props"] = new JArray(),
                    ["actions"] = new JArray(),
                    ["errors"] = new JArray(),
                };
                var propsOut = (JArray)entry["props"];
                var actionsOut = (JArray)entry["actions"];
                var errors = (JArray)entry["errors"];

                foreach (var kv in props.Properties())
                {
                    var prop = ingame.GetProperty(kv.Name);
                    if (prop == null)
                    {
                        errors.Add("unknown property \"" + kv.Name + "\" (validate with get_block_props)");
                        continue;
                    }
                    var before = PropValue(fb, prop);
                    string error;
                    if (!ApplyProp(fb, prop, kv.Value, out error))
                    {
                        errors.Add(kv.Name + ": " + error);
                        continue;
                    }
                    var after = PropValue(fb, prop);
                    var row = new JObject
                    {
                        ["id"] = kv.Name,
                        ["type"] = prop.TypeName,
                        ["kind"] = before["kind"],
                        ["before"] = before["value"],
                        ["after"] = after["value"],
                    };
                    if (before["min"] != null) row["min"] = before["min"];
                    if (before["max"] != null) row["max"] = before["max"];
                    propsOut.Add(row);
                    if (JToken.DeepEquals(before["value"], after["value"])) applied++;
                    else applied++;
                }

                foreach (var id in actionIds)
                {
                    var act = ingame.GetActionWithName(id);
                    if (act == null)
                    {
                        errors.Add("unknown action \"" + id + "\"");
                        continue;
                    }
                    var enabled = act.IsEnabled(terminal);
                    act.Apply(terminal);
                    actionsOut.Add(new JObject { ["id"] = id, ["applied"] = true, ["wasEnabled"] = enabled });
                    applied++;
                }

                if (errors.Count > 0) failed++;
                blocks.Add(entry);
            }

            _log("info", "set_block_props grid:" + grid.EntityId + " -> " + blocks.Count + " block(s), " + applied + " change(s)");
            // Dampeners set through a raw property write arm/disarm the dead-man
            // exactly like `set_dampeners` does (the backend uses both).
            var dampeners = props["DampenersOverride"];
            if (dampeners != null && dampeners.Type == JTokenType.Boolean)
            {
                if ((bool)dampeners) DampenerDeadman.Instance.NoteDampenersOn(grid.EntityId);
                else DampenerDeadman.Instance.NoteDampenersOff(
                    grid.EntityId, PluginOwnsGrid(grid.EntityId), "set_block_props DampenersOverride:false");
            }
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["filter"] = filter,
                ["requested"] = new JObject { ["props"] = props, ["actions"] = new JArray(actionIds) },
                ["count"] = blocks.Count,
                ["applied"] = applied,
                ["blocksWithErrors"] = failed,
                ["blocks"] = blocks,
            };
        }


        /// <summary>
        /// Read the terminal property inventory of the blocks matching `filter`.
        /// This is the source of truth for property ids and their legal range.
        /// </summary>
        protected JObject GetBlockProps(JObject p)
        {
            var grid = RequireGrid(p);
            var filter = p["filter"] as JObject ?? new JObject();
            var only = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (p["ids"] is JArray ia) foreach (var i in ia) only.Add(i.ToString());

            var blocks = new JArray();
            foreach (var fb in MatchingBlocks(grid, filter))
            {
                var ingame = fb as Sandbox.ModAPI.Ingame.IMyTerminalBlock;
                if (ingame == null) continue;
                var props = new List<ITerminalProperty>();
                ingame.GetProperties(props, null);
                var arr = new JArray();
                foreach (var prop in props)
                {
                    if (only.Count > 0 && !only.Contains(prop.Id)) continue;
                    var v = PropValue(fb, prop);
                    var row = new JObject
                    {
                        ["id"] = prop.Id,
                        ["type"] = prop.TypeName,
                        ["kind"] = v["kind"],
                        ["value"] = v["value"],
                    };
                    if (v["min"] != null) row["min"] = v["min"];
                    if (v["max"] != null) row["max"] = v["max"];
                    arr.Add(row);
                }
                var actions = new JArray();
                var acts = new List<ITerminalAction>();
                ingame.GetActions(acts, null);
                foreach (var a in acts) actions.Add(a.Id);
                blocks.Add(new JObject
                {
                    ["entityId"] = fb.EntityId.ToString(),
                    ["name"] = SafeName(fb),
                    ["subtype"] = SubtypeOf(fb),
                    ["type"] = TypeIdOf(fb),
                    ["props"] = arr,
                    ["actions"] = actions,
                });
            }
            return new JObject { ["gridId"] = "grid:" + grid.EntityId, ["count"] = blocks.Count, ["blocks"] = blocks };
        }


        /// <summary>Read one property as a JSON value plus its legal range.</summary>
        protected static JObject PropValue(IMyCubeBlock block, ITerminalProperty prop)
        {
            var row = new JObject { ["kind"] = "unsupported", ["value"] = null };
            try
            {
                var b = prop.AsBool();
                if (b != null)
                {
                    row["kind"] = "bool";
                    row["value"] = b.GetValue(block);
                    return row;
                }
                var f = prop.AsFloat();
                if (f != null)
                {
                    row["kind"] = "float";
                    row["value"] = Math.Round((double)f.GetValue(block), 4);
                    row["min"] = Math.Round((double)f.GetMinimum(block), 4);
                    row["max"] = Math.Round((double)f.GetMaximum(block), 4);
                    return row;
                }
                var c = prop.AsColor();
                if (c != null)
                {
                    var col = c.GetValue(block);
                    row["kind"] = "color";
                    row["value"] = col.R.ToString("X2") + col.G.ToString("X2") + col.B.ToString("X2");
                    return row;
                }
            }
            catch (Exception ex)
            {
                row["kind"] = "error";
                row["value"] = ex.Message;
                return row;
            }
            row["kind"] = prop.TypeName ?? "unknown";
            return row;
        }


        /// <summary>
        /// Write one property. Numeric values are clamped to the block's own
        /// minimum/maximum, so a caller can never push a value the terminal
        /// itself would refuse (e.g. antenna radius above the block's max).
        /// </summary>
        protected static bool ApplyProp(IMyCubeBlock block, ITerminalProperty prop, JToken want, out string error)
        {
            error = null;
            var b = prop.AsBool();
            if (b != null)
            {
                bool v;
                if (want.Type == JTokenType.Boolean) v = (bool)want;
                else if (!bool.TryParse(want.ToString().Trim(), out v))
                {
                    error = "not a boolean";
                    return false;
                }
                b.SetValue(block, v);
                return true;
            }
            var f = prop.AsFloat();
            if (f != null)
            {
                var text = want.ToString().Trim();
                double d;
                if (text.Equals("$max", StringComparison.OrdinalIgnoreCase)) d = f.GetMaximum(block);
                else if (text.Equals("$min", StringComparison.OrdinalIgnoreCase)) d = f.GetMinimum(block);
                else if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                {
                    error = "not a number";
                    return false;
                }
                var max = (double)f.GetMaximum(block);
                var min = (double)f.GetMinimum(block);
                if (max > min)
                {
                    if (d > max) d = max;
                    if (d < min) d = min;
                }
                f.SetValue(block, (float)d);
                return true;
            }
            var c = prop.AsColor();
            if (c != null)
            {
                string hex = want.ToString().Trim().TrimStart('#');
                uint packed;
                if (hex.Length != 6 || !uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out packed))
                {
                    error = "color must be RRGGBB";
                    return false;
                }
                c.SetValue(block, new VRageMath.Color((int)((packed >> 16) & 0xFF), (int)((packed >> 8) & 0xFF), (int)(packed & 0xFF)));
                return true;
            }
            error = "property type \"" + prop.TypeName + "\" is not writable here";
            return false;
        }


        /// <summary>
        /// Blocks of `grid` matching `filter` {type?, subtype?, nameContains?}.
        ///
        /// Every term accepts ONE string or an ARRAY of strings (OR within a
        /// term). A plain `(string)` cast on an array threw
        /// `ArgumentException: Can not convert Array to String` and refused the
        /// whole order - that is what broke the backend's touchdown gear lock
        /// (`{"type":["LandingGear","MagneticPlate"]}`) on 2026-11-10.
        /// </summary>
        protected static List<IMyCubeBlock> MatchingBlocks(IMyCubeGrid grid, JObject filter)
        {
            var types = BlockFilter.Terms(filter["type"]);
            var subtypes = BlockFilter.Terms(filter["subtype"]);
            var nameTerms = BlockFilter.Terms(filter["nameContains"]);
            var slim = new List<IMySlimBlock>();
            grid.GetBlocks(slim);
            var result = new List<IMyCubeBlock>();
            foreach (var s in slim)
            {
                var fb = s.FatBlock;
                if (fb == null) continue;
                if (types.Length > 0 && !TypeMatchesAny(fb, types)) continue;
                if (!BlockFilter.AnyMatch(SubtypeOf(fb), subtypes, StringComparison.OrdinalIgnoreCase)) continue;
                if (!BlockFilter.AnyMatch(SafeName(fb), nameTerms, StringComparison.OrdinalIgnoreCase)) continue;
                result.Add(fb);
            }
            return result;
        }


        protected static bool TypeMatchesAny(IMyCubeBlock fb, string[] types)
        {
            for (var i = 0; i < types.Length; i++)
            {
                if (TypeMatches(fb, types[i])) return true;
            }
            return false;
        }


        /// <summary>
        /// `type` accepts a functional name ("RadioAntenna", "RemoteControl",
        /// "Battery", "Thruster", "Gyro", "ProgrammableBlock", ...), a block class
        /// name, or an object-builder TypeId ("MyObjectBuilder_RadioAntenna").
        /// </summary>
        protected static bool TypeMatches(IMyCubeBlock fb, string type)
        {
            string t = type.Trim();
            if (t.StartsWith("MyObjectBuilder_", StringComparison.OrdinalIgnoreCase)) t = t.Substring("MyObjectBuilder_".Length);
            bool Eq(string s) { return t.Equals(s, StringComparison.OrdinalIgnoreCase); }

            if (Eq("RadioAntenna") && fb is IMyRadioAntenna) return true;
            if (Eq("LaserAntenna") && fb is IMyLaserAntenna) return true;
            if (Eq("RemoteControl") && fb is IMyRemoteControl) return true;
            if (Eq("Battery") && fb is IMyBatteryBlock) return true;
            if (Eq("Thruster") && fb is IMyThrust) return true;
            if (Eq("Gyro") && fb is IMyGyro) return true;
            if (Eq("ProgrammableBlock") && fb is IMyProgrammableBlock) return true;
            if (Eq("Reactor") && fb is IMyReactor) return true;
            if (Eq("GasTank") && fb is IMyGasTank) return true;
            if (Eq("Cockpit") && fb is IMyCockpit) return true;

            var typeId = TypeIdOf(fb);
            if (typeId.StartsWith("MyObjectBuilder_", StringComparison.OrdinalIgnoreCase))
                typeId = typeId.Substring("MyObjectBuilder_".Length);
            if (typeId.Equals(t, StringComparison.OrdinalIgnoreCase)) return true;
            var cls = fb.GetType().Name;
            return cls.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0 ||
                   typeId.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0;
        }


        protected static string SubtypeOf(IMyCubeBlock fb)
        {
            try
            {
                return fb.BlockDefinition.SubtypeName ?? "";
            }
            catch { return ""; }
        }


        protected static string TypeIdOf(IMyCubeBlock fb)
        {
            try
            {
                return fb.BlockDefinition.TypeId.ToString() ?? "";
            }
            catch { return ""; }
        }


        /// <summary>
        /// Static grid -> dynamic ship (test server, launch preflight only). The
        /// caller decides when; this action only performs the conversion and
        /// reports the before/after state so the executor can verify it.
        /// </summary>
        protected JObject ConvertToShip(JObject p)
        {
            var grid = RequireGrid(p);
            bool before = grid.IsStatic;
            bool converted = false;
            string method = before ? "IsStatic=false" : "already-dynamic";
            if (before)
            {
                try
                {
                    grid.IsStatic = false;
                    if (grid.IsStatic)
                    {
                        // Some builds need the concrete conversion call as well.
                        var m = grid.GetType().GetMethod("OnConvertToDynamic", Type.EmptyTypes);
                        if (m != null) { m.Invoke(grid, null); method += "+OnConvertToDynamic"; }
                    }
                    converted = !grid.IsStatic;
                }
                catch (Exception ex)
                {
                    method += " error=" + ex.GetType().Name + ": " + ex.Message;
                }
            }
            double mass = grid.Physics != null ? grid.Physics.Mass : 0f;
            _log("info", "convert_to_ship grid:" + grid.EntityId + " static " + before + "->" + grid.IsStatic +
                " mass=" + Math.Round(mass, 1) + " method=" + method);
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["isStaticBefore"] = before,
                ["isStaticAfter"] = grid.IsStatic,
                ["converted"] = converted,
                ["physicsPresent"] = grid.Physics != null,
                ["massKg"] = Math.Round(mass, 1),
                ["method"] = method,
            };
        }


        /// <summary>
        /// T18: turn a flying grid into a static grid (station mode). A static
        /// grid has no physics drive, so a relay parked inside gravity costs no
        /// thrust, no fuel and no sim time. Refused while moving faster than
        /// 0.5 m/s or within 100 m of the ground unless `force` is set: a station
        /// that is converted mid-fall stays where it was, not where it was going.
        /// </summary>
        protected JObject ConvertToStation(JObject p)
        {
            // Only THIS block (read velocity/velocity guard/IsStatic/ack) is
            // test-server behaviour. The stop sequence a survival build is
            // allowed to use lives in StationConverter.cs, and is chosen by
            // the `zone` parameter: "survival" -> dampeners only, never zeroing
            // the velocity (which is a teleport). The test build keeps the old
            // path as the default so existing harness scripts are unchanged.
            var grid = RequireGrid(p);
            var zone = (string)p["zone"];
            var survival = _survivalMode || (zone != null && zone == "survival");
            if (survival)
                return SurvivalStationConverter.Convert(grid, p, _log);
            return ConvertToStationTestPath(grid, p);
        }


        /// <summary>
        /// T27/T61: is a real PILOT flying this grid? The compat boolean is true
        /// only for an occupied controller that can actually control the ship (or
        /// a Remote Control being driven); a seated passenger is reported in
        /// `passengers` and does NOT count.
        /// </summary>
        protected JObject IsUnderControlAction(JObject p)
        {
            var grid = RequireGrid(p);
            var control = ControlState(grid);
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["underControl"] = control["underControl"],
                ["by"] = control["by"],
                ["pilot"] = control["pilot"],
                ["passengers"] = control["passengers"],
                ["aboard"] = control["aboard"],
                ["carryingPassengers"] = control["carryingPassengers"],
                ["standingAboard"] = control["standingAboard"],
                ["control"] = control,
                ["isStatic"] = grid.IsStatic,
                ["levelJob"] = LevelFlightController.Instance.StatusOne(grid.EntityId),
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }


        protected JObject LevelHold(JObject p)
        {
            var grid = RequireGrid(p);
            LevelFlightController.Instance.SetLogger(_log);
            double? alt = p["altitudeAglM"] != null ? D(p, "altitudeAglM") : (double?)null;
            double? tilt = p["maxTiltDeg"] != null ? D(p, "maxTiltDeg") : (double?)null;
            return LevelFlightController.Instance.StartHold(grid.EntityId, alt, tilt);
        }


        protected JObject LevelMove(JObject p)
        {
            var grid = RequireGrid(p);
            LevelFlightController.Instance.SetLogger(_log);
            double? alt = p["altitudeAglM"] != null ? D(p, "altitudeAglM") : (double?)null;
            double? tilt = p["maxTiltDeg"] != null ? D(p, "maxTiltDeg") : (double?)null;
            var lat = p["maxLateralMps"] != null ? D(p, "maxLateralMps") : 3.0;
            return LevelFlightController.Instance.StartMove(grid.EntityId, D(p, "x"), D(p, "y"), D(p, "z"), lat, alt, tilt);
        }


        protected JObject LevelStop(JObject p)
        {
            var grid = RequireGrid(p);
            return LevelFlightController.Instance.Stop(grid.EntityId, (string)p["reason"] ?? "level_stop");
        }


        protected JObject LevelStatus(JObject p)
        {
            var raw = (string)p["gridId"];
            if (!string.IsNullOrEmpty(raw))
            {
                long id;
                if (long.TryParse(raw.Replace("grid:", ""), out id))
                    return LevelFlightController.Instance.StatusOne(id);
            }
            return LevelFlightController.Instance.StatusAll();
        }


        /// <summary>
        /// `land_at`: hand the final descent to a per-tick game-thread controller.
        /// The order carries the ground radius at the column and the signed keel
        /// depth; everything else (sink schedule, touchdown, aborts) is the
        /// controller's, so this is the ONE order a landing needs.
        /// </summary>
        protected JObject LandAt(JObject p)
        {
            var grid = RequireGrid(p);
            LandController.Instance.SetLogger(_log);
            // A plugin job owns this grid's dampeners and overrides from now on:
            // it must not be treated as an unowned "dampeners off" lease.
            DampenerDeadman.Instance.NoteOwned(grid.EntityId);
            var groundRadiusM = D(p, "groundRadiusM");
            var keelDepthM = p["keelDepthM"] != null ? D(p, "keelDepthM") : GridGeometry.KeelDepthM(grid);
            var sinkMps = p["sinkMps"] != null ? D(p, "sinkMps") : 5.0;
            var finalSinkMps = p["finalSinkMps"] != null ? D(p, "finalSinkMps") : 0.4;
            var finalBandM = p["finalBandM"] != null ? D(p, "finalBandM") : 15.0;
            // Optional: the free-fall speed cap. 0/absent means the controller's
            // default (100 m/s), NOT "no cap" - an uncapped fall is how a hull
            // reaches the ground before its brake point can move up.
            var maxFallMps = p["maxFallMps"] != null ? D(p, "maxFallMps") : 0.0;
            // Optional: the REQUESTED landing column (2026-11-11 flight set 5).
            // `targetPosition {x,y,z}` (what the backend sends) or flat
            // `targetX/Y/Z`; absent means "hold the handover column" exactly as
            // before. The controller refuses a target beyond its hold cap with a
            // plain reason, so an old/new backend can never make it chase a far
            // point with tilt.
            Vector3D? target = null;
            var nested = p["targetPosition"] as JObject;
            if (nested != null)
                target = new Vector3D(D(nested, "x"), D(nested, "y"), D(nested, "z"));
            else if (p["targetX"] != null && p["targetY"] != null && p["targetZ"] != null)
                target = new Vector3D(D(p, "targetX"), D(p, "targetY"), D(p, "targetZ"));
            return LandController.Instance.Start(
                grid.EntityId, groundRadiusM, keelDepthM, sinkMps, finalSinkMps, finalBandM, maxFallMps, target);
        }


        /// <summary>
        /// `land_ground { gridId, groundRadiusM }`: the LIVE ground datum for a
        /// running `land_at` job (defect b). The backend re-samples the height
        /// field at the hull's current column during the descent and sends the
        /// new radius; the controller re-derives its AGL from it on the next
        /// tick, so the brake and touchdown decisions are never made on the
        /// ground under the column the handover happened on.
        /// </summary>
        protected JObject LandGround(JObject p)
        {
            var grid = RequireGrid(p);
            var groundRadiusM = D(p, "groundRadiusM");
            LandController.Instance.SetLogger(_log);
            return LandController.Instance.UpdateGround(grid.EntityId, groundRadiusM);
        }


        protected JObject LandStatus(JObject p)
        {
            var raw = (string)p["gridId"] ?? (string)p["entityId"];
            if (!string.IsNullOrEmpty(raw))
            {
                long id;
                if (long.TryParse(raw.Replace("grid:", ""), out id))
                    return LandController.Instance.StatusOne(id);
            }
            return LandController.Instance.StatusAll();
        }


        protected JObject LandStop(JObject p)
        {
            var grid = RequireGrid(p);
            return LandController.Instance.Stop(grid.EntityId, (string)p["reason"] ?? "land_stop");
        }


        /// <summary>Power a block asks from the grid (MW), read from its resource sink.</summary>
        protected static double SinkDrawMw(IMyCubeBlock block, VRage.Game.MyDefinitionId electricityId)
        {
            try
            {
                var fb = block as Sandbox.Game.Entities.Cube.MyFunctionalBlock;
                if (fb == null || fb.ResourceSink == null) return 0;
                return fb.ResourceSink.CurrentInputByType(electricityId);
            }
            catch { return 0; }
        }


        /// <summary>
        /// One gas tank as a JSON row. Never returns a made-up fill: a tank that
        /// throws is reported as `readState: "unread"` with the engine error, so
        /// the site can show "—" instead of "0 L".
        /// </summary>
        protected static JObject ReadTank(IMyGasTank tank, string container, out JObject error)
        {
            error = null;
            var entry = new JObject
            {
                ["name"] = SafeName(tank),
                ["container"] = container,
            };
            try
            {
                entry["subtype"] = tank.BlockDefinition.SubtypeName ?? "";
                entry["filledRatio"] = Math.Round(tank.FilledRatio, 4);
                entry["capacity"] = tank.Capacity;
                entry["filledL"] = Math.Round(tank.Capacity * tank.FilledRatio, 1);
                entry["stockpile"] = tank.Stockpile;
                entry["readState"] = "read";
            }
            catch (Exception ex)
            {
                entry["subtype"] = entry["subtype"] ?? "";
                entry["filledRatio"] = JValue.CreateNull();
                entry["filledL"] = JValue.CreateNull();
                entry["capacity"] = JValue.CreateNull();
                entry["stockpile"] = false;
                entry["readState"] = "unread";
                entry["unreadReason"] = ex.GetType().Name + ": " + ex.Message;
                error = new JObject
                {
                    ["block"] = SafeName(tank),
                    ["subtype"] = (string)entry["subtype"] ?? "",
                    ["error"] = (string)entry["unreadReason"],
                };
            }
            return entry;
        }


        /// <summary>Hydrogen tanks only (an oxygen tank is not fuel).</summary>
        protected static int H2TankCount(JArray tanks)
        {
            int n = 0;
            foreach (var t in tanks)
            {
                var sub = (string)t["subtype"] ?? "";
                if (sub.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) >= 0) n++;
            }
            return n;
        }


        /// <summary>
        /// Every grid physically joined to `root` (rotor, piston, hinge, wheel,
        /// connector). Power and fuel blocks can sit on those sub-grids; reading
        /// only the main grid made a docked tank look empty.
        /// </summary>
        protected static List<IMyCubeGrid> ConstructGrids(IMyCubeGrid root)
        {
            var list = new List<IMyCubeGrid>();
            try
            {
                var group = root.GetGridGroup(GridLinkTypeEnum.Physical);
                if (group != null)
                {
                    var grids = new List<IMyCubeGrid>();
                    group.GetGrids(grids);
                    foreach (var g in grids)
                        if (g != null && !g.Closed) list.Add(g);
                }
            }
            catch { /* no group: the main grid is the whole construct */ }
            if (list.Count == 0) list.Add(root);
            return list;
        }


        protected static double H2FillPct(JArray tanks)
        {
            double? min = null;
            foreach (var t in tanks)
            {
                var sub = (string)t["subtype"] ?? "";
                if (sub.IndexOf("Hydrogen", StringComparison.OrdinalIgnoreCase) < 0) continue;
                var f = t["filledRatio"];
                if (f == null || f.Type == JTokenType.Null) continue;
                var ratio = (double)f;
                if (min == null || ratio < min.Value) min = ratio;
            }
            return min.HasValue ? Math.Round(min.Value * 100.0, 1) : -1;
        }


        /// <summary>
        /// T61: the classified control state of one grid. `underControl` stays
        /// for compatibility but is true ONLY for a real pilot (a controller
        /// whose CanControlShip is true and which is occupied, or a Remote
        /// Control a player is driving). A seated passenger is reported in
        /// `passengers`, and a player standing inside the hull in `aboard`, so
        /// neither silences the executor any more.
        /// </summary>
        protected static JObject ControlState(IMyCubeGrid grid)
        {
            var report = ControlReport.Classify(grid, ControlReport.ScanPlayers(null));
            var json = report.ToJson();
            json["levelJobActive"] = LevelFlightController.Instance.HasJob(grid.EntityId);
            return json;
        }


        /// <summary>
        /// Landing gears (locked count) and connectors (connected count) on a grid,
        /// read from the Ingame block interfaces; nothing is locked or unlocked.
        /// </summary>
        protected static JObject LockedBy(IMyCubeGrid grid)
        {
            int gears = 0, gearsLocked = 0, connectors = 0, connectorsConnected = 0;
            foreach (var block in grid.GetFatBlocks<Sandbox.Game.Entities.MyCubeBlock>())
            {
                if (block == null) continue;
                var gear = block as SpaceEngineers.Game.ModAPI.Ingame.IMyLandingGear;
                if (gear != null)
                {
                    gears++;
                    if (gear.IsLocked) gearsLocked++;
                    continue;
                }
                var conn = block as Sandbox.ModAPI.Ingame.IMyShipConnector;
                if (conn != null)
                {
                    connectors++;
                    if (conn.IsConnected) connectorsConnected++;
                }
            }
            return new JObject
            {
                ["landingGears"] = gears,
                ["landingGearsLocked"] = gearsLocked,
                ["connectors"] = connectors,
                ["connectorsConnected"] = connectorsConnected,
                ["totalLocked"] = gearsLocked + connectorsConnected,
            };
        }

        protected JObject RenameBlock(JObject p)
        {
            var grid = RequireGrid(p);
            string name = (string)p["name"];
            if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("params.name is required");

            var targets = new List<IMyCubeBlock>();
            var rawId = (string)p["blockEntityId"];
            if (!string.IsNullOrEmpty(rawId))
            {
                long wanted = long.Parse(rawId.Replace("block:", "").Replace("grid:", ""));
                var slim = new List<IMySlimBlock>();
                grid.GetBlocks(slim);
                foreach (var s in slim)
                {
                    if (s.FatBlock != null && s.FatBlock.EntityId == wanted) { targets.Add(s.FatBlock); break; }
                }
                if (targets.Count == 0) throw new InvalidOperationException("block not found on grid: " + rawId);
            }
            else
            {
                targets.AddRange(MatchingBlocks(grid, p["filter"] as JObject ?? new JObject()));
                if (targets.Count == 0) throw new InvalidOperationException("no block matches the filter");
            }

            var rows = new JArray();
            int renamed = 0;
            foreach (var fb in targets)
            {
                var terminal = fb as IMyTerminalBlock;
                if (terminal == null) continue;
                string before = terminal.CustomName ?? "";
                terminal.CustomName = name;
                string after = terminal.CustomName ?? "";
                if (string.Equals(after, name, StringComparison.Ordinal)) renamed++;
                rows.Add(new JObject
                {
                    ["entityId"] = fb.EntityId.ToString(),
                    ["subtype"] = SubtypeOf(fb),
                    ["before"] = before,
                    ["after"] = after,
                });
            }
            _log("info", "rename_block grid:" + grid.EntityId + " -> " + renamed + "/" + rows.Count + " block(s) named \"" + name + "\"");
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = name,
                ["count"] = rows.Count,
                ["renamed"] = renamed,
                ["blocks"] = rows,
            };
        }


        /// <summary>Find one laser antenna by entity id (preferred) or filter.</summary>
        protected static IMyLaserAntenna FindLaser(IMyCubeGrid grid, JObject p)
        {
            var rawId = (string)p["laserBlockId"];
            if (!string.IsNullOrEmpty(rawId))
            {
                long wanted = long.Parse(rawId.Replace("block:", ""));
                foreach (var la in grid.GetFatBlocks<IMyLaserAntenna>())
                    if (la != null && la.EntityId == wanted) return la;
                throw new InvalidOperationException("laser antenna not found on grid: " + rawId);
            }
            var matches = MatchingBlocks(grid, p["filter"] as JObject ?? new JObject());
            foreach (var fb in matches)
            {
                var la = fb as IMyLaserAntenna;
                if (la != null) return la;
            }
            throw new InvalidOperationException("no laser antenna matches (provide laserBlockId or filter)");
        }


        protected static JObject LaserReadout(IMyLaserAntenna la)
        {
            var ingame = la as IngameLaser;
            var row = new JObject
            {
                ["entityId"] = la.EntityId.ToString(),
                ["name"] = SafeName(la),
                ["subtype"] = SubtypeOf(la),
                ["position"] = Vec(la.PositionComp.GetPosition()),
            };
            if (ingame == null)
            {
                row["state"] = "UNVERIFIED";
                row["reason"] = "block does not implement the Ingame laser interface in this build";
                return row;
            }
            row["status"] = ingame.Status.ToString();
            row["targetCoords"] = Vec(ingame.TargetCoords);
            row["isPermanent"] = ingame.IsPermanent;
            row["rangeM"] = Math.Round(ingame.Range, 1);
            row["requireLos"] = ingame.RequireLoS;
            row["isOutsideLimits"] = ingame.IsOutsideLimits;
            row["enabled"] = ingame.Enabled;
            row["working"] = ingame.IsWorking;

            // Definition declares the range ceiling and the power draw per state.
            try
            {
                var cube = la as Sandbox.Game.Entities.MyCubeBlock;
                var def = cube != null ? cube.BlockDefinition as Sandbox.Definitions.MyLaserAntennaDefinition : null;
                if (def != null)
                {
                    row["maxRangeM"] = Math.Round(def.MaxRange, 1);
                    row["powerDrawMw"] = new JObject
                    {
                        ["idle"] = Math.Round(def.PowerInputIdle, 3),
                        ["turning"] = Math.Round(def.PowerInputTurning, 3),
                        ["lasing"] = Math.Round(def.PowerInputLasing, 3),
                        ["source"] = "block definition",
                    };
                }
                else
                {
                    row["maxRangeM"] = JValue.CreateNull();
                    row["powerDrawMw"] = UnverifiedField("block definition is not MyLaserAntennaDefinition");
                }
            }
            catch (Exception ex)
            {
                row["powerDrawMw"] = UnverifiedField(ex.GetType().Name + ": " + ex.Message);
            }

            // Connected-to is exposed through Sandbox.ModAPI.IMyLaserAntenna.Other.
            var other = la.Other;
            if (other != null)
            {
                row["otherAntennaId"] = other.EntityId.ToString();
                row["otherGridId"] = other.CubeGrid != null ? "grid:" + other.CubeGrid.EntityId : null;
                row["otherName"] = SafeName(other);
            }
            else
            {
                row["otherAntennaId"] = JValue.CreateNull();
                row["otherGridId"] = JValue.CreateNull();
                row["otherName"] = JValue.CreateNull();
            }
            return row;
        }


        /// <summary>Aim one laser at explicit world coordinates and read the result back.</summary>
        protected JObject LaserTarget(JObject p)
        {
            var grid = RequireGrid(p);
            var la = FindLaser(grid, p);
            var ingame = la as IngameLaser;
            if (ingame == null) throw new InvalidOperationException("laser does not implement the Ingame interface");
            var target = new Vector3D(D(p, "x"), D(p, "y"), D(p, "z"));
            bool permanentSet = p["permanent"] != null;
            if (permanentSet) ingame.IsPermanent = (bool)p["permanent"];
            var before = ingame.TargetCoords;
            // The Ingame entry point takes a GPS string; invariant decimals so the
            // parser sees '.' regardless of host culture.
            string gps = "GPS:hermes-laser-target:" +
                target.X.ToString("0.###", CultureInfo.InvariantCulture) + ":" +
                target.Y.ToString("0.###", CultureInfo.InvariantCulture) + ":" +
                target.Z.ToString("0.###", CultureInfo.InvariantCulture) + ":";
            ingame.SetTargetCoords(gps);
            var after = ingame.TargetCoords;
            _log("info", "laser_target grid:" + grid.EntityId + " antenna=" + la.EntityId + " -> " + Fmt(target) +
                " status=" + ingame.Status);
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["requested"] = Vec(target),
                ["gps"] = gps,
                ["before"] = Vec(before),
                ["after"] = Vec(after),
                ["status"] = ingame.Status.ToString(),
                ["isPermanent"] = ingame.IsPermanent,
                ["permanentSet"] = permanentSet,
            };
        }


        /// <summary>Connect / disconnect one laser and read the link state back.</summary>
        protected JObject LaserConnect(JObject p, bool connect)
        {
            var grid = RequireGrid(p);
            var la = FindLaser(grid, p);
            var ingame = la as IngameLaser;
            if (ingame == null) throw new InvalidOperationException("laser does not implement the Ingame interface");
            if (p["permanent"] != null) ingame.IsPermanent = (bool)p["permanent"];
            string error = null;
            string method = connect ? "Connect" : "none";
            try
            {
                if (connect)
                {
                    ingame.Connect();
                }
                else
                {
                    // No public Disconnect on the Ingame interface in this build:
                    // use the concrete method when it exists, else switching the
                    // block off drops the link (the provisioning profile keeps
                    // lasers OnOff=false when idle anyway).
                    var concrete = la.GetType().GetMethod("Disconnect", Type.EmptyTypes);
                    if (concrete != null)
                    {
                        concrete.Invoke(la, null);
                        method = "concrete.Disconnect";
                    }
                    else
                    {
                        var fb = la as Sandbox.ModAPI.Ingame.IMyFunctionalBlock;
                        if (fb == null) throw new InvalidOperationException("laser is not a functional block; cannot switch it off");
                        fb.Enabled = false;
                        method = "Enabled=false (no Disconnect in API)";
                    }
                }
            }
            catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
            var row = LaserReadout(la);
            row["gridId"] = "grid:" + grid.EntityId;
            row["requested"] = connect ? "connect" : "disconnect";
            row["disconnectMethod"] = method;
            row["error"] = error;
            _log("info", "laser_" + (connect ? "connect" : "disconnect") + " grid:" + grid.EntityId +
                " antenna=" + la.EntityId + " method=" + method + " status=" + ingame.Status +
                (error != null ? " error=" + error : ""));
            return row;
        }


        /// <summary>
        /// Per-laser network state. `gridId`/`gridIds` select grids; with neither,
        /// every grid that carries a laser antenna is sampled. All values are read
        /// from the live block; a field the build does not expose is UNVERIFIED.
        /// </summary>
        protected JObject LaserState(JObject p)
        {
            var wanted = new List<IMyCubeGrid>();
            var single = (string)p["gridId"];
            if (p["gridIds"] is JArray arr)
            {
                foreach (var t in arr)
                {
                    var raw = t.ToString();
                    long id = long.Parse(raw.Replace("grid:", ""));
                    IMyEntity e;
                    if (MyAPIGateway.Entities.TryGetEntityById(id, out e) && e is IMyCubeGrid) wanted.Add((IMyCubeGrid)e);
                }
            }
            else if (!string.IsNullOrEmpty(single))
            {
                long id = long.Parse(single.Replace("grid:", ""));
                IMyEntity one;
                if (!MyAPIGateway.Entities.TryGetEntityById(id, out one) || !(one is IMyCubeGrid))
                    throw new InvalidOperationException("grid not found: " + single);
                wanted.Add((IMyCubeGrid)one);
            }
            else
            {
                var raw = new HashSet<IMyEntity>();
                MyAPIGateway.Entities.GetEntities(raw, e => e is IMyCubeGrid);
                foreach (var e in raw)
                {
                    var g = e as IMyCubeGrid;
                    if (g != null && !g.Closed) wanted.Add(g);
                }
            }

            var grids = new JArray();
            foreach (var grid in wanted)
            {
                var lasers = new JArray();
                foreach (var la in grid.GetFatBlocks<IMyLaserAntenna>())
                    if (la != null) lasers.Add(LaserReadout(la));
                if (lasers.Count == 0) continue;
                grids.Add(new JObject
                {
                    ["gridId"] = "grid:" + grid.EntityId,
                    ["name"] = grid.DisplayName ?? "",
                    ["position"] = Vec(grid.PositionComp.GetPosition()),
                    ["laserCount"] = lasers.Count,
                    ["lasers"] = lasers,
                });
            }
            return new JObject
            {
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["count"] = grids.Count,
                ["grids"] = grids,
                ["note"] = "read-only: status/target/power sampled from the live blocks",
            };
        }


        // ------------------------------------------- session-wide reads
        // list_players / planets / suit_radio / dock_state are reads a player
        // could make from the cockpit, so they ride the PRODUCTION channel in
        // BOTH builds. None of them writes world state.

        /// <summary>Every online player, read-only (same shape as the telemetry frame).</summary>
        /// <summary>
        /// T61: every online player, on demand, in the same shape the telemetry
        /// frame carries under `players`. Read-only; an empty list means nobody
        /// is connected on this server, not a read failure (see `state`).
        /// </summary>
        protected JObject ListPlayers()
        {
            var rows = new JArray();
            var state = "readable";
            try
            {
                rows = PlayerRead.CollectJson(_log);
            }
            catch (Exception ex)
            {
                state = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
            }
            return new JObject
            {
                ["count"] = rows.Count,
                ["players"] = rows,
                ["state"] = state,
                ["note"] = rows.Count > 0
                    ? "live samples from MyAPIGateway.Players; ids are strings"
                    : "no connected players on this server (empty list is the real answer)",
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }

        /// <summary>Read-only: every planet entity (name, position, radius).</summary>
        /// <summary>Read-only: every planet entity in the session (world content).</summary>
        protected JObject ListPlanets()
        {
            var arr = new JArray();
            var raw = new HashSet<IMyEntity>();
            MyAPIGateway.Entities.GetEntities(raw, e => e is MyPlanet);
            foreach (var pl in raw.OfType<MyPlanet>())
            {
                arr.Add(new JObject
                {
                    ["entityId"] = "grid:" + pl.EntityId,
                    ["name"] = pl.Name,
                    ["position"] = Vec(pl.PositionComp.GetPosition()),
                    ["radiusM"] = pl.AverageRadius,
                });
            }
            return new JObject { ["planets"] = arr, ["count"] = arr.Count };
        }

        /// <summary>Read-only: the owner character's suit antenna radius.</summary>
        /// <summary>
        /// T29 follow-up: the owner character's suit antenna radius. One-way HUD
        /// broadcasts reach a player within the satellite's radius, but sending
        /// needs the player's own antenna; this is the number to compare against.
        /// </summary>
        protected JObject SuitRadio(JObject p)
        {
            long identity = 144115188075855926L;
            var raw = p["identityId"];
            if (raw != null && raw.Type != JTokenType.Null) long.TryParse(raw.ToString(), out identity);

            var entities = new HashSet<IMyEntity>();
            MyAPIGateway.Entities.GetEntities(entities, e => e is Sandbox.Game.Entities.Character.MyCharacter);
            var rows = new JArray();
            double radius = -1;
            string found = null;
            foreach (var e in entities)
            {
                var ch = e as Sandbox.Game.Entities.Character.MyCharacter;
                if (ch == null) continue;
                long id = 0;
                string display = "";
                try
                {
                    var identityObj = ch.GetIdentity();
                    if (identityObj != null) id = identityObj.IdentityId;
                    display = ch.DisplayNameText ?? "";
                }
                catch { }
                var rb = ch.RadioBroadcaster;
                var r = rb != null ? rb.BroadcastRadius : -1;
                rows.Add(new JObject
                {
                    ["entityId"] = "char:" + ch.EntityId,
                    ["displayName"] = display,
                    ["identityId"] = id.ToString(),
                    ["isPlayer"] = ch.IsPlayer,
                    ["broadcastRadiusM"] = Math.Round(r, 1),
                    ["broadcasting"] = rb != null && rb.Enabled,
                    ["position"] = Vec(ch.PositionComp.GetPosition()),
                });
                if (id == identity && r > 0) { radius = r; found = display; }
            }
            return new JObject
            {
                ["identityId"] = identity.ToString(),
                ["found"] = radius > 0,
                ["displayName"] = found,
                ["broadcastRadiusM"] = Math.Round(radius, 1),
                ["characters"] = rows,
                ["note"] = radius > 0
                    ? "suit antenna radius, read from MyCharacter.RadioBroadcaster.BroadcastRadius"
                    : "character for that identity is not in the world (player offline): UNVERIFIED",
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
        }

        /// <summary>
        /// Read-only dock job state. This build has no world-matrix dock
        /// assistant, so it answers UNKNOWN with that reason instead of failing.
        /// </summary>
        protected virtual JObject DockStateRead(JObject p)
        {
            return new JObject
            {
                ["state"] = "UNKNOWN",
                ["reason"] = "no snap_dock job for that grid/jobId (snap_dock is test-build only)",
            };
        }

        // --------------------------------------------------- HUD GPS markers
        // A player can add or delete these from their own HUD; they are not
        // world state, so they are production actions.

        /// <summary>Add one GPS marker to an identity and read it back.</summary>
        protected JObject GpsAdd(JObject p)
        {
            long identityId = IdentityParam(p);
            if (identityId == 0) throw new InvalidOperationException("params.identityId is required");
            string name = (string)p["name"];
            if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("params.name is required");
            var pos = new Vector3D(D(p, "x"), D(p, "y"), D(p, "z"));
            var gps = MyAPIGateway.Session.GPS.Create(name, (string)p["description"] ?? "", pos, true, true);
            gps.GPSColor = GpsColor(p);
            MyAPIGateway.Session.GPS.AddGps(identityId, gps);

            bool visible = false;
            int hash = 0;
            var list = new List<IMyGps>();
            MyAPIGateway.Session.GPS.GetGpsList(identityId, list);
            foreach (var g in list)
            {
                if (g == null || !string.Equals(g.Name, name, StringComparison.Ordinal)) continue;
                visible = true;
                hash = g.Hash;
                break;
            }
            _log("info", "gps_add identity=" + identityId + " name=" + name + " visible=" + visible + " hash=" + hash);
            return new JObject
            {
                ["identityId"] = identityId.ToString(),
                ["name"] = name,
                ["hash"] = hash,
                ["visible"] = visible,
                ["position"] = Vec(pos),
                ["readBack"] = "GetGpsList",
                ["total"] = list.Count,
            };
        }

        /// <summary>Remove every GPS marker whose name starts with namePrefix.</summary>
        protected JObject GpsRemove(JObject p)
        {
            long identityId = IdentityParam(p);
            if (identityId == 0) throw new InvalidOperationException("params.identityId is required");
            string prefix = (string)p["namePrefix"];
            if (string.IsNullOrEmpty(prefix)) throw new InvalidOperationException("params.namePrefix is required");
            var list = new List<IMyGps>();
            MyAPIGateway.Session.GPS.GetGpsList(identityId, list);
            int removed = 0;
            foreach (var g in list)
            {
                if (g == null || string.IsNullOrEmpty(g.Name)) continue;
                if (!g.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                MyAPIGateway.Session.GPS.RemoveGps(identityId, g.Hash);
                removed++;
            }
            var after = new List<IMyGps>();
            MyAPIGateway.Session.GPS.GetGpsList(identityId, after);
            bool left = false;
            foreach (var g in after)
                if (g != null && !string.IsNullOrEmpty(g.Name) && g.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) left = true;
            _log("info", "gps_remove identity=" + identityId + " prefix=" + prefix + " removed=" + removed + " remaining=" + after.Count);
            return new JObject
            {
                ["identityId"] = identityId.ToString(),
                ["namePrefix"] = prefix,
                ["removed"] = removed,
                ["remaining"] = after.Count,
                ["verified"] = !left,
            };
        }

        /// <summary>Read back every GPS marker for an identity.</summary>
        protected JObject GpsList(JObject p)
        {
            long identityId = IdentityParam(p);
            if (identityId == 0) throw new InvalidOperationException("params.identityId is required");
            if (identityId == 0) throw new InvalidOperationException("params.identityId is required");
            var list = new List<IMyGps>();
            MyAPIGateway.Session.GPS.GetGpsList(identityId, list);
            var arr = new JArray();
            foreach (var g in list)
            {
                if (g == null) continue;
                arr.Add(new JObject
                {
                    ["name"] = g.Name ?? "",
                    ["description"] = g.Description ?? "",
                    ["hash"] = g.Hash,
                    ["x"] = g.Coords.X,
                    ["y"] = g.Coords.Y,
                    ["z"] = g.Coords.Z,
                    ["showOnHud"] = g.ShowOnHud,
                });
            }
            return new JObject { ["identityId"] = identityId.ToString(), ["count"] = arr.Count, ["gps"] = arr };
        }

        protected static Color GpsColor(JObject p)
        {
            string name = ((string)p["color"] ?? "cyan").ToLowerInvariant();
            switch (name)
            {
                case "red": return Color.Red;
                case "green": return Color.Green;
                case "blue": return Color.Blue;
                case "yellow": return Color.Yellow;
                case "orange": return Color.Orange;
                case "white": return Color.White;
                case "purple": return Color.Purple;
                default: return Color.Cyan;
            }
        }

        protected static long IdentityParam(JObject p)
        {
            var t = p["identityId"];
            if (t == null || t.Type == JTokenType.Null) return 0;
            long v;
            return long.TryParse(t.ToString(), out v) ? v : 0;
        }

        // ------------------------------------------------ naming / AI off

        /// <summary>
        /// Rename a grid (CustomName) - OWNED grids only. Auto-naming is a
        /// vanilla cockpit action, but it may not rename someone else's hull:
        /// the caller's identity must be one of the grid's big owners, or the
        /// grid must be unclaimed (no big owners at all).
        /// </summary>
        protected JObject RenameGrid(JObject p)
        {
            var grid = RequireGrid(p);
            long ownerId = OwnerParam(p);
            if (ownerId == 0 && _config.OwnerSteamIds != null && _config.OwnerSteamIds.Length > 0)
                ownerId = MyAPIGateway.Players.TryGetIdentityId((ulong)_config.OwnerSteamIds[0]);
            if (!GridOwnedBy(grid, ownerId))
                throw new InvalidOperationException(
                    "rename_grid refused: grid " + grid.EntityId + " belongs to another owner (owned grids only)");
            string name = (string)p["name"];
            if (string.IsNullOrEmpty(name)) throw new InvalidOperationException("params.name is required");

            string before = grid.CustomName ?? "";
            grid.CustomName = name;
            string after = grid.CustomName ?? "";
            _log("info", "rename_grid grid:" + grid.EntityId + " \"" + before + "\" -> \"" + after + "\"");
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["ownerId"] = ownerId.ToString(),
                ["before"] = before,
                ["after"] = after,
                ["displayName"] = grid.DisplayName ?? "",
                ["ok"] = string.Equals(after, name, StringComparison.Ordinal),
            };
        }

        /// <summary>
        /// True when `ownerId` is one of the grid's big owners, or the grid has
        /// no owner at all. The guard every grid-level write (rename) uses:
        /// touching another owner's hull is a takeover, not a rename.
        /// </summary>
        protected static bool GridOwnedBy(IMyCubeGrid grid, long ownerId)
        {
            bool claimed = false;
            foreach (var o in grid.BigOwners)
            {
                if (o == 0) continue;
                claimed = true;
                if (ownerId != 0 && o == ownerId) return true;
            }
            return !claimed;
        }

        /// <summary>
        /// Switch a grid's own autopilot OFF: every remote control loses its
        /// autopilot and waypoints, thrust/gyro overrides are cleared and the
        /// built-in AI blocks are disabled. Every step removes energy a pilot
        /// could remove from the cockpit, and the executor's secure sequence
        /// (release -> diag -> wake -> ai_off -> move) needs it in survival.
        /// </summary>
        protected JObject DisableAi(JObject p)
        {
            var grid = RequireGrid(p);
            var disabled = new JArray();
            int rcCount = 0, autopilotOff = 0, waypointsCleared = 0;

            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
            {
                if (rc == null) continue;
                rcCount++;
                try
                {
                    if (rc.IsAutoPilotEnabled) { rc.SetAutoPilotEnabled(false); autopilotOff++; }
                    rc.ClearWaypoints();
                    rc.SetCollisionAvoidance(false);
                    rc.DampenersOverride = true;
                    rc.SpeedLimit = 0f;
                    waypointsCleared++;
                }
                catch (Exception ex) { _log("warn", "rc ai_off failed on grid:" + grid.EntityId + ": " + ex.Message); }
            }

            // Disabling a PB/timer does not reset what it already wrote: NPC
            // prefabs leave thruster and gyro overrides behind, which keeps
            // pushing the grid after the "AI" is off. Clear them explicitly.
            int thrustCleared = 0, gyroCleared = 0;
            float maxOverride = 0f, maxOverrideN = 0f;
            foreach (var thr in grid.GetFatBlocks<IMyThrust>())
            {
                if (thr == null) continue;
                float ov = thr.ThrustOverridePercentage;
                float ovN = thr.ThrustOverride;
                if (ov > maxOverride) maxOverride = ov;
                if (ovN > maxOverrideN) maxOverrideN = ovN;
                // SE carries two override representations; a prefab can set the
                // newton one while the percentage still reads 0.
                if (ov != 0f || ovN != 0f)
                {
                    thr.ThrustOverridePercentage = 0f;
                    thr.ThrustOverride = 0f;
                    thrustCleared++;
                }
            }
            foreach (var gyro in grid.GetFatBlocks<IMyGyro>())
            {
                if (gyro == null) continue;
                if (gyro.GyroOverride) { gyro.GyroOverride = false; gyroCleared++; }
                gyro.Yaw = 0f; gyro.Pitch = 0f; gyro.Roll = 0f;
            }

            var blocks = new List<IMySlimBlock>();
            grid.GetBlocks(blocks);
            foreach (var b in blocks)
            {
                if (b.FatBlock == null) continue;
                var subtype = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "";
                if (!IsAiBlock(b.FatBlock, subtype)) continue;
                var fb = b.FatBlock as IMyFunctionalBlock;
                if (fb == null) continue;
                bool was = fb.Enabled;
                fb.Enabled = false;
                disabled.Add(new JObject
                {
                    ["block"] = subtype,
                    ["customName"] = SafeName(b.FatBlock),
                    ["wasEnabled"] = was,
                });
            }

            // Post-state: prove nothing is still flying itself.
            int stillAutopilot = 0, stillEnabledAi = 0;
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
                if (rc != null && rc.IsAutoPilotEnabled) stillAutopilot++;
            foreach (var b in blocks)
            {
                if (b.FatBlock == null) continue;
                var subtype = b.BlockDefinition != null ? b.BlockDefinition.Id.SubtypeName : "";
                if (!IsAiBlock(b.FatBlock, subtype)) continue;
                var fb = b.FatBlock as IMyFunctionalBlock;
                if (fb != null && fb.Enabled) stillEnabledAi++;
            }

            _log("info", "ai_off grid:" + grid.EntityId + " rc=" + rcCount + " autopilotDisabled=" + autopilotOff +
                " aiBlocksDisabled=" + disabled.Count + " thrustOverridesCleared=" + thrustCleared +
                " maxOverridePct=" + maxOverride + " maxOverrideN=" + maxOverrideN + " gyroOverridesCleared=" + gyroCleared +
                " stillAutopilot=" + stillAutopilot + " stillAiEnabled=" + stillEnabledAi);

            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["remoteControls"] = rcCount,
                ["autopilotsDisabled"] = autopilotOff,
                ["waypointListsCleared"] = waypointsCleared,
                ["aiBlocksDisabled"] = disabled.Count,
                ["thrustOverridesCleared"] = thrustCleared,
                ["maxThrustOverrideSeen"] = Math.Round(maxOverride, 4),
                ["maxThrustOverrideNSeen"] = Math.Round(maxOverrideN, 1),
                ["gyroOverridesCleared"] = gyroCleared,
                ["aiBlocks"] = disabled,
                ["stillAutopilot"] = stillAutopilot,
                ["stillAiEnabled"] = stillEnabledAi,
                ["ok"] = stillAutopilot == 0 && stillEnabledAi == 0,
            };
        }

        protected IMyCubeGrid RequireGrid(JObject p)
        {
            string raw = (string)p["entityId"] ?? (string)p["gridId"];
            if (string.IsNullOrEmpty(raw)) throw new InvalidOperationException("params.entityId is required");
            long id = long.Parse(raw.Replace("grid:", ""));
            IMyEntity entity;
            if (!MyAPIGateway.Entities.TryGetEntityById(id, out entity)) throw new InvalidOperationException("grid not found: " + raw);
            var grid = entity as IMyCubeGrid;
            if (grid == null) throw new InvalidOperationException("entity is not a grid: " + raw);
            return grid;
        }


        protected static string SafeName(IMyCubeBlock block)
        {
            try
            {
                var terminal = block as IMyTerminalBlock;
                return terminal != null ? (terminal.CustomName ?? "") : "";
            }
            catch { return ""; }
        }


        /// <summary>
        /// Identity ids are larger than 2^53, so they arrive as strings from the
        /// backend. Parsing the token text (not a double) preserves all 64 bits.
        /// </summary>
        protected static long OwnerParam(JObject p)
        {
            var t = p["ownerId"];
            if (t == null || t.Type == JTokenType.Null) return 0;
            long v;
            return long.TryParse(t.ToString(), out v) ? v : 0;
        }


        protected static double D(JObject p, string key)
        {
            var t = p[key];
            if (t == null) return 0;
            double v;
            return double.TryParse(t.ToString(), out v) ? v : 0;
        }


        protected static Vector3? Vector(JObject p, string key)
        {
            var o = p[key] as JObject;
            if (o == null) return null;
            return new Vector3((float)D(o, "x"), (float)D(o, "y"), (float)D(o, "z"));
        }


        protected static JObject Vec(Vector3D v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }


        protected static JObject Vec(Vector3 v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }


        protected static string Fmt(Vector3D v)
        {
            return "(" + Math.Round(v.X, 1) + "," + Math.Round(v.Y, 1) + "," + Math.Round(v.Z, 1) + ")";
        }
    }
}
