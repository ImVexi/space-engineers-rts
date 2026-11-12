using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Plugin entry point. A loader shim constructs this, calls Init with an
    /// ILoaderAdapter, and calls Dispose on shutdown. The lifecycle is
    /// deliberately loader-neutral (Torch vs Pulsar/Magnetar).
    /// </summary>
    public sealed class Plugin : IDisposable
    {
        /// <summary>Plugin build version; firmware has its own FIRMWARE_VERSION.</summary>
        public const string Version = "0.4.0-action-channel";

        private ILoaderAdapter _loader;
        private PluginConfig _config;
        private FeatureFlags _flags;
        private BackendLink _link;
        private TelemetryCollector _telemetry;
        private CommandExecutor _executor;
        private HandoffDetector _detector;
        private FirmwareInjector _injector;
        private SafeMode _safeMode;
        /// <summary>
        /// Production channel executor: reads, flight, landing and block
        /// properties. Admin actions (spawn, clone, delete, teleport, refill,
        /// save) are not part of this build and are refused by name.
        /// </summary>
        private HermesActions _actions;

        private double _telemetryAcc;
        private double _statusAcc;
        private double _detectAcc;
        private long _tick;
        private bool _initialized;

        /// <summary>
        /// Orders arrive on the WebSocket thread. Every world API call must run
        /// on the game thread, so orders are queued here and executed from
        /// Tick(). The ack is therefore sent after execution, not on receipt.
        /// </summary>
        private readonly ConcurrentQueue<JObject> _pendingOrders = new ConcurrentQueue<JObject>();

        public void Init(ILoaderAdapter loader)
        {
            if (_initialized) return;
            _loader = loader;
            // Config lives next to the DLL (plugin.json), overridable by env. The
            // token is therefore never compiled in and never in the repo.
            var configPath = Environment.GetEnvironmentVariable("HERMES_CONFIG_PATH");
            if (string.IsNullOrEmpty(configPath)) configPath = loader.ResolvePath("plugin.json");
            _config = PluginConfig.Load(configPath);
            loader.Log("info", "config file: " + configPath + " (exists=" + System.IO.File.Exists(configPath) + ")");

            var invalid = _config.Validate();
            if (invalid != null)
            {
                loader.Log("error", "config invalid: " + invalid);
                throw new InvalidOperationException(invalid);
            }

            _flags = FeatureFlags.FromEnvironment(_config);
            if (_config.OwnerSteamIds == null || _config.OwnerSteamIds.Length == 0)
                loader.Log("warn", "hermes: ownerSteamIds is empty: no grid will be reported " +
                    "or flown. Set ownerSteamIds in plugin.json (or HERMES_OWNER_STEAM_IDS).");
            _safeMode = new SafeMode(_config.SafeModeAfterSec, Log);
            _telemetry = new TelemetryCollector(loader, _config);
            _executor = new CommandExecutor(loader, _flags, _safeMode, Log);
            _detector = new HandoffDetector(loader, _config);
            _injector = new FirmwareInjector(loader, _config, _flags, Log);

            _actions = new HermesActions(_config, Log, _executor, _safeMode);

            _link = new BackendLink(_config, () => _flags.AsCapabilities(), Log);
            _link.DeferAcks = true;
            _link.OnOrder = HandleOrder;
            _link.OnServerMessage = frame =>
            {
                if ((string)frame["type"] == "status") _safeMode.Clear();
            };
            _link.Start();

            loader.RegisterTick(Tick);
            _initialized = true;
            Log("info", "hermes plugin " + Version + " initialised on " + loader.LoaderName +
                " (test_server=" + _config.IsTestServer + ")");
        }

        private void Tick(double dt)
        {
            if (dt <= 0) return;
            _tick++;

            _telemetryAcc += dt;
            _statusAcc += dt;
            _detectAcc += dt;

            // Game thread: run whatever the WebSocket thread queued.
            DrainOrders();

            // T25: level-mode jobs steer every tick (10 Hz internally). This is
            // a legitimate capability (a pilot could fly it), so it ships in the
            // survival build too - a live build without level flight is useless.
            try { LevelFlightController.Instance.Tick(dt); }
            catch (Exception ex) { Log("warn", "level controller tick failed: " + ex.Message); }

            // land_at: the final descent from a backend handover (150 m to
            // touchdown) is flown here every tick, never from the socket.
            try { LandController.Instance.Tick(dt); }
            catch (Exception ex) { Log("warn", "land controller tick failed: " + ex.Message); }

            // Dampener dead-man: a grid left with dampeners OFF by the backend
            // and no order for 6 s gets them back ON here, on the game thread.
            // Ship safety must not depend on the backend's event loop keeping up.
            try
            {
                DampenerDeadman.Instance.Tick(dt, id =>
                    LandController.Instance.HasActiveJob(id) || LevelFlightController.Instance.HasJob(id));
            }
            catch (Exception ex) { Log("warn", "dampener dead-man tick failed: " + ex.Message); }


            if (_flags.Telemetry && _telemetryAcc >= _config.TelemetryIntervalSec)
            {
                _telemetryAcc = 0;
                _link.SendTelemetry(_telemetry.Collect(_tick));
            }

            if (_statusAcc >= 10)
            {
                _statusAcc = 0;
                var status = new JObject
                {
                    ["schemaVersion"] = 1,
                    ["type"] = "status",
                    ["note"] = _safeMode.Active ? "safe_mode" : "ok",
                };
                // VERIFY: IMySession in 01_210_014 exposes SessionSettings only;
                // MyObjectBuilder_SessionSettings has no SimSpeed member (reflected).
                // simSpeed is optional in the protocol, so it is omitted rather
                // than guessed. See the telemetry section of docs/architecture.md.
                _link.SendStatus(status);
            }

            if (_safeMode.Observe(_link.SinceLastMessage, _link.IsConnected))
            {
                StopAllAutopilots();
            }

            if (_flags.HandoffDetection && _detectAcc >= 2)
            {
                _detectAcc = 0;
                ScanHandoffs();
            }
        }

        private void HandleOrder(JObject order)
        {
            _safeMode.Clear();
            // Never touch the world from the socket thread: queue, ack later.
            _pendingOrders.Enqueue(order);
        }

        private void DrainOrders()
        {
            for (var i = 0; i < 8; i++)
            {
                JObject order;
                if (!_pendingOrders.TryDequeue(out order)) return;
                ExecuteOrder(order);
            }
        }

        private void ExecuteOrder(JObject order)
        {
            var orderId = (string)order["orderId"] ?? "";
            var orderType = (string)order["orderType"];
            var entityId = (string)order["entityId"] ?? "";
            JObject result = null;
            string error = null;
            var ok = false;

            try
            {
                if (orderType == ActionChannelRules.ProductionOrderType)
                {
                    // Production channel: legitimate actions only, compiled into
                    // BOTH builds. An admin action here is refused with
                    // "not available in survival build: ..." even in the test
                    // build, because a client that puts one on this channel has
                    // a bug, not a capability.
                    var prm = order["params"] as JObject ?? new JObject();
                    ok = _actions.TryAction(HermesActions.ActionOf(order), prm, out result, out error);
                }
                else if (orderType == ActionChannelRules.TestOrderType)
                {
                    // The live build has no test channel at all: say so plainly
                    // instead of failing deep inside the native executor.
                    error = ActionChannelRules.Unavailable("test channel (live build)");
                    ok = false;
                }
                else
                {
                    // Native flight types (move/hold/stop/waypoint/...) keep the
                    // original executor; they were never test-channel-only.
                    ok = _executor.Execute(order, out error);
                }
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
                Log("error", "order " + orderId + " threw: " + error);
            }

            _link.Ack(orderId, ok, error);

            var evt = new JObject
            {
                ["schemaVersion"] = 1,
                ["type"] = "event",
                ["eventType"] = ok ? "order_result" : "order_error",
                ["entityId"] = string.IsNullOrEmpty(entityId) ? "grid:0" : entityId,
                ["data"] = new JObject
                {
                    ["orderId"] = orderId,
                    ["orderType"] = orderType,
                    ["ok"] = ok,
                    ["error"] = error,
                    ["result"] = result,
                },
                ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            _link.SendEvent(evt);
            Log(ok ? "info" : "warn", "order " + orderId + " (" + orderType + ") ok=" + ok +
                (error != null ? " error=" + error : ""));
        }

        private void ScanHandoffs()
        {
            var candidates = _detector.Scan();
            foreach (var c in candidates)
            {
                var evt = new JObject
                {
                    ["schemaVersion"] = 1,
                    ["type"] = "event",
                    ["eventType"] = "handoff_candidate",
                    ["entityId"] = "grid:" + c.GridEntityId,
                    ["data"] = new JObject
                    {
                        ["goal"] = c.Goal,
                        ["blockName"] = c.BlockName,
                        ["safe"] = c.Safe,
                        ["missing"] = new JArray(c.Missing),
                    },
                    ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };
                _link.SendStatus(evt);
                Log("info", "handoff candidate grid:" + c.GridEntityId + " goal=" + c.Goal + " safe=" + c.Safe);

                if (c.Safe && _config.IsTestServer && _flags.FirmwareInjection)
                {
                    string err;
                    if (!_injector.InjectGrid(c.GridEntityId, out err))
                        Log("warn", "firmware injection refused: " + err);
                }
            }
        }

        private void StopAllAutopilots()
        {
            // A safe-mode stop must also release level-mode and landing jobs:
            // their gyro and thrust overrides bypass the autopilot they would
            // otherwise stop. Both controllers exist in every build flavour.
            LevelFlightController.Instance.StopAll("safe mode");
            LandController.Instance.StopAll("safe mode");
            var stopped = 0;
            foreach (var grid in _loader.GetGrids())
            {
                if (!Ownership.IsOwned(grid, _config)) continue;
                foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
                {
                    if (rc == null || !rc.IsAutoPilotEnabled) continue;
                    try { rc.SetAutoPilotEnabled(false); stopped++; }
                    catch (Exception ex) { Log("warn", "safe-mode stop failed: " + ex.Message); }
                }
            }
            Log("warn", "safe mode stopped " + stopped + " autopilot(s)");
        }

        private void Log(string level, string message)
        {
            if (_loader != null) _loader.Log(level, "hermes: " + message);
        }

        public void Dispose()
        {
            if (_link != null) _link.Dispose();
            _initialized = false;
            Log("info", "hermes plugin disposed");
        }
    }
}
