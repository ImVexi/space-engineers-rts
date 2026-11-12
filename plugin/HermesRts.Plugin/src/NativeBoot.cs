using System;
using System.Diagnostics;
using Sandbox.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Native dedicated-server entry point. Space Engineers loads this through
    /// VRage.Plugins.IPlugin (cfg &lt;Plugins&gt; or "-plugin &lt;dll&gt;"), so the
    /// assembly must be a plain library with a public parameterless class that
    /// implements IPlugin.
    ///
    /// Init() runs before the world exists, so the plugin's own Init is deferred
    /// until a session and the entity system are present.
    /// </summary>
    public sealed class HermesRtsBoot : VRage.Plugins.IPlugin
    {
        private DsLoaderAdapter _adapter;
        private Plugin _plugin;
        private readonly Stopwatch _clock = new Stopwatch();
        private TimeSpan _last;
        private bool _failed;
        private int _waitLogged;

        public void Init(object gameInstance)
        {
            _adapter = new DsLoaderAdapter();
            _adapter.Log("info", "hermes-rts native DS plugin assembly loaded (IPlugin.Init, gameInstance=" +
                (gameInstance == null ? "null" : gameInstance.GetType().FullName) + ")");
            _clock.Start();
            _last = _clock.Elapsed;
        }

        public void Dispose()
        {
            try
            {
                if (_plugin != null) { _plugin.Dispose(); _plugin = null; }
                _adapter.Log("info", "hermes-rts plugin disposed (DS shutdown)");
            }
            catch (Exception ex) { _adapter.Log("error", "dispose failed: " + ex); }
        }

        public void Update()
        {
            if (_failed) return;

            var now = _clock.Elapsed;
            var dt = (now - _last).TotalSeconds;
            _last = now;

            if (_plugin == null)
            {
                if (MyAPIGateway.Session == null || MyAPIGateway.Entities == null)
                {
                    if (_waitLogged++ % 600 == 0)
                        _adapter.Log("info", "waiting for session/entities before plugin init (Update is ticking)");
                    return;
                }
                try
                {
                    _plugin = new Plugin();
                    _plugin.Init(_adapter);
                }
                catch (Exception ex)
                {
                    _failed = true;
                    _adapter.Log("error", "plugin init failed: " + ex);
                    return;
                }
                return;
            }

            _adapter.RaiseTick(dt);
        }
    }
}
