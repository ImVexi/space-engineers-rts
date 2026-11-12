using System;
using HermesRts.Plugin;

// Offline unit tests for the T25 level-mode control law. No game, no network:
// run with `dotnet run` in this directory. Exit code 0 = all assertions pass.
internal static class Program
{
    private static int _pass;
    private static int _fail;

    private static void Check(string name, bool ok, string detail = "")
    {
        if (ok) { _pass++; Console.WriteLine("PASS " + name); }
        else { _fail++; Console.WriteLine("FAIL " + name + (detail.Length > 0 ? " :: " + detail : "")); }
    }

    private static void Near(string name, double actual, double expected, double tol)
    {
        Check(name, Math.Abs(actual - expected) <= tol, "got " + actual + " expected " + expected + " +/- " + tol);
    }

    private static int Main()
    {
        // --- tilt
        Near("tilt: level grid is 0 deg", LevelMath.TiltDeg(1.0), 0, 1e-9);
        Near("tilt: 10 deg", LevelMath.TiltDeg(Math.Cos(10 * Math.PI / 180)), 10, 1e-6);
        Near("tilt: upside down is 180 deg", LevelMath.TiltDeg(-1.0), 180, 1e-6);
        Near("tilt: dot clamped above 1", LevelMath.TiltDeg(1.4), 0, 1e-9);
        Near("tilt: dot clamped below -1", LevelMath.TiltDeg(-3.0), 180, 1e-6);

        // --- vertical PD
        // On altitude, no speed -> no command.
        Near("vert: on target, still", LevelMath.VerticalAccel(100, 100, 0, 0.55, 1.7, 4.0, 4.0), 0, 1e-9);
        // 10 m low -> climb command, positive.
        Check("vert: below target climbs", LevelMath.VerticalAccel(100, 90, 0, 0.55, 1.7, 4.0, 4.0) > 0);
        // 10 m high -> descend command, negative.
        Check("vert: above target descends", LevelMath.VerticalAccel(100, 110, 0, 0.55, 1.7, 4.0, 4.0) < 0);
        // Climbing fast at the target -> brakes (negative command).
        Check("vert: fast climb at target brakes", LevelMath.VerticalAccel(100, 100, 5, 0.55, 1.7, 4.0, 4.0) < 0);
        // Clamps.
        Near("vert: clamp up", LevelMath.VerticalAccel(1000, 0, 0, 0.55, 1.7, 2.5, 4.0), 2.5, 1e-9);
        Near("vert: clamp down", LevelMath.VerticalAccel(0, 1000, 0, 0.55, 1.7, 4.0, 1.5), -1.5, 1e-9);
        // Lift-only hull: maxUpAccel=0 still allowed to command 0.05 (the
        // controller floors it) — here the pure function clamps to 0.
        Near("vert: no lift authority cannot climb", LevelMath.VerticalAccel(100, 0, 0, 0.55, 1.7, 0.0, 4.0), 0, 1e-9);

        // --- horizontal PD
        double ax, az;
        LevelMath.HorizontalAccel(0, 0, 0, 0, 0.22, 1.1, 3.0, 3.0, out ax, out az);
        Check("horiz: on target, still -> no command", Math.Abs(ax) < 1e-9 && Math.Abs(az) < 1e-9);
        LevelMath.HorizontalAccel(10, 0, 0, 0, 0.22, 1.1, 3.0, 3.0, out ax, out az);
        Check("horiz: east error -> east command", ax > 0 && Math.Abs(az) < 1e-9);
        LevelMath.HorizontalAccel(10, 0, 5, 0, 0.22, 1.1, 3.0, 3.0, out ax, out az);
        Check("horiz: moving toward target fast enough -> brakes/none", ax <= 0.0 || ax < 0.22 * 10);
        LevelMath.HorizontalAccel(1000, 0, 0, 0, 0.22, 1.1, 3.0, 10.0, out ax, out az);
        Check("horiz: accel capped", Math.Abs(ax) <= 3.0 + 1e-9);
        LevelMath.HorizontalAccel(0, 0, 8, 0, 0.22, 1.1, 3.0, 3.0, out ax, out az);
        Check("horiz: over speed cap -> pure brake", ax < 0 && Math.Abs(az) < 1e-9);

        // --- thrust distribution
        Near("axis: half capacity", LevelMath.AxisOverride(500, 1000), 0.5, 1e-9);
        Near("axis: over capacity clamps to 1", LevelMath.AxisOverride(5000, 1000), 1.0, 1e-9);
        Near("axis: opposing force is zero", LevelMath.AxisOverride(-500, 1000), 0.0, 1e-9);
        Near("axis: no capacity is zero", LevelMath.AxisOverride(500, 0), 0.0, 1e-9);

        // --- guards
        Near("floor: 100 m target keeps 25 m floor", LevelMath.GroundFloor(100), 25, 1e-9);
        Near("floor: 10 m target lowers the floor", LevelMath.GroundFloor(10), 7, 1e-9);
        Near("floor: 2 m target never below 2 m", LevelMath.GroundFloor(1), 2, 1e-9);
        Near("brake: 10 m/s at 2 m/s2", LevelMath.BrakeDistance(10, 2), 25, 1e-9);
        Check("brake: no decel is unbounded", LevelMath.BrakeDistance(10, 0) >= double.MaxValue);

        // --- start refusals (policy)
        Check("refuse: static", LevelMath.StartRefusal(true, true, 9.8, 0, 10, 1000, 100, 100, 0, false) != null);
        Check("refuse: no physics", LevelMath.StartRefusal(false, false, 9.8, 0, 10, 1000, 100, 100, 0, false) != null);
        Check("refuse: zero-g", LevelMath.StartRefusal(false, true, 0, 0, 10, 1000, 100, 100, 0, false) != null);
        Check("refuse: tilt at start", LevelMath.StartRefusal(false, true, 9.8, 15, 10, 1000, 100, 100, 0, false) != null);
        Check("refuse: lift below weight", LevelMath.StartRefusal(false, true, 9.8, 0, 10, 900, 100, 100, 0, false) != null);
        Check("refuse: manual control", LevelMath.StartRefusal(false, true, 9.8, 0, 10, 5000, 100, 100, 0, true) != null);
        Check("accept: healthy atmo hull", LevelMath.StartRefusal(false, true, 9.8, 0, 10, 5000, 100, 100, 0, false) == null);

        // --- lift sign and a whole controller step
        Near("lift sign: push direction", LevelMath.LiftSign(0.99), 1.0, 1e-9);
        Near("lift sign: exhaust direction", LevelMath.LiftSign(-0.99), -1.0, 1e-9);

        // SAT-R-0001-like hull: 37,650 kg, 12 atmo thrusters with 5.73 TWR at
        // 1 g -> 2.11 MN of lift. Holding 50 m up on a 30 m AGL error must ask
        // for a fraction of the lift bank, never more than 45 % of g.
        var mass = 37650.0;
        var g = 9.81;
        var aCmd = LevelMath.VerticalAccel(80, 50, 0, 0.55, 1.7, 0.45 * g, 0.45 * g);
        var fUp = mass * (g + aCmd);
        Near("sample: hold 30 m low asks +2.86 m/s2", aCmd, 16.5, 18.0);
        Check("sample: force stays under lift capacity", fUp < 2_110_000);
        var overridePct = LevelMath.AxisOverride(fUp, 2_110_000);
        Check("sample: override is a sane fraction", overridePct > 0.1 && overridePct < 0.6,
            "override " + overridePct);

        Console.WriteLine();
        Console.WriteLine(_pass + " passed, " + _fail + " failed");
        return _fail == 0 ? 0 : 1;
    }
}
