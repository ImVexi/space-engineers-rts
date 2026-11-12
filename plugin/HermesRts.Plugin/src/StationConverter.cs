using System;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Survival station conversion. The test path zeroes the velocity first, which
    /// is a teleport in disguise (admin-only), so a survival build may not do it.
    /// This path is what a pilot with a cockpit could do: dampeners ON, wait on
    /// the game thread until the hull is actually slow, convert, verify, retry.
    ///
    /// Measured behaviour that shapes it (2026-11-10, test server): SE refuses
    /// `IsStatic = true` while the body still moves, and the first convert can
    /// still return isStaticAfter:false at ~0.011 m/s even after a stop, so the
    /// caller must READ the flag back and retry rather than trust the ack.
    /// </summary>
    internal static class SurvivalStationConverter
    {
        internal static JObject Convert(IMyCubeGrid grid, JObject p, Action<string, string> log)
        {
            if (grid == null) throw new InvalidOperationException("not available in survival build: no grid");
            var pos = grid.PositionComp.GetPosition();
            var isStaticBefore = grid.IsStatic;

            // Survival refuses `force`: force is how a moving grid gets frozen and
            // jumping a hull to a standstill is exactly the cheat we removed.
            if (!isStaticBefore)
            {
                if (p["force"] != null && (bool)p["force"])
                    throw new InvalidOperationException("not available in survival build: convert_to_station force");

                // Dampeners on, via the grid's own controller, is a keystroke a
                // pilot can press. Never IsStatic before the hull is slow.
                var controller = FirstController(grid);
                if (controller != null)
                {
                    try { controller.DampenersOverride = true; }
                    catch (Exception ex) { log("warn", "station stop: dampeners failed: " + ex.Message); }
                }
                var speed0 = grid.Physics != null ? grid.Physics.LinearVelocity.Length() : 0f;
                if (!StationMath.MayConvert(speed0))
                {
                    // The game thread cannot block waiting for physics: hand the
                    // job back and let the caller poll (Plugin on the game thread,
                    // or the backend on telemetry) until the hull is slow.
                    return new JObject
                    {
                        ["gridId"] = "grid:" + grid.EntityId,
                        ["isStaticBefore"] = false,
                        ["isStaticAfter"] = false,
                        ["converted"] = false,
                        ["stopping"] = true,
                        ["speedBeforeMs"] = Math.Round((double)speed0, 3),
                        ["maxConvertSpeedMs"] = StationMath.MaxConvertSpeedMs,
                        ["zeroVelocityUsed"] = false,
                        ["retryAfterSec"] = 1.0,
                        ["note"] = "dampeners on; call again when |v| < " + StationMath.MaxConvertSpeedMs + " m/s",
                    };
                }
            }

            var attempts = 0;
            var method = isStaticBefore ? "already-static" : "IsStatic=true";
            double speedBefore = grid.Physics != null ? grid.Physics.LinearVelocity.Length() : 0;
            while (!grid.IsStatic && attempts < StationMath.MaxAttempts)
            {
                attempts++;
                try
                {
                    grid.IsStatic = true;
                    if (!grid.IsStatic)
                    {
                        var m = grid.GetType().GetMethod("OnConvertToStatic", Type.EmptyTypes);
                        if (m != null) { m.Invoke(grid, null); method += "+OnConvertToStatic"; }
                    }
                }
                catch (Exception ex)
                {
                    method += " error=" + ex.GetType().Name + ": " + ex.Message;
                }
                // Verify, never trust the ack (measured isStaticAfter:false at 0.011 m/s).
                if (grid.IsStatic) break;
                var rc = FirstController(grid);
                if (rc != null && grid.Physics != null && grid.Physics.LinearVelocity.Length() >= StationMath.MaxConvertSpeedMs)
                {
                    log("warn", "station convert attempt " + attempts + " left the hull moving; waiting");
                    break;
                }
            }

            // A static grid cannot thrust; leaving the banks on wastes power.
            var thrustersOff = 0;
            if (grid.IsStatic)
            {
                foreach (var thr in grid.GetFatBlocks<IMyThrust>())
                {
                    if (thr == null || !thr.Enabled) continue;
                    try { thr.ThrustOverridePercentage = 0f; thr.Enabled = false; thrustersOff++; } catch { }
                }
            }

            var posAfter = grid.PositionComp.GetPosition();
            log("info", "convert_to_station (survival) grid:" + grid.EntityId + " static " + isStaticBefore +
                "->" + grid.IsStatic + " attempts=" + attempts + " speed=" + Math.Round(speedBefore, 2) + "m/s");
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["isStaticBefore"] = isStaticBefore,
                ["isStaticAfter"] = grid.IsStatic,
                ["converted"] = !isStaticBefore && grid.IsStatic,
                ["speedBeforeMs"] = Math.Round(speedBefore, 3),
                ["positionDriftM"] = Math.Round((posAfter - pos).Length(), 3),
                ["attempts"] = attempts,
                ["thrustersDisabled"] = thrustersOff,
                ["zeroVelocityUsed"] = false,
                ["method"] = method,
                ["zone"] = "survival",
            };
        }

        private static IMyShipController FirstController(IMyCubeGrid grid)
        {
            foreach (var c in grid.GetFatBlocks<IMyShipController>())
                if (c != null) return c;
            return null;
        }
    }
}
