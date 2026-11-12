#if HERMES_PULSAR
// Pulsar/Magnetar loader shim — TEMPLATE, not expected to compile without the
// Pulsar SDK refs. Only this file should need to change if Pulsar is chosen.
using System;
using System.Collections.Generic;
using Pulsar;
using Pulsar.Api;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    public sealed class PulsarAdapter : ILoaderAdapter
    {
        private readonly PluginBase _plugin;
        private readonly List<Action<double>> _ticks = new List<Action<double>>();

        public PulsarAdapter(PluginBase plugin)
        {
            _plugin = plugin;
        }

        public string LoaderName { get { return "pulsar"; } }

        public void Log(string level, string message)
        {
            // VERIFY: Pulsar logging entry point.
            _plugin.Log.Info("[" + level + "] " + message);
        }

        public IReadOnlyList<IMyCubeGrid> GetGrids()
        {
            var result = new List<IMyCubeGrid>();
            var entities = new HashSet<VRage.Game.Entity.MyEntity>();
            Sandbox.ModAPI.MyAPIGateway.Entities.GetEntities(entities); // VERIFY: signature
            foreach (var e in entities)
            {
                var grid = e as IMyCubeGrid;
                if (grid != null) result.Add(grid);
            }
            return result;
        }

        public IMyCubeGrid GetGridById(long entityId)
        {
            foreach (var g in GetGrids())
                if (g.EntityId == entityId) return g;
            return null;
        }

        public void RegisterTick(Action<double> tick)
        {
            // VERIFY: Pulsar update hook (IUpdateable / game-loop manager).
            _ticks.Add(tick);
        }

        public string ResolvePath(string path)
        {
            return System.IO.Path.IsPathRooted(path)
                ? path
                : System.IO.Path.Combine(_plugin.StoragePath, path); // VERIFY
        }
    }
}
#endif
