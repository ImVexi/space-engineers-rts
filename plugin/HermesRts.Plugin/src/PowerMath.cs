using System;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Grid power accounting: what counts as production, what counts as
    /// consumption, and the battery runway those two imply.
    ///
    /// Batteries are STORAGE, never production. The old sum in `profile`
    ///   netMw = solar + reactor + batteryOut - batteryIn - deviceDraw
    /// counted a discharging battery's own CurrentOutput as if it were a
    /// generator, and the device sum already contained the battery's resource
    /// sink, so charging input was subtracted twice. Measured on SAT-R-0001:
    /// chargeState `discharging`, battery output 1.7043 MW, netMw **+1.5042 MW**.
    /// `computeRunway()` only answers when net < 0, so powerRunwayMin was null on
    /// all 10 grids with power telemetry and the survival loop could never fire.
    ///
    /// Correct model:
    ///   production  = solar + reactors + H2 engines + wind turbines (+ any
    ///                 other power producer) current output
    ///   consumption = the sum of non-battery consumers' current input
    ///   net         = production - consumption
    ///   net < 0     -> the batteries discharge, runway = stored MWh / |net|
    ///   net >= 0    -> nothing drains; the runway is null *with a reason*
    ///                  ("charging" / "idle"), never 0 and never a fake number.
    ///
    /// Pure C# with no game references, so both plugin builds and the offline
    /// harness (tests/power-math) compile the same numbers.
    /// </summary>
    public static class PowerMath
    {
        /// <summary>Below this a power flow is noise, not a reading (MW).</summary>
        public const double EpsilonMw = 0.0005;

        /// <summary>A deficit smaller than this is not a projected drain (MW).</summary>
        public const double DrainEpsilonMw = 0.001;

        /// <summary>
        /// `charging` when the battery bank takes more than it gives, `discharging`
        /// when it gives power, `idle` when neither side reads a flow.
        /// </summary>
        public static string ChargeState(double batteryInputMw, double batteryOutputMw)
        {
            if (batteryInputMw > EpsilonMw && batteryInputMw >= batteryOutputMw) return "charging";
            if (batteryOutputMw > EpsilonMw) return "discharging";
            return "idle";
        }

        /// <summary>Everything a grid generates right now, MW.</summary>
        public static double GenerationMw(double solarActualMw, double reactorOutputMw, double otherGenerationMw)
        {
            return solarActualMw + reactorOutputMw + otherGenerationMw;
        }

        /// <summary>
        /// Net flow, MW: positive = surplus, negative = the batteries carry the
        /// deficit. `consumptionMw` must never include battery charging input.
        /// </summary>
        public static double NetMw(double generationMw, double consumptionMw)
        {
            return generationMw - consumptionMw;
        }

        /// <summary>
        /// Minutes of battery left at the projected deficit, or null when the grid
        /// is not draining. Never 0 for an unknown: null means "no projected
        /// drain", and <see cref="RunwayReason"/> says which one it is.
        /// </summary>
        public static double? RunwayMin(double storedMWh, double netMw)
        {
            // 0 MWh is ambiguous (an empty battery, or a battery block whose read
            // failed and contributed nothing) - "no runway" with a reason, never 0.
            if (!(storedMWh > 0)) return null;
            if (!(netMw < -DrainEpsilonMw)) return null;
            var minutes = storedMWh / -netMw * 60.0;
            if (double.IsNaN(minutes) || double.IsInfinity(minutes) || minutes < 0) return null;
            return Math.Round(minutes, 1);
        }

        /// <summary>
        /// Why the runway above is null. "charging" and "idle" are answers, not
        /// missing readings, so the site can print a reason instead of "—".
        /// </summary>
        public static string RunwayReason(bool hasBattery, string chargeState, double netMw)
        {
            if (!hasBattery) return "absent";
            if (netMw < -DrainEpsilonMw) return "draining";
            if (string.Equals(chargeState, "charging", StringComparison.Ordinal)) return "charging";
            if (netMw > DrainEpsilonMw) return "charging";
            return "idle";
        }
    }
}
