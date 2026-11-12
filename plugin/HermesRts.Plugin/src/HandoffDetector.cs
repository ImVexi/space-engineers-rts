using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Read-only handoff scan (deploy instructions §5): a PB whose name contains
    /// [HERMES-TEST], or whose Custom Data contains HERMES_TEST=READY, marks a
    /// grid as available. The owner is checked before anything is reported.
    /// </summary>
    public sealed class HandoffDetector
    {
        public const string Tag = "[HERMES-TEST]";
        private static readonly Regex ReadyLine = new Regex(@"^\s*HERMES_TEST\s*=\s*READY\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        private static readonly Regex GoalLine = new Regex(@"^\s*HERMES_GOAL\s*=\s*(\w+)\s*$", RegexOptions.Multiline | RegexOptions.IgnoreCase);

        private readonly ILoaderAdapter _loader;
        private readonly PluginConfig _config;
        private readonly HashSet<string> _reported = new HashSet<string>(StringComparer.Ordinal);

        public HandoffDetector(ILoaderAdapter loader, PluginConfig config)
        {
            _loader = loader;
            _config = config;
        }

        public sealed class Candidate
        {
            public long GridEntityId;
            public string BlockName = "";
            public string Goal = "hover";
            public bool OwnerOk;
            public List<string> Missing = new List<string>();

            public bool Safe
            {
                get { return OwnerOk && Missing.Count == 0; }
            }
        }

        /// <summary>Returns newly seen candidates only (deduped per block).</summary>
        public List<Candidate> Scan()
        {
            var found = new List<Candidate>();
            foreach (var grid in _loader.GetGrids())
            {
                if (grid == null || grid.Closed) continue;

                foreach (var pb in grid.GetFatBlocks<IMyProgrammableBlock>())
                {
                    if (pb == null) continue;

                    var name = pb.CustomName ?? "";
                    var data = pb.CustomData ?? "";
                    if (name.IndexOf(Tag, StringComparison.OrdinalIgnoreCase) < 0 && !ReadyLine.IsMatch(data))
                        continue;

                    var key = grid.EntityId + ":" + pb.EntityId;
                    if (_reported.Contains(key)) continue;
                    _reported.Add(key);

                    var c = new Candidate
                    {
                        GridEntityId = grid.EntityId,
                        BlockName = name,
                        Goal = ParseGoal(data),
                        OwnerOk = Ownership.IsOwned(grid, _config),
                    };
                    Preflight(grid, c);
                    found.Add(c);
                }
            }
            return found;
        }

        public void Forget(long gridEntityId)
        {
            var prefix = gridEntityId + ":";
            var stale = new List<string>();
            foreach (var key in _reported)
                if (key.StartsWith(prefix, StringComparison.Ordinal)) stale.Add(key);
            foreach (var key in stale) _reported.Remove(key);
        }

        private static string ParseGoal(string customData)
        {
            var m = GoalLine.Match(customData ?? "");
            if (!m.Success) return "hover";
            var goal = m.Groups[1].Value.ToLowerInvariant();
            switch (goal)
            {
                case "hover":
                case "orbit":
                case "interplanetary":
                case "crash":
                    return goal;
                default:
                    return "hover"; // invalid goal falls back; backend also validates
            }
        }

        /// <summary>Enough to tell the owner what is missing; not a full design review.</summary>
        private static void Preflight(IMyCubeGrid grid, Candidate c)
        {
            int thrusters = 0, gyros = 0;
            double powerCapacity = 0;

            foreach (var t in grid.GetFatBlocks<IMyThrust>())
                if (t != null && t.IsFunctional) thrusters++;
            foreach (var g in grid.GetFatBlocks<IMyGyro>())
                if (g != null && g.IsFunctional) gyros++;
            foreach (var b in grid.GetFatBlocks<IMyBatteryBlock>())
                if (b != null) powerCapacity += b.MaxStoredPower;
            // VERIFY: reactor enumeration and CurrentOutput on this build.
            foreach (var r in grid.GetFatBlocks<IMyReactor>())
                if (r != null && r.IsFunctional) powerCapacity += 1;

            // VERIFY: cockpit/remote-control enumeration shape.
            bool hasControl = false;
            foreach (var rc in grid.GetFatBlocks<IMyRemoteControl>())
                if (rc != null && rc.IsFunctional) hasControl = true;
            if (!hasControl)
            {
                foreach (var ck in grid.GetFatBlocks<IMyCockpit>())
                    if (ck != null && ck.IsFunctional) hasControl = true;
            }

            if (thrusters == 0) c.Missing.Add("no functional thrusters");
            if (gyros == 0) c.Missing.Add("no functional gyro");
            if (powerCapacity <= 0) c.Missing.Add("no battery/reactor power");
            if (!hasControl) c.Missing.Add("no remote control or cockpit");
            if (!c.OwnerOk) c.Missing.Add("grid owner is not the owner/our faction");
        }
    }
}
