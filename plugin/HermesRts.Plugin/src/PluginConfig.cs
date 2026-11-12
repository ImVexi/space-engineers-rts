using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Newtonsoft.Json;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Runtime configuration. Environment first, optional JSON file second.
    /// Never contains credentials in source control.
    /// </summary>
    public sealed class PluginConfig
    {
        public string BackendUrl = "ws://127.0.0.1:8761/plugin";
        public string Token = "";
        public string ServerId = "se1-live";
        public string AgentId = "hermes-plugin-1";
        public string FirmwarePath = "firmware/HermesFirmware.cs";
        public string FactionTag = "";
        public string Flags = "";
        public long[] OwnerSteamIds = new long[0];
        public bool IsTestServer = false;
        public double TelemetryIntervalSec = 1.0;
        public double SafeModeAfterSec = 30.0;
        public int OrderDedupeCapacity = 4096;

        public static PluginConfig FromEnvironment()
        {
            var c = new PluginConfig();
            // Only an explicitly-set env var may override the file; otherwise
            // the built-in default would clobber plugin.json's backendUrl.
            var envUrl = Environment.GetEnvironmentVariable("HERMES_BACKEND_URL");
            if (!string.IsNullOrEmpty(envUrl)) c.BackendUrl = envUrl;
            var envToken = Environment.GetEnvironmentVariable("HERMES_TOKEN");
            if (!string.IsNullOrEmpty(envToken)) c.Token = envToken;
            c.ServerId = Env("HERMES_SERVER_ID", c.ServerId);
            c.AgentId = Env("HERMES_AGENT_ID", c.AgentId);
            c.FirmwarePath = Env("HERMES_FIRMWARE_PATH", c.FirmwarePath);
            c.FactionTag = Env("HERMES_FACTION_TAG", c.FactionTag);
            c.IsTestServer = Env("HERMES_TEST_SERVER", "0") == "1";

            var owners = Env("HERMES_OWNER_STEAM_IDS", "");
            if (owners.Length > 0)
            {
                var list = new List<long>();
                foreach (var part in owners.Split(','))
                {
                    long id;
                    if (long.TryParse(part.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out id))
                        list.Add(id);
                }
                c.OwnerSteamIds = list.ToArray();
            }

            double d;
            if (double.TryParse(Env("HERMES_TELEMETRY_SEC", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out d) && d > 0)
                c.TelemetryIntervalSec = d;
            if (double.TryParse(Env("HERMES_SAFE_MODE_SEC", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out d) && d > 0)
                c.SafeModeAfterSec = d;

            return c;
        }

        public static PluginConfig Load(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                return FromEnvironment();
            var json = File.ReadAllText(path);
            var fromFile = JsonConvert.DeserializeObject<PluginConfig>(json) ?? new PluginConfig();
            // Environment overrides file for the fields an operator is most
            // likely to change between servers.
            // Environment overrides file only when the variable is actually
            // set; a built-in default must never clobber plugin.json.
            var envUrl = Environment.GetEnvironmentVariable("HERMES_BACKEND_URL");
            if (!string.IsNullOrEmpty(envUrl)) fromFile.BackendUrl = envUrl;
            var envToken = Environment.GetEnvironmentVariable("HERMES_TOKEN");
            if (!string.IsNullOrEmpty(envToken)) fromFile.Token = envToken;
            if (Environment.GetEnvironmentVariable("HERMES_TEST_SERVER") == "1") fromFile.IsTestServer = true;
            return fromFile;
        }

        /// <summary>Returns null when valid, otherwise a human-readable reason.</summary>
        public string Validate()
        {
            Uri uri;
            if (!Uri.TryCreate(BackendUrl, UriKind.Absolute, out uri))
                return "HERMES_BACKEND_URL is not an absolute URI";
            if (uri.Scheme != "ws" && uri.Scheme != "wss")
                return "HERMES_BACKEND_URL must be ws:// or wss://";
            var loopback = uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "::1";
            if (!loopback && Token.Length < 16)
                return "HERMES_TOKEN must be >= 16 chars for a non-loopback backend";
            if (string.IsNullOrEmpty(ServerId) || string.IsNullOrEmpty(AgentId))
                return "HERMES_SERVER_ID and HERMES_AGENT_ID are required";
            return null;
        }

        private static string Env(string name, string fallback)
        {
            var v = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(v) ? fallback : v;
        }
    }
}
