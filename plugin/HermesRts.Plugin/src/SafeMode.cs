using System;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Watchdog. If the backend link has been silent for longer than the
    /// configured window, safe mode latches: command execution is refused and
    /// the plugin stops every autopilot it owns. A live link does not clear the
    /// latch by itself; a new order must arrive.
    /// </summary>
    public sealed class SafeMode
    {
        private readonly double _afterSeconds;
        private readonly Action<string, string> _log;
        private bool _active;

        public SafeMode(double afterSeconds, Action<string, string> log)
        {
            _afterSeconds = afterSeconds;
            _log = log;
        }

        public bool Active
        {
            get { return _active; }
        }

        /// <summary>Returns true only on the transition into safe mode.</summary>
        public bool Observe(TimeSpan sinceLastMessage, bool connected)
        {
            if (_active) return false;
            var stale = !connected || sinceLastMessage.TotalSeconds > _afterSeconds;
            if (!stale) return false;

            _active = true;
            _log("warn", "SAFE MODE: backend silent for " +
                (sinceLastMessage == TimeSpan.MaxValue ? "> window" : sinceLastMessage.TotalSeconds.ToString("F0") + " s"));
            return true;
        }

        /// <summary>Clears the latch after a verified backend message/order.</summary>
        public void Clear()
        {
            if (!_active) return;
            _active = false;
            _log("info", "safe mode cleared");
        }
    }
}
