using System;
using System.Collections.Generic;

namespace HermesRts.Plugin
{
    /// <summary>
    /// DEAD-MAN FOR DAMPENERS THE BACKEND TURNED OFF.
    ///
    /// WHY. The backend's landing path releases the dampeners to let a hull
    /// fall, and it re-asserts control on its own event loop. Measured
    /// 2026-11-10: an external 1 Hz sampler starved that loop mid-fall, no
    /// order arrived for 12.3 s and the hull hit the ground at 57 m/s with its
    /// dampeners still off (SAT-R-0001, 24 blocks lost). Ship safety must not
    /// depend on the backend keeping up, so the plugin treats "dampeners off
    /// with no owner" as a lease: any backend order for that grid renews it,
    /// and 6 s without one puts the dampeners back ON locally.
    ///
    /// EXEMPT: grids under a plugin-owned job (land_at / level_*) hold control
    /// themselves every tick, so their dampeners really are supposed to be off.
    ///
    /// PURE ON PURPOSE (no game types, no Newtonsoft): the same file compiles
    /// into the plugin and into the offline test program
    /// (tests/land-math), so the lease logic is unit-tested without the game.
    /// Time is passed in as dt; the caller is the game thread.
    /// </summary>
    public sealed class DampenerDeadman
    {
        /// <summary>How long a grid may sit with dampeners off and no backend order, s.</summary>
        public const double TimeoutSec = 6.0;

        public static readonly DampenerDeadman Instance = new DampenerDeadman();

        private sealed class Lease
        {
            public double RenewedAtSec;
            public string Source;
            public double ArmedAtSec;
        }

        private readonly Dictionary<long, Lease> _leases = new Dictionary<long, Lease>();
        private double _nowSec;
        private long _restoredCount;

        /// <summary>
        /// Called when a lease expires: (gridId, source, idleSeconds). The plugin
        /// installs a game-thread callback that sets DampenersOverride = true.
        /// </summary>
        public Action<long, string, double> Restore = (id, source, idle) => { };

        /// <summary>Grids currently holding an unowned "dampeners off" lease.</summary>
        public int LeaseCount { get { return _leases.Count; } }

        /// <summary>Total restores this process (for status/logs).</summary>
        public long RestoredCount { get { return _restoredCount; } }

        public double NowSec { get { return _nowSec; } }

        private static bool Ok(double v)
        {
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        /// <summary>
        /// The backend set dampeners OFF on this grid. Owned grids are exempt
        /// (their controller holds the ship every tick); everything else starts
        /// or renews a 6 s lease.
        /// </summary>
        public void NoteDampenersOff(long gridId, bool ownedByJob, string source)
        {
            if (ownedByJob) { _leases.Remove(gridId); return; }
            Lease lease;
            if (_leases.TryGetValue(gridId, out lease))
            {
                lease.RenewedAtSec = _nowSec;
                if (!string.IsNullOrEmpty(source)) lease.Source = source;
                return;
            }
            _leases[gridId] = new Lease
            {
                RenewedAtSec = _nowSec,
                ArmedAtSec = _nowSec,
                Source = string.IsNullOrEmpty(source) ? "dampeners off" : source,
            };
        }

        /// <summary>Any backend order for this grid renews the lease.</summary>
        public void NoteOrder(long gridId)
        {
            Lease lease;
            if (_leases.TryGetValue(gridId, out lease)) lease.RenewedAtSec = _nowSec;
        }

        /// <summary>The backend turned them back on (or the grid is gone): no lease.</summary>
        public void NoteDampenersOn(long gridId)
        {
            _leases.Remove(gridId);
        }

        /// <summary>The grid came under a plugin-owned job: the controller owns the dampeners.</summary>
        public void NoteOwned(long gridId)
        {
            _leases.Remove(gridId);
        }

        /// <summary>
        /// Game thread, every tick. Expired leases restore the dampeners and are
        /// dropped. <paramref name="owned"/> answers "is a plugin job flying this
        /// grid NOW" (a job may start after the lease was taken).
        /// </summary>
        public void Tick(double dt, Func<long, bool> owned)
        {
            if (Ok(dt) && dt > 0) _nowSec += dt;
            if (_leases.Count == 0) return;

            List<long> expired = null;
            foreach (var kv in _leases)
            {
                if (_nowSec - kv.Value.RenewedAtSec < TimeoutSec) continue;
                if (expired == null) expired = new List<long>();
                expired.Add(kv.Key);
            }
            if (expired == null) return;

            foreach (var gridId in expired)
            {
                var lease = _leases[gridId];
                _leases.Remove(gridId);
                if (owned != null && owned(gridId))
                {
                    // A plugin job took the grid while the lease ran out: it owns
                    // the dampeners, so leave them alone and say nothing.
                    continue;
                }
                _restoredCount++;
                try
                {
                    Restore(gridId, lease.Source, _nowSec - lease.ArmedAtSec);
                }
                catch { }
            }
        }
    }
}
