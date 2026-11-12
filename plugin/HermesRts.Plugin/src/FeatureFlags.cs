using System;
using System.Collections.Generic;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Every capability that can change the world is off unless an operator
    /// turns it on. Read-only telemetry and handoff detection are on by default.
    /// </summary>
    public sealed class FeatureFlags
    {
        public bool Telemetry = true;
        public bool HandoffDetection = true;
        public bool SafeMode = true;

        public bool CommandExecution = false;
        public bool FirmwareInjection = false;

        /// <summary>
        /// Always true in this build: the admin actions are not compiled in, so
        /// there is no configuration that can turn them on.
        /// </summary>
        public bool SurvivalMode = true;

        public static FeatureFlags FromEnvironment(PluginConfig config = null)
        {
            // Explicit env wins; otherwise plugin.json's `flags` string. Neither
            // is credentials, so it is safe in the deployed config file.
            var raw = Environment.GetEnvironmentVariable("HERMES_FLAGS");
            if (string.IsNullOrEmpty(raw) && config != null) raw = config.Flags;
            if (string.IsNullOrEmpty(raw))
                return new FeatureFlags();

            var enabled = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var part in raw.Split(','))
            {
                var name = part.Trim();
                if (name.Length > 0) enabled.Add(name);
            }

            var f = new FeatureFlags();
            f.Telemetry = enabled.Contains("telemetry");
            f.HandoffDetection = enabled.Contains("handoff_detection");
            f.SafeMode = enabled.Contains("safe_mode");
            f.CommandExecution = enabled.Contains("command_execution");
            f.FirmwareInjection = enabled.Contains("firmware_injection");
            f.SurvivalMode = !TestBuildAllowed(config);
            return f;
        }

        /// <summary>
        /// True only when this process is the marked test world: the test build
        /// compiled the cheats AND the operator marked the server. The survival
        /// build never answers true, whatever the config says.
        /// </summary>
        public static bool TestBuildAllowed(PluginConfig config = null)
        {
            return false;
        }

        public IEnumerable<string> AsCapabilities()
        {
            if (Telemetry) yield return "telemetry";
            if (HandoffDetection) yield return "handoff_detection";
            if (SafeMode) yield return "safe_mode";
            if (CommandExecution) yield return "command_execution";
            if (FirmwareInjection) yield return "firmware_injection";
            // The production channel (`orderType: "action"`) is compiled into
            // both builds, so advertising it is honest everywhere. `test_api` is
            // only advertised by a build that actually contains the test
            // channel: the live build used to claim it and then fail every order
            // it was sent (survival rehearsal, 2026-11-11).
            if (CommandExecution) yield return "action_api";
            // The game-thread final-descent controller (`land_at`) ships in every
            // build flavour: advertising it is what makes the backend hand the
            // last 150 m to the plugin instead of flying dampener pulses from
            // telemetry cadence (which oscillated and hit at ~19 m/s).
            if (CommandExecution) yield return "land_controller";
            if (CommandExecution) yield return "level_controller";
            yield return SurvivalMode ? "survival_mode" : "test_build";
        }
    }
}
