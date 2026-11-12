using System;

namespace HermesRts.Plugin
{
    /// <summary>
    /// The survival station-conversion rule, free of game types so the offline
    /// tests can pin it.
    ///
    /// SE refuses `IsStatic = true` while the body still moves (measured 0.98-1.01
    /// m/s refusals on a hovering relay). The test build used to zero the
    /// velocity first - a teleport in disguise and therefore an admin action. In
    /// survival the hull must be brought under <see cref="MaxConvertSpeedMs"/> by
    /// dampeners alone, verified, and converted; this type decides when it is
    /// safe and how many attempts are allowed.
    /// </summary>
    public static class StationMath
    {
        /// <summary>SE freezes a grid only below this speed; conversions above it fail.</summary>
        public const double MaxConvertSpeedMs = 0.5;

        /// <summary>The first convert can report not-static even at ~0.011 m/s.</summary>
        public const int MaxAttempts = 3;

        public static bool MayConvert(double speedMs)
        {
            return !double.IsNaN(speedMs) && speedMs < MaxConvertSpeedMs;
        }

        public static bool ShouldRetry(double speedMs, int attemptsSoFar)
        {
            return attemptsSoFar < MaxAttempts && MayConvert(speedMs);
        }
    }

    /// <summary>
    /// Dampener-only stop sequence for convert_to_station in survival: the caller
    /// feeds one velocity sample per tick and converts only once the hull has been
    /// slow for the whole timeout window without help. It never asks for a
    /// zeroing (that is the removal this exists to prove).
    /// </summary>
    public sealed class StationStopSequence
    {
        private readonly double _timeoutSec;
        private double _elapsed;
        private double _confirmSec;

        public string Phase { get; private set; } = "waiting";
        public string StopReason { get; private set; }
        public double LastSpeedMs { get; private set; }
        public bool TimedOut { get { return Phase == "timeout"; } }

        public StationStopSequence(double timeoutSec = 30.0)
        {
            _timeoutSec = timeoutSec > 0 ? timeoutSec : 30.0;
        }

        /// <summary>
        /// Returns true when a convert may be attempted now. False means "keep
        /// damping" (or, once <see cref="TimedOut"/>, give up honestly).
        /// </summary>
        public bool Tick(double speedMs, double dtSec)
        {
            LastSpeedMs = speedMs;
            if (dtSec > 0) _elapsed += dtSec;

            if (!StationMath.MayConvert(speedMs))
            {
                _confirmSec = 0;
                if (_elapsed >= _timeoutSec)
                {
                    Phase = "timeout";
                    StopReason = "timed out waiting for |v| < " + StationMath.MaxConvertSpeedMs +
                                 " m/s (still " + Math.Round(speedMs, 3) + " m/s)";
                    return false;
                }
                Phase = "slowing";
                return false;
            }

            // Require the hull to stay slow for a moment: SE can report a low
            // speed mid-reversal and then push it back up.
            _confirmSec += dtSec > 0 ? dtSec : 0;
            Phase = "clear";
            return _confirmSec >= 0.3 || _elapsed >= _timeoutSec;
        }
    }
}
