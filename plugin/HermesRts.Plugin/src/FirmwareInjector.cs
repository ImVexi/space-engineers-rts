using System;
using System.IO;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Writes the certified uniform firmware into a tagged PB. Writes the old
    /// ProgramData to a timestamped backup first. Gated by firmware_injection and
    /// (by default) refuses on anything that is not explicitly a test server.
    /// </summary>
    public sealed class FirmwareInjector
    {
        private readonly ILoaderAdapter _loader;
        private readonly PluginConfig _config;
        private readonly FeatureFlags _flags;
        private readonly Action<string, string> _log;

        public FirmwareInjector(ILoaderAdapter loader, PluginConfig config, FeatureFlags flags, Action<string, string> log)
        {
            _loader = loader;
            _config = config;
            _flags = flags;
            _log = log;
        }

        /// <summary>Returns true when the PB was updated; error explains refusals.</summary>
        public bool InjectGrid(long gridEntityId, out string error)
        {
            error = null;
            if (!_flags.FirmwareInjection)
            {
                error = "firmware_injection is disabled";
                return false;
            }
            if (!_config.IsTestServer)
            {
                error = "refusing firmware injection on a non-test server";
                return false;
            }

            var grid = _loader.GetGridById(gridEntityId);
            if (grid == null)
            {
                error = "grid not found";
                return false;
            }
            if (!Ownership.IsOwned(grid, _config))
            {
                error = "grid is not owned by the configured owner/faction";
                return false;
            }

            IMyProgrammableBlock target = null;
            foreach (var pb in grid.GetFatBlocks<IMyProgrammableBlock>())
            {
                if (pb == null) continue;
                if ((pb.CustomName ?? "").IndexOf(HandoffDetector.Tag, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    target = pb;
                    break;
                }
            }
            if (target == null)
            {
                error = "no PB tagged " + HandoffDetector.Tag;
                return false;
            }

            var path = _loader.ResolvePath(_config.FirmwarePath);
            if (!File.Exists(path))
            {
                error = "firmware file not found: " + path;
                return false;
            }

            var source = File.ReadAllText(path);
            if (source.Length == 0 || source.Length > 100000)
            {
                error = "firmware size invalid (limit 100000 chars)";
                return false;
            }

            try
            {
                var backup = Path.Combine(
                    Path.GetDirectoryName(path) ?? ".",
                    "backup-" + target.EntityId + "-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + ".cs");
                File.WriteAllText(backup, target.ProgramData ?? "");
                _log("info", "firmware backup written: " + backup);

                // VERIFY: ProgramData setter on the plugin PB interface. Some
                // builds require an explicit Recompile() before the new source
                // is parsed; add that once verified against 01_210_014.
                target.ProgramData = source;
                target.TryRun("");

                _log("info", "firmware injected into PB " + target.EntityId + " (" + source.Length + " chars)");
                return true;
            }
            catch (Exception ex)
            {
                error = "injection failed: " + ex.GetType().Name + ": " + ex.Message;
                return false;
            }
        }
    }
}
