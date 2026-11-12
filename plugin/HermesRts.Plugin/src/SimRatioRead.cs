using System;
using System.Globalization;
using System.Reflection;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// The game's simulation ratio, read in-process.
    ///
    /// The LIVE server runs with `RemoteApiEnabled=false`, so the backend's
    /// Remote API sampler (which is how the test server reports SimSpeed) has no
    /// source there and the flight gate never blocked. This is the legitimate
    /// read that replaces it: `MyAPIGateway.Physics.SimulationRatio` is the same
    /// ratio the server UI calls "Sim speed", exposed on the mod API - no
    /// console command, no world write, no reflection cheat.
    ///
    /// Verified against 01_210_014 (`plugin/refs`): `VRage.Game.ModAPI.IMyPhysics`
    /// declares `SimulationRatio` and `ServerSimulationRatio`; the static
    /// `Sandbox.Engine.Physics.MyPhysics.SimulationRatio` is the fallback and is
    /// reached by reflection so a build without it reports "unavailable"
    /// instead of failing to compile.
    ///
    /// Reported to the backend two ways: the `sim_ratio` action (both builds, on
    /// the production `action` channel) and a `simRatio` field on every
    /// telemetry frame.
    /// </summary>
    public static class SimRatioRead
    {
        /// <summary>The client-side simulation ratio (what the server UI calls Sim speed), or null.</summary>
        public static double? Ratio()
        {
            double? ratio;
            string source, state;
            Read(out ratio, out source, out state);
            return ratio;
        }

        /// <summary>Full read: value, server-side value, where it came from, and whether it was readable.</summary>
        public static JObject Read()
        {
            double? ratio, server;
            string source, state;
            Read(out ratio, out server, out source, out state);
            var row = new JObject
            {
                ["simulationRatio"] = ratio.HasValue ? (JToken)Math.Round(ratio.Value, 4) : JValue.CreateNull(),
                ["serverSimulationRatio"] = server.HasValue ? (JToken)Math.Round(server.Value, 4) : JValue.CreateNull(),
                ["source"] = source,
                ["state"] = state,
                ["sampledAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["note"] = "in-process read; the live server has RemoteApiEnabled=false, so this is the backend's SimSpeed source there",
            };
            if (ratio.HasValue || server.HasValue)
                row["value"] = Math.Round((ratio ?? server).Value, 4);
            return row;
        }

        private static void Read(out double? ratio, out string source, out string state)
        {
            double? server;
            Read(out ratio, out server, out source, out state);
        }

        private static void Read(out double? ratio, out double? server, out string source, out string state)
        {
            ratio = null;
            server = null;
            source = "unavailable";
            state = "UNVERIFIED";

            // 1) The mod API surface. Both properties are documented on
            //    IMyPhysics; a build that only has one still yields a value.
            try
            {
                var phys = MyAPIGateway.Physics;
                if (phys != null)
                {
                    ratio = Clamp01(Convert.ToDouble(phys.SimulationRatio, CultureInfo.InvariantCulture));
                    server = Clamp01(Convert.ToDouble(phys.ServerSimulationRatio, CultureInfo.InvariantCulture));
                    source = "MyAPIGateway.Physics";
                }
            }
            catch (Exception ex)
            {
                state = "UNVERIFIED: MyAPIGateway.Physics: " + ex.GetType().Name + ": " + ex.Message;
            }

            // 2) Reflection fallback to the engine static the mod API wraps.
            if (ratio == null)
            {
                try
                {
                    var type = Type.GetType("Sandbox.Engine.Physics.MyPhysics, Sandbox.Game", false);
                    var prop = type == null
                        ? null
                        : type.GetProperty("SimulationRatio", BindingFlags.Public | BindingFlags.Static);
                    if (prop != null)
                    {
                        ratio = Clamp01(Convert.ToDouble(prop.GetValue(null, null), CultureInfo.InvariantCulture));
                        source = "Sandbox.Engine.Physics.MyPhysics.SimulationRatio";
                    }
                }
                catch (Exception ex)
                {
                    state = "UNVERIFIED: MyPhysics.SimulationRatio: " + ex.GetType().Name + ": " + ex.Message;
                }
            }

            if (ratio.HasValue || server.HasValue) state = "readable";
        }

        private static double? Clamp01(double? value)
        {
            if (!value.HasValue || double.IsNaN(value.Value) || double.IsInfinity(value.Value)) return null;
            if (value.Value < 0) return 0;
            if (value.Value > 100) return null; // implausible: report nothing, never a fake 1.0
            return value.Value;
        }
    }
}
