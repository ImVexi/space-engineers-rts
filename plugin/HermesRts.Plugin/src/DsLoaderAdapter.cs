using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRage.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Loader adapter for the native Space Engineers dedicated-server plugin
    /// host (VRage.Plugins.IPlugin). No Torch, Pulsar or Magnetar is involved:
    /// the assembly is loaded by SE itself and ticks from IPlugin.Update().
    ///
    /// Verified against 01_210_014 via reflection (plugin/refs):
    ///   VRage.Plugins.IPlugin      Init(object gameInstance), Update()
    ///   VRage.Plugins.MyPlugins    RegisterFromArgs(string[], bool)  ("-plugin" switch)
    ///   Sandbox.ModAPI.MyAPIGateway.Entities : VRage.ModAPI.IMyEntities
    ///   VRage.ModAPI.IMyEntities.GetEntities(HashSet, Func)
    /// </summary>
    public sealed class DsLoaderAdapter : ILoaderAdapter
    {
        private static readonly object LogLock = new object();
        /**
         * plugin.log rotation (sim-speed audit #9). The plugin writes one line
         * per order plus one event frame line, ~140 B/order: at the measured
         * 48 orders/min that is ~350 KB/h and ~8 MB/day, and nothing ever
         * trimmed it. Cap the live file at 20 MB and keep 3 older files, so a
         * long-running server cannot fill its disk with poller chatter.
         */
        private const long MaxLogBytes = 20L * 1024 * 1024;
        private const int KeepLogFiles = 3;
        /** Rotate checks are cheap but not free: one every N appended lines. */
        private const int RotateCheckEvery = 256;
        private readonly List<Action<double>> _ticks = new List<Action<double>>();
        private readonly string _dir;
        private readonly string _logPath;
        private int _logLines;

        public DsLoaderAdapter()
        {
            _dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? ".";
            _logPath = Path.Combine(_dir, "plugin.log");
        }

        public string LoaderName { get { return "se-native"; } }

        public void Log(string level, string message)
        {
            var line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " [" + level + "] " + message;
            // stdout is captured by docker logs; the file survives restarts.
            try { Console.WriteLine("HERMES-RTS " + line); } catch { }
            try
            {
                lock (LogLock)
                {
                    File.AppendAllText(_logPath, line + Environment.NewLine);
                    _logLines++;
                    if (_logLines % RotateCheckEvery == 0) RotateIfNeeded();
                }
            }
            catch { /* logging must never take the game down */ }
        }

        /// <summary>
        /// plugin.log -> plugin.log.1 -> ... -> plugin.log.3, oldest dropped.
        /// Called under LogLock only, so two log lines cannot race a rename.
        /// </summary>
        private void RotateIfNeeded()
        {
            try
            {
                var live = new FileInfo(_logPath);
                if (!live.Exists || live.Length < MaxLogBytes) return;
                // .3 is dropped, .2 -> .3, .1 -> .2, live -> .1.
                for (var i = KeepLogFiles; i >= 1; i--)
                {
                    var target = _logPath + "." + i;
                    if (File.Exists(target)) File.Delete(target);
                    var source = i == 1 ? _logPath : _logPath + "." + (i - 1);
                    if (File.Exists(source)) File.Move(source, target);
                }
                _logLines = 0;
                File.AppendAllText(
                    _logPath,
                    DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " [info] plugin.log rotated at " +
                    MaxLogBytes + " bytes (keeping " + KeepLogFiles + ")\n");
            }
            catch { /* a failed rotation must never stop logging or the game */ }
        }

        public IReadOnlyList<IMyCubeGrid> GetGrids()
        {
            var result = new List<IMyCubeGrid>();
            var entities = MyAPIGateway.Entities;
            if (entities == null) return result;
            var raw = new HashSet<IMyEntity>();
            entities.GetEntities(raw, e => e is IMyCubeGrid);
            foreach (var e in raw)
            {
                var grid = e as IMyCubeGrid;
                if (grid != null) result.Add(grid);
            }
            return result;
        }

        public IMyCubeGrid GetGridById(long entityId)
        {
            var entities = MyAPIGateway.Entities;
            if (entities == null) return null;
            IMyEntity entity;
            if (!entities.TryGetEntityById(entityId, out entity)) return null;
            return entity as IMyCubeGrid;
        }

        public void RegisterTick(Action<double> tick)
        {
            if (tick != null) _ticks.Add(tick);
        }

        public string ResolvePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return _dir;
            return Path.IsPathRooted(path) ? path : Path.Combine(_dir, path);
        }

        /// <summary>Called by the IPlugin shim once per game update.</summary>
        public void RaiseTick(double dt)
        {
            for (var i = 0; i < _ticks.Count; i++)
            {
                try { _ticks[i](dt); }
                catch (Exception ex) { Log("error", "tick handler threw: " + ex); }
            }
        }
    }
}
