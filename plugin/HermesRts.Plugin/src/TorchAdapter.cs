#if HERMES_TORCH
// Torch loader shim — TEMPLATE, not expected to compile without Torch refs.
// Only this file should need to change if Torch is chosen (build-plan R13).
using System;
using System.Collections.Generic;
using Torch;
using Torch.API;
using Torch.API.Managers;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    public sealed class TorchAdapter : ILoaderAdapter
    {
        private readonly ITorchBase _torch;
        private readonly List<Action<double>> _ticks = new List<Action<double>>();

        public TorchAdapter(ITorchBase torch)
        {
            _torch = torch;
        }

        public string LoaderName { get { return "torch"; } }

        public void Log(string level, string message)
        {
            // VERIFY: Torch logging entry point.
            _torch.Log.WriteLine("[" + level + "] " + message);
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
            // VERIFY: Torch per-tick hook. Torch's game-loop event / update
            // manager is version-specific; this is a placeholder until pinned.
            _ticks.Add(tick);
        }

        public string ResolvePath(string path)
        {
            return System.IO.Path.IsPathRooted(path)
                ? path
                : System.IO.Path.Combine(_torch.ConfigDirectory, path); // VERIFY
        }
    }
}
#endif
