using System;
using HermesRts.Plugin;

// Offline unit tests for grid power accounting and the survival loop's
// power runway. No game, no network: run with `dotnet run` in this directory.
// Exit code 0 = all pass.
//
// The numbers are the ones MEASURED in game on the test world
// (data/survival-loop-verify-20261111.md): SAT-R-0001, 3 MWh battery at 100 %,
// chargeState `discharging`, battery CurrentOutput 1.7043 MW, and a device draw
// of 0.2001 MW (derived from the old reported netMw of +1.5042 MW).
internal static class Program
{
    private static int _pass;
    private static int _fail;

    private static void Check(string name, bool ok, string detail = "")
    {
        if (ok) { _pass++; Console.WriteLine("PASS " + name); }
        else { _fail++; Console.WriteLine("FAIL " + name + (detail.Length > 0 ? " :: " + detail : "")); }
    }

    private static void Near(string name, double? actual, double expected, double tol)
    {
        var ok = actual != null && Math.Abs((double)actual - expected) <= tol;
        Check(name, ok, "got " + (actual == null ? "null" : actual.ToString()) + " expected " + expected + " +/- " + tol);
    }

    private static int Main()
    {
        // --- measured SAT-R-0001: battery discharging, no generation ----------
        const double StoredMWh = 3;          // 3 of 3 MWh, 100 %
        const double BatteryOutMw = 1.7043;  // the battery's own CurrentOutput
        const double BatteryInMw = 0;
        const double ConsumerDrawMw = 0.2001; // device draw, batteries excluded
        const double OldReportedNetMw = 1.5042; // what the defect published

        var state = PowerMath.ChargeState(BatteryInMw, BatteryOutMw);
        Check("charge state is discharging for the measured grid", state == "discharging", state);

        // The defect: battery output counted as production -> positive net.
        var buggyNet = PowerMath.GenerationMw(0, 0, 0) + BatteryOutMw - BatteryInMw - ConsumerDrawMw;
        Near("regression: the old formula gives the measured +1.5042 MW", buggyNet, OldReportedNetMw, 0.0001);
        Check("regression: a positive net has no runway (that was the blocker)",
            PowerMath.RunwayMin(StoredMWh, buggyNet) == null);

        // The fix: production 0, consumption 0.2001 -> the battery carries it.
        var generation = PowerMath.GenerationMw(0, 0, 0);
        var net = PowerMath.NetMw(generation, ConsumerDrawMw);
        Near("net is negative for a battery-only grid", net, -ConsumerDrawMw, 1e-9);
        Near("runway = stored MWh / |net| in minutes", PowerMath.RunwayMin(StoredMWh, net), 3 / 0.2001 * 60, 0.11);
        Check("runway is finite (the loop can now judge the return)",
            PowerMath.RunwayMin(StoredMWh, net) is double m && m > 0 && !double.IsInfinity(m));
        Check("runway reason says draining", PowerMath.RunwayReason(true, state, net) == "draining");

        // --- generation counts every producer --------------------------------
        Near("solar + reactor + H2 engine/wind all count as production",
            PowerMath.GenerationMw(0.5, 0.25, 0.3), 1.05, 1e-9);
        var mixed = PowerMath.NetMw(PowerMath.GenerationMw(0.5, 0.25, 0.3), 1.7);
        Near("a partially powered grid still drains", mixed, -0.65, 1e-9);
        Near("its runway is stored / 0.65 MW", PowerMath.RunwayMin(StoredMWh, mixed), 3 / 0.65 * 60, 0.11);

        // --- charging: null with a reason, never 0 ----------------------------
        var charging = PowerMath.ChargeState(0.8, 0);
        Check("charge state is charging", charging == "charging", charging);
        var chargeNet = PowerMath.NetMw(PowerMath.GenerationMw(1.0, 0, 0), 0.2);
        Near("charging grid has a positive net", chargeNet, 0.8, 1e-9);
        Check("no runway while charging", PowerMath.RunwayMin(StoredMWh, chargeNet) == null);
        Check("and it says why: charging", PowerMath.RunwayReason(true, charging, chargeNet) == "charging");
        // Surfaced as a positive net, an H2-engine surplus is "charging" too.
        Check("a surplus with idle batteries is still not a drain",
            PowerMath.RunwayReason(true, "idle", 0.4) == "charging");

        // --- edge cases -------------------------------------------------------
        Check("no battery -> reason absent", PowerMath.RunwayReason(false, "idle", -1) == "absent");
        Check("no battery -> no runway", PowerMath.RunwayMin(0, -1) == null);
        Check("idle grid -> reason idle", PowerMath.RunwayReason(true, "idle", 0) == "idle");
        Check("idle grid -> no runway", PowerMath.RunwayMin(StoredMWh, 0) == null);
        Check("noise under the drain epsilon is not a drain", PowerMath.RunwayMin(StoredMWh, -0.0005) == null);
        Check("a real deficit over the epsilon is a drain", PowerMath.RunwayMin(StoredMWh, -0.002) != null);
        Check("no stored charge -> no runway (null, not 0)", PowerMath.RunwayMin(0, -1) == null);
        Check("a negative stored figure is unread, not empty", PowerMath.RunwayMin(-1, -1) == null);
        Check("NaN net -> no runway", PowerMath.RunwayMin(StoredMWh, double.NaN) == null);
        Check("infinite stored -> no runway", PowerMath.RunwayMin(double.PositiveInfinity, -1) == null);
        Check("idle batteries with no flow", PowerMath.ChargeState(0, 0) == "idle");

        Console.WriteLine();
        Console.WriteLine(_fail == 0
            ? "power-math: " + _pass + " passed"
            : "power-math: " + _pass + " passed, " + _fail + " FAILED");
        return _fail == 0 ? 0 : 1;
    }
}
