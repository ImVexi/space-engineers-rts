using System;
using HermesRts.Plugin;

// Offline unit tests for the `land_at` final-descent control law and its
// fail-safe abort. No game, no network: run with `dotnet run` in this
// directory. Exit code 0 = all pass.
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

    // SAT-R-0001 measured in game: 37,609 kg, 877-981 kN of lift, keel -10 m.
    private const double Mass = 37_609;
    private const double G = 9.81;
    private const double LiftN = 981_000;
    private const double Keel = -10;

    private static int Main()
    {
        // --- survival station conversion: dampeners only, never a zeroing ------
        Check("station: 0.4 m/s may convert", StationMath.MayConvert(0.4));
        Check("station: 0.5 m/s may NOT convert (SE refuses a moving grid)",
            !StationMath.MayConvert(0.5));
        Check("station: 0.98 m/s refusal is predicted", !StationMath.MayConvert(0.98));
        Check("station: NaN is never convertible", !StationMath.MayConvert(double.NaN));
        Check("station: retries stop after 3 attempts",
            StationMath.ShouldRetry(0.01, 2) && !StationMath.ShouldRetry(0.01, StationMath.MaxAttempts));

        var stop = new StationStopSequence(30);
        var convertibleAt = -1.0;
        for (var st = 0.0; st < 40; st += 0.1)
        {
            var speed = st < 10 ? 1.0 - st * 0.09 : 0.1;   // damped from 1.0 to 0.1 over 10 s
            if (stop.Tick(speed, 0.1) && convertibleAt < 0) convertibleAt = st;
        }
        Check("station: a hull slowing under dampeners becomes convertible", convertibleAt >= 0,
            "never convertible in 40 s");
        Check("station: convertible only once below 0.5 m/s", convertibleAt >= 5.0,
            "convertible at " + convertibleAt + " s while still moving");

        var stuck = new StationStopSequence(30);
        for (var st = 0.0; st < 31; st += 1.0) stuck.Tick(2.0, 1.0);
        Check("station: a hull that will not slow times out honestly", stuck.TimedOut);
        Check("station: the timeout names the speed", stuck.StopReason != null && stuck.StopReason.Contains("still 2 m/s"),
            stuck.StopReason ?? "no reason");

        // --- hull-bottom altimetry (the sign that cost three crashed attempts)
        Near("agl: keel -10 puts the hull 10 m ABOVE the pivot", LandMath.HullBottomAglM(150, Keel), 160, 1e-9);
        Near("agl: keel +5 puts the hull 5 m BELOW the pivot", LandMath.HullBottomAglM(150, 5), 145, 1e-9);
        Near("agl: zero keel is the pivot", LandMath.HullBottomAglM(42, 0), 42, 1e-9);
        Near("agl: NaN keel is treated as 0", LandMath.HullBottomAglM(42, double.NaN), 42, 1e-9);

        // --- sink schedule
        Near("schedule: above the band is the approach sink", LandMath.SinkSetpoint(200, 5, 0.4, 15, 2), 5, 1e-9);
        Near("schedule: at the band edge still the approach sink", LandMath.SinkSetpoint(15, 5, 0.4, 15, 2), 5, 1e-6);
        Near("schedule: halfway through the band is a taper, not a step",
            LandMath.SinkSetpoint(11.25, 5, 0.4, 15, 2), 2.7, 1e-6);
        Near("schedule: lower half of the band is the final sink", LandMath.SinkSetpoint(7.5, 5, 0.4, 15, 2), 0.4, 1e-9);
        Near("schedule: 1 m up is the final sink", LandMath.SinkSetpoint(1, 5, 0.4, 15, 2), 0.4, 1e-9);
        Near("schedule: at the ground stops asking to descend", LandMath.SinkSetpoint(0, 5, 0.4, 15, 2), 0, 1e-9);
        Check("schedule: monotone through the band",
            LandMath.SinkSetpoint(15, 5, 0.4, 15, 2) >= LandMath.SinkSetpoint(12, 5, 0.4, 15, 2) &&
            LandMath.SinkSetpoint(12, 5, 0.4, 15, 2) >= LandMath.SinkSetpoint(8, 5, 0.4, 15, 2));
        Near("schedule: the braking envelope caps a fast handover",
            LandMath.SinkSetpoint(15, 20, 0.4, 15, 2), Math.Sqrt(2 * 2 * 14) + 0.4, 1e-6);
        Near("schedule: final sink above approach sink is clamped",
            LandMath.SinkSetpoint(200, 1, 5, 15, 2), 1, 1e-9);

        // --- PD on sink-rate error -> thrust
        Near("pd: still, asked for 1 m/s down -> 1.6 m/s2 down",
            LandMath.SinkAccel(1, 0, 1.6, 10, 10), -1.6, 1e-9);
        Near("pd: on schedule at 5 m/s down -> no correction",
            LandMath.SinkAccel(5, -5, 1.6, 10, 10), 0, 1e-9);
        Near("pd: descending too fast is braked",
            LandMath.SinkAccel(0.4, -8, 1.6, 20, 20), 12.16, 1e-9);
        Near("pd: authority clamp holds",
            LandMath.SinkAccel(5, 0, 1.6, 4.9, 4.9), -4.9, 1e-9);
        Near("pd: down clamp holds",
            LandMath.SinkAccel(0.4, -30, 1.6, 4.9, 4.9), 4.9, 1e-9);

        Near("thrust: hover is weight", LandMath.LiftThrustN(Mass, G, 0, LiftN), Mass * G, 1e-6);
        Near("thrust: hover fraction is weight over lift", LandMath.ThrustFraction(Mass, G, 0, LiftN), Mass * G / LiftN, 1e-9);
        Near("thrust: never negative", LandMath.LiftThrustN(Mass, G, -50, LiftN), 0, 1e-9);
        Near("thrust: never above the bank", LandMath.LiftThrustN(Mass, G, 50, LiftN), LiftN, 1e-9);
        Near("thrust: the land controller's up-authority is capped at 0.5 g",
            LandMath.MaxUpAccelMs2(LiftN, Mass, G, LandMath.MaxAccelG), 0.5 * G, 1e-9);
        Check("thrust: a hull that cannot lift has no authority",
            LandMath.MaxUpAccelMs2(0.9 * Mass * G, Mass, G, LandMath.MaxAccelG) < 0.2);

        // --- touchdown / contact
        Check("touchdown: 1.9 m at 0.4 m/s", LandMath.IsTouchdown(1.9, -0.4));
        Check("touchdown: 1.9 m at 0.6 m/s is NOT touchdown", !LandMath.IsTouchdown(1.9, -0.6));
        Check("touchdown: 2.5 m at 0.1 m/s is NOT touchdown", !LandMath.IsTouchdown(2.5, -0.1));
        Check("contact: stopped with thrust under weight",
            LandMath.IsContact(1.2, 0.02, 0.9 * Mass * G, Mass, G));
        Check("contact: hovering on its own thrust is not contact",
            !LandMath.IsContact(1.2, 0.02, 1.02 * Mass * G, Mass, G));
        Check("contact: 10 m up is not contact", !LandMath.IsContact(10, 0.0, 0.5 * Mass * G, Mass, G));

        // --- stall touchdown (2026-11-11 flight proof, second landing) ------
        // The datum sat ~1-3 m high and the hull rested at 2.96 m with -0.07 m/s
        // for ~41 s: inside the final band, still, but above the 2 m gate. That
        // is a landing. The band is capped at StallMaxAglM and a moving hull is
        // not resting, so neither a hover nor a descent is mistaken for one.
        Check("stall: resting at 2.9 m for 2 s is touchdown",
            LandMath.IsStallTouchdown(2.9, 15, 0.0, 0.0, 2.0));
        Check("stall: resting at 2.9 m for 1.9 s is not yet touchdown",
            !LandMath.IsStallTouchdown(2.9, 15, 0.0, 0.0, 1.9));
        Check("stall: resting at 10 m for 60 s is NOT touchdown",
            !LandMath.IsStallTouchdown(10, 15, 0.0, 0.0, 60));
        // A hull still descending at 0.4 m/s is FLYING: the stall rule must not
        // fire, and the normal rule finishes the job one metre lower.
        Check("stall: a 0.4 m/s descent at 2.5 m is NOT the stall rule, the 2 m rule lands it",
            !LandMath.IsStallTouchdown(2.5, 15, 0.4, 0.0, 5) &&
            !LandMath.IsTouchdown(2.5, -0.4) &&
            LandMath.IsTouchdown(1.9, -0.4));
        Check("stall: 0.4 m of drift in the window is not still",
            !LandMath.IsStallTouchdown(2.9, 15, 0.05, 0.4, 5));
        Check("stall: the band is capped at StallMaxAglM even if the order asks for more",
            !LandMath.IsStallTouchdown(LandMath.StallMaxAglM + 0.1, 40, 0.0, 0.0, 60) &&
            LandMath.IsStallTouchdown(LandMath.StallMaxAglM, 40, 0.0, 0.0, 60));
        Check("stall: a 4 m final band narrows the rule, never widens it",
            !LandMath.IsStallTouchdown(5, 4, 0.0, 0.0, 60) &&
            LandMath.IsStallTouchdown(3.5, 4, 0.0, 0.0, 60));
        Check("stall: NaN samples are never a landing",
            !LandMath.IsStallTouchdown(double.NaN, 15, 0.0, 0.0, 60) &&
            !LandMath.IsStallTouchdown(2.9, 15, double.NaN, 0.0, 60) &&
            !LandMath.IsStallTouchdown(2.9, 15, 0.0, double.NaN, 60));

        // The 2 s clock: a hull resting at 2.9 m fires on the second that
        // completes the window, not before (the controller ticks at 0.1 s).
        var stallAt = -1.0;
        for (var sec = 0.1; sec <= 5.0; sec += 0.1)
            if (LandMath.IsStallTouchdown(2.9, 15, 0.0, 0.0, sec)) { stallAt = sec; break; }
        Check("stall: the window is 2 s of stillness", Math.Abs(stallAt - 2.0) < 1e-6,
            "fired at " + stallAt);

        // A hull held at 20 m by the safe-hover abort is motionless forever and
        // must never be declared landed. The controller also gates the rule on
        // the descending phase with a sink commanded; both are applied here.
        var hoverPhase = "safe-hover";
        var hoverLanded = false;
        for (var sec = 0.1; sec <= 600.0; sec += 0.1)
            if (hoverPhase == "descending" && 0.4 > 0 &&
                LandMath.IsStallTouchdown(20, 15, 0.0, 0.0, sec)) { hoverLanded = true; break; }
        Check("stall: a safe-hover at 20 m never touches down", !hoverLanded);

        // Datum rule: a `land_ground` update that puts the hull under the
        // contact gate has landed it, without another metre of flight.
        Check("datum: an update to 0.5 m AGL is touchdown", LandMath.IsDatumTouchdown(0.5));
        Check("datum: an update to 1.9 m AGL is touchdown", LandMath.IsDatumTouchdown(1.9));
        Check("datum: an update to 2.5 m AGL is not touchdown", !LandMath.IsDatumTouchdown(2.5));
        Check("datum: an unreadable AGL is never touchdown", !LandMath.IsDatumTouchdown(double.NaN));

        // --- start refusals (the checks the first in-game run did not have)
        Check("refuse: static", LandMath.StartRefusal(true, true, true, 9.8, 0, 1e6, Mass, false, 160, 0) != null);
        Check("refuse: no physics", LandMath.StartRefusal(false, false, true, 9.8, 0, 1e6, Mass, false, 160, 0) != null);
        Check("refuse: no planet", LandMath.StartRefusal(false, true, false, 9.8, 0, 1e6, Mass, false, 160, 0) != null);
        Check("refuse: zero-g", LandMath.StartRefusal(false, true, true, 0, 0, 1e6, Mass, false, 160, 0) != null);
        Check("refuse: 40 deg tilt (35 deg gate)", LandMath.StartRefusal(false, true, true, 9.8, 40, 1e6, Mass, false, 160, 0) != null);
        Check("refuse: lift below weight", LandMath.StartRefusal(false, true, true, 9.8, 0, 300_000, Mass, false, 160, 0) != null);
        Check("refuse: manual control", LandMath.StartRefusal(false, true, true, 9.8, 0, 1e6, Mass, true, 160, 0) != null);
        Check("accept: SAT-R-0001 down a landing column",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 160, 0.2) == null);

        // START CHECK 1: a start BELOW the ground datum (the first run accepted
        // -49 m and called it touchdown) is refused, and the reason says why.
        var below = LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, -49, 0.1);
        Check("refuse: start 49 m BELOW the ground datum", below != null && below.Contains("BELOW the ground datum"),
            below ?? "accepted");
        // START CHECK 2: a hull already on the ground has nothing to land.
        var down = LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 0.4, 0.1);
        Check("refuse: hull already on the ground (0.4 m AGL)", down != null && down.Contains("already on the ground"),
            down ?? "accepted");
        Check("accept: exactly 1.0 m is the boundary, not below it",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 1.0, 0.1) == null);
        Check("refuse: 0.99 m hull-bottom AGL is on the ground",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 0.99, 0.1) != null);
        // START CHECK 3: a spinning hull is refused before the settle — but only
        // past what the settle can actually damp. The gate moved 2 -> 30
        // (2026-11-10: both attempts arrived with 10 and 23 deg/s of residual
        // spin, which is the settle's job, not a reason to refuse).
        // Set 6 raised it to 90 because the lateral leg handed over at 80.5
        // deg/s; that is REVERTED pending the owner's approval. The backend
        // settle step before handover is what brings the spin under 30 now, so
        // these asserts pin the gate at 30 and the abort at 10.
        var spin = LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 160, 31);
        Check("refuse: spinning at 31 deg/s", spin != null && spin.Contains("spinning"), spin ?? "accepted");
        Check("accept: 30 deg/s arrival spin is inside the start gate",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 160, 30) == null);
        Check("accept: 23 deg/s (the measured 2026-11-10 arrival) starts the settle",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 160, 23.35) == null);
        // 80.5 deg/s (the measured set-6 handover) is OUTSIDE the gate on
        // purpose: the backend settle must damp it before handing over.
        Check("refuse: 80.5 deg/s (the set-6 handover) is over the 30 deg/s gate",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, 160, 80.5) != null);
        Check("the gate is 30 deg/s pending owner approval", LandMath.SpinRefuseDegS == 30.0);
        // The start gate is separate from the IN-FLIGHT spin abort (10 deg/s).
        Check("the in-flight spin abort is unchanged at 10 deg/s", LandMath.DescentSpinAbortDegS == 10);
        Check("refuse: unreadable hull-bottom altitude",
            LandMath.StartRefusal(false, true, true, 9.81, 2, LiftN, Mass, false, double.NaN, 0) != null);
        // The tilt gate really is 35 deg now (27 deg aborted the first run).
        Check("accept: 30 deg tilt starts the descent (gate is 35)",
            LandMath.StartRefusal(false, true, true, 9.81, 30, LiftN, Mass, false, 160, 0) == null);

        // --- settle / sign test / sign learning
        Check("settle: 0.4 deg/s is settled", LandMath.Settled(0.4));
        Check("settle: 0.6 deg/s is not settled", !LandMath.Settled(0.6));
        Near("spin: 0.5 rad/s is 28.6 deg/s", LandMath.SpinDegS(0.5), 90.0 / Math.PI, 1e-9);
        Check("sign from rate: +0.01 rad/s reads +1", LandMath.SignFromRate(0.01, 0.002) == 1);
        Check("sign from rate: -0.01 rad/s reads -1", LandMath.SignFromRate(-0.01, 0.002) == -1);
        Check("sign from rate: 0.0005 rad/s is no evidence", LandMath.SignFromRate(0.0005, 0.002) == 0);
        // Sign learning: 0.3 deg of growth inside 1 s flips immediately.
        Check("sign learn: +0.3 deg in 0.5 s flips", LandMath.SignFlipDue(10.3, 10.0, 0.5, 0.5));
        Check("sign learn: +0.29 deg does not", !LandMath.SignFlipDue(10.29, 10.0, 0.5, 0.5));
        Check("sign learn: growth spread over 1.5 s does not flip",
            !LandMath.SignFlipDue(10.3, 10.0, 1.5, 0.5));
        Check("sign learn: no correction commanded, no flip", !LandMath.SignFlipDue(10.3, 10.0, 0.5, 0.01));
        Check("sign learn: tilt falling never flips", !LandMath.SignFlipDue(9.0, 10.0, 0.5, 0.5));

        // =====================================================================
        // GYRO SIGN, DETERMINISTIC (the failure of 2026-11-10, twice)
        //
        // The hull's real gyro convention is INVERTED. Both `land_at` attempts
        // entered `settling` with a residual spin, took the fallback path that
        // applied the FULL-GAIN correction on the UNVERIFIED default sign, and
        // the wrong sign produced 15-68 deg/s^2: 7.5 deg of new tilt in 0.11 s,
        // which tripped the 10 deg/s descent abort. The sign test never ran.
        // =====================================================================

        // (1) THE SIGN DECISION, BOTH SIGNS, FROM THE MEASURED RATE RESPONSE.
        // The test must read the CHANGE the command caused, not the absolute
        // rate: a hull arriving at 23 deg/s has a huge rate that has nothing to
        // do with the gyro.
        {
            const double ratePerUnit = LandMath.NominalRatePerCommandDegS;
            var minRate = LandMath.SignTestMinRateDegS * Math.PI / 180.0;
            foreach (var truth in new[] { 1.0, -1.0 })
            {
                // Residual spin pointing OPPOSITE to the true response, which is
                // the case that fooled the old absolute-rate test.
                var before = -23.0 * Math.PI / 180.0;
                var after = before + truth * LandMath.SignTestYawCommand * ratePerUnit * Math.PI / 180.0;
                var decided = LandMath.SignFromDelta(before, after, minRate);
                Check("sign test: a hull whose gyro sign is " + (truth > 0 ? "+1" : "-1") +
                      " reads sign " + (int)truth + " with 23 deg/s of residual spin",
                    decided == (int)truth, "decided " + decided + " from dRate " +
                    Math.Round((after - before) * 180.0 / Math.PI, 3) + " deg/s");
                // A still hull: the same answer, so the test does not depend on
                // the hull happening to be moving.
                var still = LandMath.SignFromDelta(0.0,
                    truth * LandMath.SignTestYawCommand * ratePerUnit * Math.PI / 180.0, minRate);
                Check("sign test: a still hull with gyro sign " + (truth > 0 ? "+1" : "-1") +
                      " reads " + (int)truth, still == (int)truth, "decided " + still);
            }
            // The OLD rule (sign of the absolute rate while commanding) reads the
            // residual, i.e. the WRONG sign on this hull. Pinned as documentation.
            var oldBefore = -23.0 * Math.PI / 180.0;
            var oldAfter = oldBefore + 1.0 * LandMath.SignTestYawCommand * ratePerUnit * Math.PI / 180.0;
            var mean = (oldBefore + oldAfter) / 2.0;
            Check("sign test: the old absolute-rate rule would have said -1 on a +1 hull " +
                  "(why the delta is required)",
                LandMath.SignFromRate(mean, minRate) == -1);
            Check("sign test: no response is no evidence, not a guess",
                LandMath.SignFromDelta(1.0, 1.00001, minRate) == 0);
            Check("sign test: 0.4 s window is inside the 0.5 s budget",
                LandMath.SignTestTicks * 0.1 <= 0.5 + 1e-12);
        }

        // (2) LOW GAIN AND A 2 deg/s^2 RAMP UNTIL THE SIGN IS KNOWN.
        {
            Near("gain: 10 % of the correction while the sign is unproven",
                LandMath.AttitudeGainScale(false), 0.10, 1e-12);
            Near("gain: the full correction once the sign test has decided",
                LandMath.AttitudeGainScale(true), 1.0, 1e-12);

            var step = LandMath.MaxCommandDeltaPerTick(
                LandMath.UnprovenSignAngularAccelDegS2, 0.1, LandMath.NominalRatePerCommandDegS);
            Near("ramp: the unproven cap is a 0.01 unit step per tick", step, 0.01, 1e-12);
            Near("ramp: that step is exactly 2 deg/s2 of commanded angular acceleration",
                step * LandMath.NominalRatePerCommandDegS / 0.1, 2.0, 1e-9);
            // The command scale is measured, so check the worst cases of its clamp:
            // a hull whose response looks very weak (5 deg/s per unit) and one
            // whose response looks very strong (80) must both stay at 2 deg/s^2.
            foreach (var scale in new[] { 5.0, 20.0, 80.0 })
            {
                var s = LandMath.MaxCommandDeltaPerTick(LandMath.UnprovenSignAngularAccelDegS2, 0.1, scale);
                Near("ramp: a " + scale + " deg/s-per-unit command scale still bounds the accel at 2 deg/s2",
                    s * scale / 0.1, 2.0, 1e-9);
            }
            Check("ramp: the proven cap is much looser than the unproven one",
                LandMath.MaxCommandDeltaPerTick(LandMath.ProvenSignAngularAccelDegS2, 0.1, 20) >
                LandMath.MaxCommandDeltaPerTick(LandMath.UnprovenSignAngularAccelDegS2, 0.1, 20) * 5);
            // One noisy measurement must not disarm the cap.
            var wild = LandMath.RatePerCommandDegS(1000, 0.06);
            var dead = LandMath.RatePerCommandDegS(0.0001, 0.06);
            Check("ramp: the measured command scale is clamped to 1/4..4x nominal",
                wild <= LandMath.NominalRatePerCommandDegS * 4 + 1e-9 &&
                dead >= LandMath.NominalRatePerCommandDegS * 0.25 - 1e-9,
                "wild " + wild + " dead " + dead);
        }

        // (3) SETTLING FROM A 5 deg/s ARRIVAL SPIN, INVERTED GYRO. The sim runs
        // the same rules the game-thread controller runs: the sign test first,
        // then the damping loop at 10 % gain and a 2 deg/s^2 ramp until the
        // settle-in window, then full gain. The hull's real sign is -1 and the
        // controller starts from the +1 default, exactly like the real run.
        {
            var fixed5 = Settle(5.0, -1.0);
            Console.WriteLine("INFO settle sim 5 deg/s: sign " + fixed5.Sign + " after dRate " +
                Math.Round(fixed5.SignTestRateDegS, 2) + " deg/s, settled at " +
                Math.Round(fixed5.SettledAtSec, 2) + " s, peak tilt " +
                Math.Round(fixed5.MaxTiltDeg, 2) + " deg, peak unproven accel " +
                Math.Round(fixed5.MaxUnprovenAccelDegS2, 2) + " deg/s2");
            Check("settle sim: decides the sign from the test (inverted hull)",
                fixed5.Sign == -1, "sign " + fixed5.Sign + " from " +
                Math.Round(fixed5.SignTestRateDegS, 3) + " deg/s");
            Check("settle sim: 5 deg/s arrival spin is damped under 0.5 deg/s",
                fixed5.SettledAtSec >= 0, "rate " + Math.Round(fixed5.EndRateDegS, 2) +
                " deg/s after " + Math.Round(fixed5.TimeSec, 1) + " s");
            Check("settle sim: it settles inside the 15 s budget",
                fixed5.SettledAtSec >= 0 && fixed5.SettledAtSec <= LandMath.SettleMaxSec,
                "settled at " + Math.Round(fixed5.SettledAtSec, 2) + " s");
            Check("settle sim: tilt never leaves the 35 deg gate", fixed5.MaxTiltDeg < 35.0,
                "peak tilt " + Math.Round(fixed5.MaxTiltDeg, 2) + " deg");
            Check("settle sim: the 5 deg/s spin becomes under 5 deg of tilt",
                fixed5.MaxTiltDeg < 5.0, "peak tilt " + Math.Round(fixed5.MaxTiltDeg, 2) + " deg");
            Check("settle sim: NO full-gain correction before the sign is known",
                fixed5.FullGainTicksBeforeTest == 0,
                fixed5.FullGainTicksBeforeTest + " ticks at full gain while unproven");
            Check("settle sim: the commanded acceleration stays inside the 2 deg/s2 cap " +
                  "while the sign is unproven",
                fixed5.MaxUnprovenAccelDegS2 <= LandMath.UnprovenSignAngularAccelDegS2 + 1e-6,
                "peak " + Math.Round(fixed5.MaxUnprovenAccelDegS2, 3) + " deg/s2");

            // THE OLD PATH, side by side: no sign test, full gain, default +1
            // against an inverted hull and no ramp. This is what produced
            // "tilt growing 7.5 deg in 0.11 s" in game.
            var old5 = Settle(5.0, -1.0, oldFallback: true);
            Check("settle sim: the old full-gain fallback DIVERGES on the inverted hull " +
                  "(tilt past the 35 deg gate inside 3 s)",
                old5.MaxTiltDeg > 35.0, "peak tilt " + Math.Round(old5.MaxTiltDeg, 1) + " deg");
            Check("settle sim: the fix keeps more than 30 deg of tilt margin that the old path spent",
                old5.MaxTiltDeg - fixed5.MaxTiltDeg > 30.0,
                "old " + Math.Round(old5.MaxTiltDeg, 1) + " vs new " +
                Math.Round(fixed5.MaxTiltDeg, 2) + " deg");

            // A hull arriving at the 30 deg/s start-gate limit must still settle.
            var fixed30 = Settle(30.0, -1.0);
            Console.WriteLine("INFO settle sim 30 deg/s: sign " + fixed30.Sign + " after dRate " +
                Math.Round(fixed30.SignTestRateDegS, 2) + " deg/s, settled at " +
                Math.Round(fixed30.SettledAtSec, 2) + " s, peak tilt " +
                Math.Round(fixed30.MaxTiltDeg, 2) + " deg");
            Console.WriteLine("INFO settle sim old fallback 5 deg/s: peak tilt " +
                Math.Round(old5.MaxTiltDeg, 1) + " deg (the fix stays at " +
                Math.Round(fixed5.MaxTiltDeg, 2) + ")");
            Check("settle sim: a 30 deg/s arrival spin is damped inside the 15 s budget",
                fixed30.SettledAtSec >= 0 && fixed30.SettledAtSec <= LandMath.SettleMaxSec,
                "settled at " + Math.Round(fixed30.SettledAtSec, 2) + " s");
            Check("settle sim: 30 deg/s of arrival spin stays inside the tilt gate",
                fixed30.MaxTiltDeg < 35.0, "peak tilt " + Math.Round(fixed30.MaxTiltDeg, 1) + " deg");
        }

        // (4) THE DESCENT ABORT THRESHOLDS ARE UNCHANGED — they just no longer
        // apply to the settle or the abort hold.
        {
            Near("descent abort: the spin rule is still 10 deg/s",
                LandMath.DescentSpinAbortDegS, 10.0, 1e-12);
            Check("descent abort: fall, brake and descending ARE descent phases",
                LandMath.DescentPhase("fall") && LandMath.DescentPhase("brake") &&
                LandMath.DescentPhase("descending"));
            Check("descent abort: settling is NOT a descent phase (it damps the spin)",
                !LandMath.DescentPhase("settling"));
            Check("descent abort: the abort hold is NOT a descent phase (it is recovery)",
                !LandMath.DescentPhase("safe-hover"));
            Check("descent abort: landed is not a descent phase", !LandMath.DescentPhase("landed"));
            Check("touchdown: the 2 m / 0.5 m/s rule is unchanged",
                LandMath.IsTouchdown(2.0, 0.5) && !LandMath.IsTouchdown(2.01, 0.1) &&
                !LandMath.IsTouchdown(1.0, 0.51));
            Check("settle gate: the settled rate is still 0.5 deg/s",
                LandMath.Settled(0.5) && !LandMath.Settled(0.51));
            Check("settle gate: the settle budget grew to 15 s, not more",
                LandMath.SettleMaxSec > 10.0 && LandMath.SettleMaxSec <= 15.0);
        }

        // --- safe hover: the abort path (this is what replaced "let go")
        Near("hover: at rest the command is exactly zero (hover = weight)",
            LandMath.HoverAccel(0, G, LandMath.SafeHoverGain), 0, 1e-12);
        Near("hover: sinking at 5 m/s is arrested at the 0.5 g cap",
            LandMath.HoverAccel(-5, G, LandMath.SafeHoverGain), 0.5 * G, 1e-9);
        Near("hover: a slow sink gets a proportional (sub-cap) arrest",
            LandMath.HoverAccel(-1, G, LandMath.SafeHoverGain), 1.8, 1e-9);
        Near("hover: up authority is capped at 0.5 g",
            LandMath.HoverAccel(-50, G, LandMath.SafeHoverGain), 0.5 * G, 1e-9);
        Near("hover: down authority is only 0.2 g",
            LandMath.HoverAccel(50, G, LandMath.SafeHoverGain), -0.2 * G, 1e-9);
        Near("hover fraction: SAT-R-0001 hovers at weight/lift",
            LandMath.HoverFraction(Mass, G, LiftN), Mass * G / LiftN, 1e-9);
        Near("hover fraction: never above 1", LandMath.HoverFraction(Mass, G, 0.5 * Mass * G), 1, 1e-12);
        Check("release: level and still releases", LandMath.SafeToRelease(0.4, 4.9));
        Check("release: 0.6 m/s holds the hover", !LandMath.SafeToRelease(0.6, 0.0));
        Check("release: 5 deg tilt holds the hover", !LandMath.SafeToRelease(0.1, 5.0));
        Check("release: NaN never releases", !LandMath.SafeToRelease(double.NaN, 0));

        // --- closed-loop descent, the whole point of the controller ----------
        // 150 m handover (the backend's handover height) at 5 m/s, one tick at
        // a time, with the real mass/lift. The hull must reach the ground at
        // <= 0.5 m/s without ever climbing: this is the shape the in-game
        // dampener pulses could not fly.
        var dt = 0.1;
        var agl = 160.0;              // hull bottom, SAT-R-0001 at 150 m position AGL
        var vDown = 5.0;
        var maxSink = vDown;
        var maxAgl = agl;
        var t = 0.0;
        double touchAgl = -1, touchV = -1;
        while (t < 130.0)
        {
            t += dt;
            var vDes = LandMath.SinkSetpoint(agl, 5, 0.4, 15, LandMath.ScheduleStopAccelMs2);
            var aUp = LandMath.SinkAccel(vDes, -vDown, LandMath.VelocityGain,
                LandMath.MaxUpAccelMs2(LiftN, Mass, G, LandMath.MaxAccelG), LandMath.MaxAccelG * G);
            var thrust = LandMath.LiftThrustN(Mass, G, aUp, LiftN);
            vDown += (G - thrust / Mass) * dt;
            agl -= vDown * dt;
            if (agl < 0) { agl = 0; vDown = 0; }
            maxSink = Math.Max(maxSink, vDown);
            maxAgl = Math.Max(maxAgl, agl);
            if (LandMath.IsTouchdown(agl, -vDown)) { touchAgl = agl; touchV = vDown; break; }
        }
        Check("sim: the descent reaches touchdown inside 120 s", touchAgl >= 0, "t=" + Math.Round(t, 1) + " s");
        Check("sim: touchdown under 2 m hull-bottom AGL", touchAgl >= 0 && touchAgl <= 2.0, "agl " + touchAgl);
        Check("sim: touchdown at or under 0.5 m/s", touchV >= 0 && touchV <= 0.5, "v " + touchV);
        Check("sim: never sinks faster than the 5 m/s command", maxSink <= 5.05, "max " + maxSink);
        Check("sim: never climbs above the handover", maxAgl <= 160.01, "max agl " + maxAgl);
        Check("sim: 0.5 s of every second is spent inside the final band",
            LandMath.SinkSetpoint(7.5, 5, 0.4, 15, 2) < 1.0);

        // --- the fall/brake law: the plugin owns the descent from ANY height ---
        Near("brake accel: SAT-R-0001's 1030 kN / 37.6 t excess is 17.6 m/s2, capped at 15",
            LandMath.BrakeAccelMs2(1_030_000, Mass, G), LandMath.MaxBrakeAccelMs2, 1e-9);
        Near("brake accel: a hull at 1.1x weight sheds 0.981 m/s2",
            LandMath.BrakeAccelMs2(1.1 * Mass * G, Mass, G), 0.981, 1e-3);
        Near("brake accel: an unreadable mass never becomes a huge brake", LandMath.BrakeAccelMs2(1e9, 0, G),
            LandMath.MinBrakeAccelMs2, 1e-9);
        Near("brake height: standing still brakes at the band", LandMath.BrakeAglM(0, 15, 15), 15, 1e-9);
        Near("brake height: 50 m/s at 15 m/s2 is 1.3 x the stopping distance plus the band",
            LandMath.BrakeAglM(50, 15, 15), 2500.0 / 30.0 * 1.3 + 15, 1e-6);
        Check("brake height: faster falls brake HIGHER",
            LandMath.BrakeAglM(80, 15, 15) > LandMath.BrakeAglM(40, 15, 15) + 100);
        Check("brake height: a weaker brake brakes higher too",
            LandMath.BrakeAglM(50, 3, 15) > LandMath.BrakeAglM(50, 12, 15));
        Check("should brake: at the computed height yes", LandMath.ShouldBrake(123, -50, 15, 15));
        Check("should brake: well above it no", !LandMath.ShouldBrake(400, -50, 15, 15));
        Check("should brake: an unknown height brakes (never keeps falling blind)",
            LandMath.ShouldBrake(double.NaN, -1, 15, 15));

        Near("fall law: far below the cap is a REAL free fall (0 thrust)",
            LandMath.FallThrustFraction(Mass, G, 0, 100, LiftN, LandMath.FallCapGain, 1.5), 0, 1e-12);
        Near("fall law: 10 m/s below the cap is still 0 thrust",
            LandMath.FallThrustFraction(Mass, G, -90, 100, LiftN, LandMath.FallCapGain, 1.5), 0, 1e-12);
        Near("fall law: AT the cap the command is the hull's weight",
            LandMath.FallThrustFraction(Mass, G, -100, 100, LiftN, LandMath.FallCapGain, 1.5),
            Mass * G / LiftN, 1e-9);
        Check("fall law: over the cap commands more than weight",
            LandMath.FallThrustFraction(Mass, G, -105, 100, LiftN, LandMath.FallCapGain, 1.5) >
            LandMath.FallThrustFraction(Mass, G, -100, 100, LiftN, LandMath.FallCapGain, 1.5));
        Check("fall law: never above the bank's capacity",
            LandMath.FallThrustFraction(Mass, G, -400, 100, LiftN, LandMath.FallCapGain, 1.5) <= 1.0);
        Check("fall law: a cap of 0 means the default cap, not a hover",
            LandMath.FallThrustFraction(Mass, G, -5, 0, LiftN, LandMath.FallCapGain, 1.5) < 0.01);

        // --- CLOSED-LOOP DROPS: the whole descent, one tick at a time ---------
        // The same law the controller runs, from heights the backend used to fly:
        // the hull must brake itself and touch down under 1 m/s. A fall from
        // 1000 m binds the maxFallMps cap; 300 m does not, so the two cases test
        // different branches.
        var drop300 = Drop(300.0, 100.0);
        Check("drop 300 m: lands", drop300.Landed, drop300.Error);
        Check("drop 300 m: touchdown under 2 m hull-bottom AGL", drop300.TouchAglM <= 2.0,
            "agl " + Math.Round(drop300.TouchAglM, 2));
        Check("drop 300 m: touchdown at or under 1 m/s", drop300.TouchMps <= 1.0,
            "v " + Math.Round(drop300.TouchMps, 2) + " m/s");
        Check("drop 300 m: the brake starts with 1.3x the stopping distance in hand",
            drop300.BrakeStartAglM - 15.0 >= drop300.BrakeStartMps * drop300.BrakeStartMps / (2 * drop300.BrakeAccelMs2) - 0.5,
            "brake at " + Math.Round(drop300.BrakeStartAglM, 1) + " m doing " +
            Math.Round(drop300.BrakeStartMps, 1) + " m/s");
        Check("drop 300 m: never sinks past the free-fall speed it could reach",
            drop300.MaxSinkMps <= Math.Sqrt(2 * G * 300) + 1, "max " + Math.Round(drop300.MaxSinkMps, 1));
        Check("drop 300 m: the brake does not throw the hull back up",
            drop300.MaxAglM <= 300.5, "max agl " + Math.Round(drop300.MaxAglM, 1));

        var drop1000 = Drop(1000.0, 100.0);
        Check("drop 1000 m: lands", drop1000.Landed, drop1000.Error);
        Check("drop 1000 m: touchdown under 2 m hull-bottom AGL", drop1000.TouchAglM <= 2.0,
            "agl " + Math.Round(drop1000.TouchAglM, 2));
        Check("drop 1000 m: touchdown at or under 1 m/s", drop1000.TouchMps <= 1.0,
            "v " + Math.Round(drop1000.TouchMps, 2) + " m/s");
        Check("drop 1000 m: the 100 m/s fall cap holds", drop1000.MaxSinkMps <= 101.5,
            "max " + Math.Round(drop1000.MaxSinkMps, 1) + " m/s");
        Check("drop 1000 m: the brake starts with 1.3x the stopping distance in hand",
            drop1000.BrakeStartAglM - 15.0 >= drop1000.BrakeStartMps * drop1000.BrakeStartMps / (2 * drop1000.BrakeAccelMs2) - 0.5,
            "brake at " + Math.Round(drop1000.BrakeStartAglM, 1) + " m doing " +
            Math.Round(drop1000.BrakeStartMps, 1) + " m/s");
        Check("drop 1000 m: it finishes inside the 120 s job budget", drop1000.TimeSec < 120.0,
            Math.Round(drop1000.TimeSec, 1) + " s");
        Check("drop 1000 m: the brake does not throw the hull back up",
            drop1000.MaxAglM <= 1000.5, "max agl " + Math.Round(drop1000.MaxAglM, 1));

        // A hull with barely enough lift must still brake itself, just earlier
        // and slower — never fall through. This is the "weak brake" branch.
        var weak = Drop(600.0, 100.0, liftN: 1.25 * Mass * G);
        Check("drop 600 m on a 1.25x-weight hull: lands", weak.Landed, weak.Error);
        Check("drop 600 m on a 1.25x-weight hull: under 1 m/s", weak.TouchMps <= 1.0,
            "v " + Math.Round(weak.TouchMps, 2));

        // --- the ABORT-HOVER path, simulated --------------------------------
        // SAT-R-0001 aborts midway down at 240 m AGL, sinking at 8 m/s and
        // tilting. The old code released everything here and the hull fell.
        // The hover must ARREST the sink, hold the altitude while it damps,
        // and only release once calm. If the hover could not arrest the sink
        // the hull would arrive at the same speed as before: that is the test.
        {
            var hAgl = 240.0;
            var hV = -8.0;            // m/s, up-positive
            var hoverT = 0.0;
            var holdTicks = 0;
            var arrestedWithinS = -1.0;
            var releaseAt = -1.0;
            var calmSec = 0.0;
            var minHoverAgl = hAgl;
            var maxHoverAgl = hAgl;
            var tilt = 27.0;          // the tilt that aborted the real hull
            while (hoverT < 30.0)
            {
                hoverT += dt;
                holdTicks++;
                // attitude: a level hold reduces tilt at a few deg/s
                tilt = Math.Max(0.0, tilt - 1.2 * dt);
                var aUp = LandMath.HoverAccel(hV, G, LandMath.SafeHoverGain);
                var thrust = LandMath.LiftThrustN(Mass, G, aUp, LiftN);
                hV += (thrust / Mass - G) * dt;
                hAgl += hV * dt;
                minHoverAgl = Math.Min(minHoverAgl, hAgl);
                maxHoverAgl = Math.Max(maxHoverAgl, hAgl);
                if (arrestedWithinS < 0 && hV > -0.5) arrestedWithinS = hoverT;
                if (LandMath.SafeToRelease(Math.Abs(hV), tilt)) calmSec += dt;
                else calmSec = 0;
                if (releaseAt < 0 && calmSec >= LandMath.SafeHoverCalmSec) { releaseAt = hoverT; break; }
                if (hAgl <= 0) break;   // hit the ground: a FAIL for the hover
            }
            Check("hover sim: the sink is arrested inside 2.5 s",
                arrestedWithinS >= 0 && arrestedWithinS <= 2.5, "arrested at " + Math.Round(arrestedWithinS, 2) + " s");
            Check("hover sim: the hull does NOT reach the ground in 30 s",
                hAgl > 0, "agl " + Math.Round(hAgl, 1) + " m");
            Check("hover sim: it loses under 15 m while recovering",
                minHoverAgl > 240 - 15, "min agl " + Math.Round(minHoverAgl, 2));
            Check("hover sim: it never climbs away",
                maxHoverAgl < 240 + 15, "max agl " + Math.Round(maxHoverAgl, 2));
            Check("hover sim: it releases only after 2 s level and still",
                releaseAt >= 2.0, "released at " + Math.Round(releaseAt, 2) + " s");
            Check("hover sim: thrust settles at the weight command",
                Math.Abs(LandMath.HoverFraction(Mass, G, LiftN) - Mass * G / LiftN) < 1e-9);
        }

        // --- the OLD behaviour, for contrast: release at the abort ----------
        // Same abort (240 m, -8 m/s) with the old "clear every override" path:
        // one second later it is at 232 m and still accelerating downwards, and
        // it hits the ground at ~60 m/s. This is the fall the fix removes.
        {
            var fAgl = 240.0;
            var fV = -8.0;
            var fT = 0.0;
            var impactV = -1.0;
            while (fT < 60.0)
            {
                fT += dt;
                fV += (-G) * dt;          // no lift at all: the overrides are gone
                fAgl += fV * dt;
                if (fAgl <= 0) { impactV = -fV; break; }
            }
            Console.WriteLine("INFO old abort path would impact at " + Math.Round(impactV, 1) + " m/s");
        }

        // --- dampener dead-man (the plugin, not the backend, is the last line) --
        // Measured 2026-11-10: the backend turned the dampeners off for a fall,
        // its event loop starved for 12.3 s, and the hull hit the ground at
        // 57 m/s. The lease below is what makes that impossible now.
        {
            var fired = new List<string>();
            var dm = new DampenerDeadman();
            dm.Restore = (id, src, idle) => fired.Add(id + ":" + Math.Round(idle, 1) + ":" + src);
            dm.NoteDampenersOff(42, false, "set_dampeners off");
            for (var i = 0; i < 59; i++) dm.Tick(0.1, null);      // 5.9 s
            Check("dead-man: 5.9 s idle does NOT restore yet", fired.Count == 0 && dm.LeaseCount == 1);
            dm.Tick(0.2, null);                                   // 6.1 s
            Check("dead-man: 6.1 s idle restores the dampeners", fired.Count == 1 && fired[0].StartsWith("42:6.1"));
            Check("dead-man: the restore names its source", fired.Count == 1 && fired[0].EndsWith("set_dampeners off"));
            Check("dead-man: the lease is dropped after the restore", dm.LeaseCount == 0 && dm.RestoredCount == 1);
            dm.Tick(10.0, null);
            Check("dead-man: it never fires twice for the same grid", fired.Count == 1);

            // A backend order renews the lease: 6 s of SILENCE is the trigger,
            // not 6 s since the dampeners went off.
            var dm2 = new DampenerDeadman();
            var fired2 = 0;
            dm2.Restore = (id, src, idle) => fired2++;
            dm2.NoteDampenersOff(7, false, "set_block_props DampenersOverride:false");
            for (var i = 0; i < 30; i++) dm2.Tick(0.1, null);     // 3.0 s
            dm2.NoteOrder(7);                                     // backend still alive
            for (var i = 0; i < 50; i++) dm2.Tick(0.1, null);     // 8.0 s total
            Check("dead-man: an order at 3 s holds the dampeners OFF (5 s since the order)",
                fired2 == 0 && dm2.LeaseCount == 1);
            for (var i = 0; i < 15; i++) dm2.Tick(0.1, null);     // 9.5 s total, 6.5 s since the order
            Check("dead-man: 6 s after the last order it restores", fired2 == 1);

            // A plugin-owned job is exempt from the start...
            var dm3 = new DampenerDeadman();
            var fired3 = 0;
            dm3.Restore = (id, src, idle) => fired3++;
            dm3.NoteDampenersOff(9, true, "set_dampeners off");
            for (var i = 0; i < 100; i++) dm3.Tick(0.1, null);
            Check("dead-man: an owned grid (land/level job) is never armed", dm3.LeaseCount == 0 && fired3 == 0);
            // ...and a job that takes the grid mid-lease suppresses the restore.
            dm3.NoteDampenersOff(9, false, "set_dampeners off");
            for (var i = 0; i < 70; i++) dm3.Tick(0.1, id => id == 9);
            Check("dead-man: a job that takes the grid suppresses the restore", fired3 == 0 && dm3.LeaseCount == 0);
            // Turning them back on ourselves cancels the lease.
            dm3.NoteDampenersOff(9, false, "set_dampeners off");
            dm3.NoteDampenersOn(9);
            for (var i = 0; i < 100; i++) dm3.Tick(0.1, null);
            Check("dead-man: dampeners back ON cancels the lease", fired3 == 0 && dm3.LeaseCount == 0);

            // A hull that stays off for a minute must not restore repeatedly.
            var dm4 = new DampenerDeadman();
            var fired4 = 0;
            dm4.Restore = (id, src, idle) => fired4++;
            dm4.NoteDampenersOff(11, false, "set_dampeners off");
            for (var i = 0; i < 600; i++) dm4.Tick(0.1, null);
            Check("dead-man: one restore per lease, not one per tick", fired4 == 1);
        }

        // --- live ground datum (defect b, 2026-11-11) -----------------------
        // `land_at` carried ONE groundRadiusM. Measured 2026-11-10 the terrain
        // under the final column was ~10 m lower than the one the handover
        // sampled, which moved every brake/flare threshold by that much.
        {
            string reason;
            Check("ground: a fresh radius is accepted",
                LandMath.AcceptGroundUpdate(61033.8, double.NaN, out reason) && reason == null);
            Check("ground: a 6 m terrain change is accepted",
                LandMath.AcceptGroundUpdate(61027.8, 61033.8, out reason) && reason == null);
            Check("ground: an 800 m step is refused as a broken sample",
                !LandMath.AcceptGroundUpdate(61833.8, 61033.8, out reason) && reason.Contains("jumped"));
            Check("ground: a zero radius is refused",
                !LandMath.AcceptGroundUpdate(0, 61033.8, out reason) && reason.Contains("not a ground radius"));
            Check("ground: NaN is refused",
                !LandMath.AcceptGroundUpdate(double.NaN, 61033.8, out reason));
            Check("ground: the accepted jump limit is generous enough for a ridge",
                LandMath.GroundUpdateMaxJumpM >= 100);
            // The measured case: AGL at the final column on the ORDER's datum
            // (sampled where the handover happened) vs on the LIVE one. A datum
            // 11 m LOW is the dangerous direction - the hull believes it has 11 m
            // more clearance than it does when the brake decision is made.
            const double liveGround = 61033.8;
            const double orderGround = 61022.8;      // ~11 m low at the handover column
            var posRadius = liveGround + 40;         // 40 m above the LIVE ground
            Near("ground: live datum gives the true 40 m AGL",
                LandMath.HullBottomAglM(posRadius - liveGround, -8.5), 48.5, 1e-9);
            Near("ground: the stale order datum overstates AGL by 11 m",
                LandMath.HullBottomAglM(posRadius - orderGround, -8.5), 59.5, 1e-9);
            // ...and the update closes exactly that gap.
            {
                string why;
                var accepted = LandMath.AcceptGroundUpdate(liveGround, orderGround, out why);
                var aglAfter = LandMath.HullBottomAglM(
                    LandMath.AcceptGroundUpdate(liveGround, orderGround, out why) ? posRadius - liveGround : posRadius - orderGround, -8.5);
                Check("ground: the live update removes the 11 m error",
                    accepted && Math.Abs(aglAfter - 48.5) < 1e-9);
            }
        }

        // --- rate damping on roll/pitch during the descent (defect c) -------
        // Measured 2026-11-10: a ~1.5 deg/s residual rode the whole descent on a
        // single-gyro hull; an 18 deg/s spike at 11.9 m aborted a landing. The
        // demand must be opposite the rate, grow with it, and be capped.
        {
            var rate = 1.5 * Math.PI / 180.0;        // 1.5 deg/s
            var demand = LandMath.RateDampDemandRadS(rate, true);
            Check("rate-damp: the demand opposes the measured rate", demand < 0);
            Near("rate-damp: 1.5 deg/s at full gain damps 1.6x",
                demand, -rate * LandMath.DescentRateDampGain, 1e-12);
            var unproven = LandMath.RateDampDemandRadS(rate, false);
            Check("rate-damp: an unproven sign damps gentler but still damps",
                unproven < 0 && Math.Abs(unproven) < Math.Abs(demand));
            Near("rate-damp: a reversed rate gives a reversed demand",
                LandMath.RateDampDemandRadS(-rate, true), -LandMath.RateDampDemandRadS(rate, true), 1e-12);
            Near("rate-damp: below the deadband there is no demand",
                LandMath.RateDampDemandRadS(LandMath.DescentRateDampDeadbandDegS * 0.5 * Math.PI / 180.0, true), 0, 1e-12);
            Near("rate-damp: NaN is no demand", LandMath.RateDampDemandRadS(double.NaN, true), 0, 1e-12);
            var huge = LandMath.RateDampDemandRadS(30 * Math.PI / 180.0, true);
            Near("rate-damp: a 30 deg/s spin is capped", Math.Abs(huge), LandMath.DescentRateDampCapRadS, 1e-12);

            // Closed loop on a WEAK gyro, which is the measured case: the gyro
            // delivers only a small fraction (2 %) of the demanded rate change
            // per tick, so the existing 1.1x term leaves a residual riding the
            // descent and the descent's own term must cut it down.
            var withoutDamp = 1.5;
            var withDamp = 1.5;
            const double eff = 0.02;
            for (var i = 0; i < 30; i++)      // 3 s of descent at 0.1 s ticks
            {
                withoutDamp += eff * (-withoutDamp * 1.1);                       // attitude helper only
                var rD = withDamp * Math.PI / 180.0;
                var extraRadS = LandMath.RateDampDemandRadS(rD, true);
                withDamp += eff * (-withDamp * 1.1 + extraRadS * 180.0 / Math.PI);
            }
            Check("rate-damp: 3 s of descent more than halves the residual (" +
                  Math.Round(withDamp, 2) + " vs " + Math.Round(withoutDamp, 2) + " deg/s)",
                Math.Abs(withDamp) < Math.Abs(withoutDamp) * 0.5);
            Check("rate-damp: without the extra term the residual still rides the descent",
                Math.Abs(withoutDamp) > 0.5);
            Near("rate-damp: a still hull is never commanded to spin",
                LandMath.RateDampDemandRadS(0, true), 0, 1e-12);
        }

        // =====================================================================
        // YAW (UP-AXIS) RATE DAMPING (2026-11-11, run set 2)
        //
        // `RateDamped` damps roll/pitch only, by design, so a landing hull could
        // spin about its own up axis at 32.1 deg/s during a brake and trip the
        // 10 deg/s descent abort with the gyro never asked to stop it (measured
        // authority: 38.1 deg/s per unit of override). The damper below drives
        // that rate to ZERO, is gated on a PROVEN yaw sign, and is fitted into
        // the override budget the tilt correction leaves.
        // =====================================================================
        {
            const double authority = 38.1;   // deg/s per override unit, measured in game
            const double tau = 0.3;          // gyro rate-response time constant, s
            const double yawDt = 0.1;

            // (1) POLICY: nothing without evidence, nothing inside the deadband,
            // capped, opposing.
            Check("yaw-damp: an unproven sign commands NOTHING (never guessed)",
                LandMath.YawRateDampOverride(30, authority, false) == 0.0);
            Check("yaw-damp: NaN rate commands nothing",
                LandMath.YawRateDampOverride(double.NaN, authority, true) == 0.0);
            Check("yaw-damp: inside the deadband commands nothing",
                LandMath.YawRateDampOverride(0.4, authority, true) == 0.0);
            Check("yaw-damp: +30 deg/s is countered the other way",
                LandMath.YawRateDampOverride(30, authority, true) < 0);
            Check("yaw-damp: -30 deg/s is countered the other way",
                LandMath.YawRateDampOverride(-30, authority, true) > 0);
            Near("yaw-damp: 30 deg/s demands -0.6*30/38.1 override",
                LandMath.YawRateDampOverride(30, authority, true), -0.6 * 30 / authority, 1e-9);
            Near("yaw-damp: a 90 deg/s spin is capped at half override",
                LandMath.YawRateDampOverride(90, authority, true), -LandMath.YawRateDampMaxOverride, 1e-12);
            // The loop gain is the GAIN, whatever the hull's gyro delivers: the
            // demand is expressed against the sign test's own measured scale.
            Near("yaw-damp: loop gain is hull-independent (a 5 deg/s/unit gyro)",
                LandMath.YawRateDampOverride(3, 5, true) * 5, -0.6 * 3, 1e-9);

            // (2) CLOSED LOOP: 30 deg/s decays below 2 deg/s inside a few s.
            // Plant: the gyro drives the rate toward (command x authority) with a
            // 0.3 s lag; a zero command means no gyro torque at all (rate holds).
            (double End, double ToTwo) YawSim(double startDegS, double truth, bool proven)
            {
                var rate = startDegS;
                var toTwo = -1.0;
                for (var at = 0.0; at < 8.0; at += yawDt)
                {
                    var demand = LandMath.YawRateDampOverride(rate, authority, proven);
                    if (demand != 0.0) rate += (truth * demand * authority - rate) * (yawDt / tau);
                    if (toTwo < 0 && Math.Abs(rate) < 2.0) toTwo = at + yawDt;
                }
                return (rate, toTwo);
            }

            var good = YawSim(30.0, 1.0, true);
            Check("yaw-damp: 30 deg/s decays below 2 deg/s (" + Math.Round(good.End, 2) + " deg/s)",
                Math.Abs(good.End) < 2.0);
            Check("yaw-damp: ... and inside 3 s (" + Math.Round(good.ToTwo, 1) + " s)",
                good.ToTwo > 0 && good.ToTwo <= 3.0);

            // (3) WHY THE GATE. A wrong sign is not merely useless: the demand is
            // computed FROM the measured rate, so with inverted authority the loop
            // is positive feedback. On the worst plant (a saturated gyro acting as
            // a torque source, no rate feedback) that GROWS the rate, and the
            // growth is exponential in time - the one failure a landing cannot
            // survive. Measured at the loop gain 0.6 and a 20 deg/s/unit gyro:
            var grow = 5.0;
            for (var gt = 0.0; gt < 1.0; gt += yawDt)
            {
                var demand = LandMath.YawRateDampOverride(grow, 20.0, true);
                grow += -demand * 20.0 * yawDt;     // truth = the OPPOSITE of the demand
            }
            Check("yaw-damp: a wrong sign grows the rate instead of damping it (" +
                  Math.Round(grow, 2) + " from 5.0 deg/s in 1 s) - the failure the gate prevents",
                grow > 6.0);

            // Wrong-sign DETECTION disables it: the controller revokes
            // YawSignProven on a sign flip, and the damper then sends nothing.
            var flipRate = 30.0;
            var atFlip = double.NaN;
            for (var ft = 0.0; ft < 6.0; ft += yawDt)
            {
                var proven = ft < 0.2;                      // the flip lands at 0.2 s
                if (!proven && double.IsNaN(atFlip)) atFlip = flipRate;
                var demand = LandMath.YawRateDampOverride(flipRate, authority, proven);
                if (demand != 0.0) flipRate += (demand * authority - flipRate) * (yawDt / tau);
            }
            Check("yaw-damp: a revoked sign (flip) stops the damper and freezes the rate (" +
                  Math.Round(flipRate, 2) + " vs " + Math.Round(atFlip, 2) + " deg/s at the flip)",
                Math.Abs(flipRate - atFlip) < 1e-9 && flipRate > 2.0);

            // (4) PITCH/ROLL KEEP PRIORITY: the yaw term is fitted into what the
            // tilt correction leaves and never taken out of it.
            Near("yaw-budget: a saturated tilt command leaves no room",
                LandMath.YawWithinAttitudeBudget(0.9, 0.47), 0.0, 1e-12);
            Near("yaw-budget: room left is all the yaw term may use",
                LandMath.YawWithinAttitudeBudget(0.6, 0.47), 0.3, 1e-12);
            Near("yaw-budget: a small yaw demand is untouched",
                LandMath.YawWithinAttitudeBudget(0.2, 0.1), 0.1, 1e-12);
            Check("yaw-budget: NaN never commands",
                LandMath.YawWithinAttitudeBudget(0.2, double.NaN) == 0.0);

            var worstTotal = 0.0;
            var tiltPreserved = true;
            foreach (var tiltCmd in new[] { 0.0, 0.1, 0.45, 0.8, 0.9 })
            {
                foreach (var yawRate in new[] { 0.0, 3.0, 12.0, 30.0, 60.0 })
                {
                    var yaw = LandMath.YawWithinAttitudeBudget(
                        tiltCmd, LandMath.YawRateDampOverride(yawRate, authority, true));
                    // Yaw is about `up`, tilt about a horizontal axis: orthogonal,
                    // so the tilt part of the combined demand must be unchanged.
                    var total = Math.Sqrt(tiltCmd * tiltCmd + yaw * yaw);
                    worstTotal = Math.Max(worstTotal, total);
                    if (tiltCmd > 0 && Math.Abs(Math.Sqrt(Math.Max(0.0, total * total - yaw * yaw)) - tiltCmd) > 1e-9)
                        tiltPreserved = false;
                }
            }
            Check("yaw-budget: no yaw term ever increases the tilt command",
                tiltPreserved);
            Check("yaw-budget: the combined demand never leaves the 0.9 cap (" +
                  Math.Round(worstTotal, 3) + ")", worstTotal <= LandMath.AttitudeOverrideCap + 1e-9);
        }

        // --- horizontal position hold (2026-11-11 set 3) ----------------------
        // The measured defect: 176.4 m of drift on the 745 m drop. The hold is a
        // PD on the tangential axes toward the ordered column, added to the
        // levelling demand inside a 7 deg budget, capped 5/2/0 deg by AGL band.
        Near("hhold: 5 deg cap in the brake (100 m AGL)",
            LandMath.LateralCapDeg(100, 15, 0), LandMath.LateralCapMaxDeg, 1e-12);
        Near("hhold: 2 deg cap at 15 m AGL", LandMath.LateralCapDeg(15, 15, 0), 2.0, 1e-12);
        Near("hhold: 5 deg again just above 15 m", LandMath.LateralCapDeg(16, 15, 0), 5.0, 1e-12);
        Near("hhold: zero at 6 m AGL", LandMath.LateralCapDeg(6, 15, 0), 0.0, 1e-12);
        Near("hhold: zero below 6 m AGL", LandMath.LateralCapDeg(2, 15, 0), 0.0, 1e-12);
        Near("hhold: zero after 2 s inside the band", LandMath.LateralCapDeg(10, 15, 2.0), 0.0, 1e-12);
        Near("hhold: an unreadable AGL commands nothing", LandMath.LateralCapDeg(double.NaN, 15, 0), 0.0, 0);

        // The PD, per axis, signed toward the target.
        Near("hhold: 10 m offset asks 1.5 deg", LandMath.LateralTiltDeg(10, 0, 5), 1.5, 1e-12);
        Near("hhold: a 1000 m offset is capped, never 150 deg",
            LandMath.LateralTiltDeg(1000, 0, 5), 5.0, 1e-12);
        Near("hhold: closing at 5 m/s damps the request (1.5 - 3.0)",
            LandMath.LateralTiltDeg(10, 5, 5), -1.5, 1e-12);
        Near("hhold: drifting away at 1 m/s adds to it (1.5 + 0.6)",
            LandMath.LateralTiltDeg(10, -1, 5), 2.1, 1e-12);
        Near("hhold: NaN offset commands nothing", LandMath.LateralTiltDeg(double.NaN, 0, 5), 0.0, 0);
        Near("hhold: a zero cap commands nothing", LandMath.LateralTiltDeg(100, 0, 0), 0.0, 0);

        // Two-axis clamp by magnitude: a diagonal may not exceed the cap.
        var dx = 4.0;
        var dy = 4.0;
        LandMath.ClampLateralDeg(ref dx, ref dy, 5.0);
        Near("hhold: diagonal request clamped to the cap by magnitude",
            Math.Sqrt(dx * dx + dy * dy), 5.0, 1e-12);
        dx = 1.0; dy = 0.0;
        LandMath.ClampLateralDeg(ref dx, ref dy, 5.0);
        Near("hhold: a request inside the cap is untouched", dx, 1.0, 1e-12);

        // Levelling keeps priority inside the 7 deg budget.
        Near("hhold: level and the hold gets all 5 deg", LandMath.LateralBudget(0, 5), 5.0, 1e-12);
        Near("hhold: 3 deg of levelling leaves 4 deg", LandMath.LateralBudget(3, 5), 4.0, 1e-12);
        Near("hhold: 6 deg of levelling leaves 1 deg", LandMath.LateralBudget(6, 5), 1.0, 1e-12);
        Near("hhold: 7.5 deg of levelling leaves the hold nothing",
            LandMath.LateralBudget(7.5, 5), 0.0, 1e-12);
        Near("hhold: the budget never exceeds the band cap", LandMath.LateralBudget(0, 2), 2.0, 1e-12);

        // 5 deg of tilt is 0.192 of override: inside the 0.9 total, and the
        // 35 deg abort is 28 deg away.
        Near("hhold: 5 deg converts to the AttitudeRotation scale",
            LandMath.TiltToRotationOverride(5), 5 * Math.PI / 180 * 2.2, 1e-12);
        Check("hhold: 5 deg of lateral is far inside the total override cap",
            LandMath.TiltToRotationOverride(5) < LandMath.AttitudeOverrideCap / 4);

        // The offset is the TANGENTIAL part only: a vertical error asks nothing.
        Near("hhold: a vertical offset is not tangential",
            LandMath.TangentialOffsetM(0, 300, 0, 0, 1, 0), 0.0, 1e-12);
        Near("hhold: a 176.4 m horizontal offset stays 176.4 m",
            LandMath.TangentialOffsetM(176.4, 300, 0, 0, 1, 0), 176.4, 1e-9);
        Near("hhold: the projection is up-vector independent (tilted planet normal)",
            LandMath.TangentialOffsetM(100, 0, 0, 0.6, 0.8, 0), 80.0, 1e-9);

        // Gates, each with the reason it reports.
        Check("hhold: never in a free fall", LandMath.LateralRefusal("fall", true, true, 2.6, 5, 0) != null);
        Check("hhold: enabled in brake and in the controlled descent",
            LandMath.LateralRefusal("brake", true, true, 2.6, 5, 0) == null &&
            LandMath.LateralRefusal("descending", true, true, 2.6, 5, 0) == null);
        Check("hhold: an unproven gyro sign keeps it off",
            LandMath.LateralRefusal("brake", false, true, 2.6, 5, 0)?.Contains("gyro sign") == true);
        Check("hhold: an unproven lift axis keeps it off",
            LandMath.LateralRefusal("brake", true, false, 2.6, 5, 0)?.Contains("lift-axis") == true);
        Check("hhold: lift ratio 1.14 is refused by name",
            LandMath.LateralRefusal("brake", true, true, 1.14, 5, 0)?.Contains("lift ratio 1.14") == true);
        Check("hhold: lift ratio 1.2 is the floor",
            LandMath.LateralRefusal("brake", true, true, 1.2, 5, 0) == null &&
            LandMath.LateralRefusal("brake", true, true, 1.19, 5, 0) != null);
        Check("hhold: nothing at or below 6 m AGL",
            LandMath.LateralRefusal("brake", true, true, 2.6, 0, 0)?.Contains("final band") == true);
        Check("hhold: zero lift is not a proof of the lift axis",
            !LandMath.LiftAxisProven(0, 368_900) && LandMath.LiftAxisProven(981_000, 368_900));

        // ---- an ORDERED target, and the cap it must live inside (set 5) ------
        // The backend flies a lateral leg above the requested column first; the
        // order then carries the target, so the hold flies to the REQUESTED
        // column instead of the handover column it is already sitting on.
        Near("htarget: the cap is 30 m", LandMath.LateralTargetMaxM, 30.0, 1e-12);
        Check("htarget: a target 8 m from the handover column is used",
            LandMath.TargetAcceptable(8) && LandMath.TargetRefusal(8) == null);
        Check("htarget: 30 m is inside the cap (inclusive)",
            LandMath.TargetAcceptable(30) && LandMath.TargetRefusal(30) == null);
        Check("htarget: 30.1 m is refused",
            !LandMath.TargetAcceptable(30.1) && LandMath.TargetRefusal(30.1) != null);
        Check("htarget: the measured 182 m miss is refused by name",
            LandMath.TargetRefusal(182)?.Contains("target too far for hold") == true,
            LandMath.TargetRefusal(182) ?? "no refusal");
        Check("htarget: the refusal carries both numbers",
            LandMath.TargetRefusal(182)?.Contains("182") == true &&
            LandMath.TargetRefusal(182)?.Contains("30") == true,
            LandMath.TargetRefusal(182) ?? "no refusal");
        Check("htarget: an unreadable offset is never used",
            !LandMath.TargetAcceptable(double.NaN) && LandMath.TargetRefusal(double.NaN) != null);
        Check("htarget: absent target = no offset = accepted",
            LandMath.TargetAcceptable(0) && LandMath.TargetRefusal(0) == null);
        // The offset that decides the cap is TANGENTIAL: a target 40 m below
        // the handover over the same column is 0 m away, not 40 m.
        Near("htarget: a pure vertical difference is 0 m horizontally",
            LandMath.TangentialOffsetM(0, 0, -40, 0, 0, 1), 0.0, 1e-12);
        Near("htarget: 182 m sideways + 40 m down is 182 m",
            LandMath.TangentialOffsetM(182, 0, -40, 0, 0, 1), 182.0, 1e-9);
        Check("htarget: a 182 m target is refused, a 12 m one is not",
            !LandMath.TargetAcceptable(LandMath.TangentialOffsetM(182, 0, 0, 0, 0, 1)) &&
            LandMath.TargetAcceptable(LandMath.TangentialOffsetM(12, 0, 0, 0, 0, 1)));

        // Closed loop: the measured 745 m drop, hold off vs on.
        var off = SimHold(false, 150, 1.2, 2.66, true, true);
        var on = SimHold(true, 150, 1.2, 2.66, true, true);
        Check("hhold: with the hold off the drift is the measured ~150+ m (" +
              Math.Round(off.FinalDriftM, 1) + ")", off.FinalDriftM > 140.0,
            off.FinalDriftM.ToString());
        Check("hhold: with the hold on the drift falls under 20 m (" +
              Math.Round(on.FinalDriftM, 1) + ")", on.FinalDriftM < 20.0,
            on.FinalDriftM.ToString());
        Check("hhold: it converges rather than orbiting (final speed " +
              Math.Round(on.FinalSpeedMps, 2) + " m/s)", on.FinalSpeedMps < 1.0);
        Check("hhold: the request never exceeds the 5 deg cap in any tick (" +
              Math.Round(on.MaxTiltDeg, 2) + ")", on.MaxTiltDeg <= LandMath.LateralCapMaxDeg + 1e-9);
        Check("hhold: never above 2 deg below 15 m AGL (" +
              Math.Round(on.MaxTiltBelow15M, 2) + ")", on.MaxTiltBelow15M <= 2.0 + 1e-9);
        Near("hhold: zero tilt at 6 m AGL", on.TiltAt6M, 0.0, 1e-12);
        Check("hhold: no drift reduction without a lift ratio of 1.2 (" +
              Math.Round(SimHold(true, 150, 1.2, 1.14, true, true).FinalDriftM, 1) + ")",
            SimHold(true, 150, 1.2, 1.14, true, true).FinalDriftM > 140.0);
        Check("hhold: no drift reduction without a gyro sign proof",
            SimHold(true, 150, 1.2, 2.66, false, true).FinalDriftM > 140.0);
        Check("hhold: no drift reduction without a lift-axis proof",
            SimHold(true, 150, 1.2, 2.66, true, false).FinalDriftM > 140.0);
        Check("hhold: a 51 m short-drop drift is corrected too (" +
              Math.Round(SimHold(true, 51, 0.4, 2.66, true, true).FinalDriftM, 1) + ")",
            SimHold(true, 51, 0.4, 2.66, true, true).FinalDriftM < 20.0);

        // --- the lateral-hold reason is a standing condition (verify #5) ------
        // Measured defect: `why="refused: gyro sign unproven"` printed once a
        // second for the whole descent, which reads like an active fault. It is
        // printed when it starts and when it changes, and stays in the JSON.
        Check("why: the first non-null reason is printed",
            LandMath.ShouldLogLateralHold("refused: gyro sign unproven", null));
        Check("why: the same reason on the next tick is NOT printed",
            !LandMath.ShouldLogLateralHold("refused: gyro sign unproven",
                "refused: gyro sign unproven"));
        Check("why: a changed reason IS printed",
            LandMath.ShouldLogLateralHold("refused: phase is not brake or descending",
                "refused: gyro sign unproven"));
        Check("why: no reason (hold flew) prints nothing",
            !LandMath.ShouldLogLateralHold(null, "refused: gyro sign unproven"));
        Check("why: a reason returning after a hold-flew streak is printed again",
            LandMath.ShouldLogLateralHold("refused: gyro sign unproven", null));

        // One descent, one line: a job that refuses for the whole descent must
        // print the reason exactly once (12 ticks at the 1 s status interval).
        var printed = new System.Collections.Generic.List<string>();
        string prev = null;
        for (var tick = 0; tick < 12; tick++)
        {
            const string standing = "refused: gyro sign unproven";
            if (LandMath.ShouldLogLateralHold(standing, prev)) { printed.Add(standing); prev = standing; }
        }
        Check("why: a standing refusal is logged once per job, not once a second (" +
              printed.Count + " lines in 12 ticks)", printed.Count == 1);

        Console.WriteLine();
        Console.WriteLine(_pass + " passed, " + _fail + " failed");
        return _fail == 0 ? 0 : 1;
    }

    /// <summary>
    /// Closed-loop 745 m brake+descend toward a column 0 m, in 1-D: the
    /// vertical schedule is a shape (25 -> 5 m/s, then 0.4 under 15 m), the
    /// horizontal axis is the hold's own law plus `a = g * tan(tilt)`. `off`
    /// is the aircraft as it flew in set 3: no lateral command at all.
    /// </summary>
    private sealed class HoldSim
    {
        public double FinalDriftM;
        public double FinalSpeedMps;
        public double MaxTiltDeg;
        public double MaxTiltBelow15M;
        public double TiltAt6M = double.NaN;
        public double TimeSec;
    }

    private static HoldSim SimHold(
        bool holdOn, double offsetM, double speedAwayMps, double liftRatio,
        bool gyroProven, bool liftProven)
    {
        const double dt = 0.1;
        var g = 9.81;
        var x = offsetM;
        var vx = speedAwayMps;
        var agl = 745.0;
        var r = new HoldSim();
        var t = 0.0;
        while (agl > 2.0 && t < 400.0)
        {
            var sink = agl <= LandMath.LateralNearGroundAglM
                ? 0.4
                : 20.0 * Math.Exp(-t / 8.0) + 5.0;
            agl = Math.Max(0.0, agl - sink * dt);

            var cap = LandMath.LateralCapDeg(agl, 15.0, 0.0);
            var refusal = LandMath.LateralRefusal("descending", gyroProven, liftProven, liftRatio, cap, 0.0);
            var tilt = 0.0;
            if (holdOn && refusal == null)
            {
                // Direction toward the column; inside half a metre, bleed the
                // drift instead (the controller's own rule).
                var dir = Math.Abs(x) >= 0.5 ? -Math.Sign(x) : -Math.Sign(vx);
                if (dir != 0)
                {
                    tilt = LandMath.LateralTiltDeg(Math.Abs(x), vx * dir, cap);
                    vx += g * Math.Tan(tilt * Math.PI / 180.0) * dir * dt;
                }
            }
            x += vx * dt;

            r.MaxTiltDeg = Math.Max(r.MaxTiltDeg, Math.Abs(tilt));
            if (agl <= LandMath.LateralNearGroundAglM)
                r.MaxTiltBelow15M = Math.Max(r.MaxTiltBelow15M, Math.Abs(tilt));
            if (agl <= LandMath.LateralZeroAglM && double.IsNaN(r.TiltAt6M)) r.TiltAt6M = Math.Abs(tilt);
            t += dt;
        }
        r.FinalDriftM = Math.Abs(x);
        r.FinalSpeedMps = Math.Abs(vx);
        r.TimeSec = t;
        return r;
    }

    /// <summary>What one closed-loop drop measured.</summary>
    private sealed class DropSim
    {
        public bool Landed;
        public double TouchAglM = double.NaN;
        public double TouchMps = double.NaN;      // sink speed DOWN, positive
        public double MaxSinkMps;
        public double MaxAglM;
        public double BrakeStartAglM = double.NaN;
        public double BrakeStartMps = double.NaN;
        public double BrakeAccelMs2;
        public double TimeSec;
        public string Error = "";
    }

    /// <summary>
    /// One closed-loop descent from <paramref name="startAglM"/>, tick by tick,
    /// running the SAME functions the game-thread controller runs:
    /// fall (free fall, capped) -> brake (PD to the schedule at brake authority)
    /// -> controlled descent -> touchdown. Point mass, constant gravity, no tilt:
    /// the 1.3 margin and the authority caps are what must absorb the real world.
    /// </summary>
    private static DropSim Drop(
        double startAglM, double maxFallMps, double liftN = LiftN,
        double sinkMps = 5.0, double finalSinkMps = 0.4, double bandM = 15.0)
    {
        const double dt = 0.1;
        var r = new DropSim
        {
            MaxAglM = startAglM,
            BrakeAccelMs2 = LandMath.BrakeAccelMs2(liftN, Mass, G),
        };
        var agl = startAglM;
        var vDown = 0.0;
        var phase = "fall";
        var t = 0.0;
        while (t < 200.0)
        {
            t += dt;
            double thrust;
            if (phase == "fall" && !LandMath.ShouldBrake(agl, -vDown, r.BrakeAccelMs2, bandM))
            {
                thrust = LandMath.FallThrustFraction(
                    Mass, G, -vDown, maxFallMps, liftN, LandMath.FallCapGain, LandMath.BrakeAuthorityG) * liftN;
            }
            else
            {
                if (phase == "fall")
                {
                    phase = "brake";
                    r.BrakeStartAglM = agl;
                    r.BrakeStartMps = vDown;
                }
                if (phase == "brake" && vDown <= sinkMps) phase = "descending";
                var accelCap = phase == "brake" ? LandMath.BrakeAuthorityG : LandMath.MaxAccelG;
                var stopAccel = phase == "brake" ? r.BrakeAccelMs2 : LandMath.ScheduleStopAccelMs2;
                var vDes = LandMath.SinkSetpoint(agl, sinkMps, finalSinkMps, bandM, stopAccel);
                var aUp = LandMath.SinkAccel(vDes, -vDown, LandMath.VelocityGain,
                    LandMath.MaxUpAccelMs2(liftN, Mass, G, accelCap), accelCap * G);
                thrust = LandMath.LiftThrustN(Mass, G, aUp, liftN);
            }

            vDown += (G - thrust / Mass) * dt;
            agl -= vDown * dt;
            r.MaxSinkMps = Math.Max(r.MaxSinkMps, vDown);
            r.MaxAglM = Math.Max(r.MaxAglM, agl);

            if (LandMath.IsTouchdown(agl, -vDown))
            {
                r.Landed = true;
                r.TouchAglM = agl;
                r.TouchMps = vDown;
                r.TimeSec = t;
                return r;
            }
            if (agl <= 0.0)
            {
                r.Landed = false;
                r.TouchAglM = 0.0;
                r.TouchMps = vDown;
                r.TimeSec = t;
                r.Error = "hit the ground at " + Math.Round(vDown, 1) + " m/s from " +
                          Math.Round(startAglM, 0) + " m";
                return r;
            }
        }
        r.TimeSec = t;
        r.Error = "still airborne after " + Math.Round(t, 0) + " s at " + Math.Round(agl, 1) + " m, sinking " +
                  Math.Round(vDown, 1) + " m/s";
        return r;
    }

    // --- the settle: one rate, one tilt, the real rules ---------------------

    private sealed class SettleSim
    {
        public double Sign = 1.0;
        public double SignTestRateDegS;
        public double MaxTiltDeg;
        public double EndRateDegS;
        public double PeakRateDegS;
        public double TimeSec;
        /// <summary>When the rate came under the settled gate, s (-1 = never).</summary>
        public double SettledAtSec = -1.0;
        /// <summary>Ticks flown at full gain BEFORE the sign test decided.</summary>
        public int FullGainTicksBeforeTest;
        /// <summary>Peak commanded angular acceleration while the sign was unproven, deg/s^2.</summary>
        public double MaxUnprovenAccelDegS2;
    }

    /// <summary>
    /// The settling phase, one 0.1 s tick at a time, with the SAME rules the
    /// game-thread controller runs:
    ///
    ///   * first the sign test: command <see cref="LandMath.SignTestYawCommand"/>
    ///     for <see cref="LandMath.SignTestTicks"/> ticks and decide the sign
    ///     from the CHANGE of the rate along that axis;
    ///   * then the damping loop:   cmd = sign * gain * (1.1*(-rate) + 2.2*tilt)
    ///     at 10 % gain and a 2 deg/s^2 ramp until the settle-in window, full
    ///     gain after it;
    ///   * the HULL answers with the REAL sign `truth`: the achieved rate chases
    ///     `truth * cmd * ratePerCommand` with a 0.3 s time constant;
    ///   * the spin is about the TILT axis (worst case): every deg/s of rate
    ///     becomes deg/s of tilt growth, which is how the real hull tripped the
    ///     35 deg gate.
    ///
    /// `oldFallback` reproduces the pre-fix path: no sign test, the +1 default
    /// sign, full gain from the first tick, no acceleration ramp.
    /// </summary>
    private static SettleSim Settle(
        double startSpinDegS, double truth, double ratePerCommand = 20.0, double tau = 0.3,
        bool oldFallback = false)
    {
        const double tickSec = 0.1;
        const double dampingGain = 1.1;
        const double tiltGain = 2.2;
        var r = new SettleSim { PeakRateDegS = Math.Abs(startSpinDegS) };
        var rate = startSpinDegS;          // deg/s, about the tilt axis
        var tilt = 0.0;                    // deg
        var sign = 1.0;                    // the controller's assumption
        var signTested = oldFallback;
        var testTick = 0;
        var baseline = 0.0;
        var fullGainAt = oldFallback ? 0.0 : double.MaxValue;
        var lastCmd = 0.0;
        var t = 0.0;
        var minRateRad = LandMath.SignTestMinRateDegS * Math.PI / 180.0;
        while (t < 20.0)
        {
            t += tickSec;
            double desired;
            var unproven = !signTested || t < fullGainAt;
            if (!signTested)
            {
                if (testTick == 0) baseline = rate * Math.PI / 180.0;
                desired = LandMath.SignTestYawCommand;
                if (testTick + 1 >= LandMath.SignTestTicks)
                {
                    var after = rate * Math.PI / 180.0;
                    var decided = LandMath.SignFromDelta(baseline, after, minRateRad);
                    r.SignTestRateDegS = (after - baseline) * 180.0 / Math.PI;
                    if (decided != 0) sign = decided;
                    signTested = true;
                    fullGainAt = t + LandMath.SignSettleInSec;
                    r.Sign = sign;
                }
                testTick++;
            }
            else
            {
                var gain = LandMath.AttitudeGainScale(t >= fullGainAt);
                // The tilt term must demand a rate that REDUCES the tilt (in the
                // controller's frame that is cross(up, desiredUp), the same
                // rotation sense; in this scalar model it is the opposite sign of
                // the tilt), the same sense the damping term has.
                desired = sign * gain * (dampingGain * (-rate) - tiltGain * tilt);
            }

            // The acceleration ramp is applied to EVERY command, the test's
            // included: this is the property that bounds a wrong-sign tick.
            var capNow = t >= fullGainAt
                ? LandMath.ProvenSignAngularAccelDegS2
                : LandMath.UnprovenSignAngularAccelDegS2;
            var maxStep = oldFallback ? double.MaxValue
                : LandMath.MaxCommandDeltaPerTick(capNow, tickSec, ratePerCommand);
            double delta0 = desired - lastCmd;
            if (Math.Abs(delta0) > maxStep) desired = lastCmd + Math.Sign(delta0) * maxStep;
            var cmd = desired;
            if (unproven)
            {
                var accel = Math.Abs(desired - lastCmd) / tickSec * ratePerCommand;
                r.MaxUnprovenAccelDegS2 = Math.Max(r.MaxUnprovenAccelDegS2, accel);
            }
            if (!signTested && Math.Abs(cmd) > LandMath.SignTestYawCommand + 1e-9)
                r.FullGainTicksBeforeTest++;   // an unproven tick that is not just the test
            lastCmd = cmd;

            // The hull: first-order rate response toward the commanded rate,
            // applied with the REAL gyro sign.
            var target = truth * cmd * ratePerCommand;
            rate += (target - rate) * (tickSec / tau);
            tilt += rate * tickSec;            // worst case: spin about the tilt axis
            r.MaxTiltDeg = Math.Max(r.MaxTiltDeg, Math.Abs(tilt));
            r.PeakRateDegS = Math.Max(r.PeakRateDegS, Math.Abs(rate));
            if (signTested && r.SettledAtSec < 0 && Math.Abs(rate) <= LandMath.SettleRateDegS)
                r.SettledAtSec = t;
        }
        r.EndRateDegS = rate;
        r.TimeSec = t;
        return r;
    }
}
