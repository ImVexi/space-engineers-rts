using System;
using System.Collections.Generic;
using HermesRts.Plugin;

// Offline unit tests for the T61 passenger rule: the seat classification and
// the limits a ship with non-pilots aboard is flown under. No game, no
// network: `dotnet run` in this directory; exit code 0 = all pass.
//
// The property semantics these tests encode were read out of the referenced
// DLLs (plugin/refs/Sandbox.Game.dll):
//   MyShipController.get_IsUnderControl  => ControllerInfo.Controller != null
//   MyShipController.get_CanControlShip  => EnableShipControl (definition flag)
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

    private static SeatSample Cockpit(bool occupied, bool canControl = true, string name = "Cockpit")
    {
        return new SeatSample
        {
            Name = name,
            ControllerType = "MyCockpit",
            Subtype = canControl ? "Cockpit" : "PassengerSeatLarge",
            Occupied = occupied,
            CanControlShip = canControl,
        };
    }

    private static SeatSample Passenger(bool occupied = true, string name = "Passenger Seat 2")
    {
        return new SeatSample
        {
            Name = name,
            ControllerType = "MyCockpit",
            Subtype = "PassengerSeatLarge",
            Occupied = occupied,
            CanControlShip = false,
        };
    }

    private static SeatSample RemoteControl(bool inUse)
    {
        return new SeatSample
        {
            Name = "Remote Control",
            ControllerType = "MyRemoteControl",
            Subtype = "LargeBlockRemoteControl",
            Occupied = inUse,
            CanControlShip = true,
            IsRemoteControl = true,
        };
    }

    private static int Main()
    {
        // ---------------------------------------------------------- classification
        var empty = PassengerMath.Classify(new List<SeatSample> { Cockpit(false), Passenger(false) });
        Check("classify: nobody seated -> no pilot, no passengers", !empty.HasPilot && !empty.HasPassengers);

        var passengerOnly = PassengerMath.Classify(new List<SeatSample> { Passenger() });
        Check("classify: a seated passenger is NOT a pilot", !passengerOnly.HasPilot);
        Check("classify: the passenger is reported", passengerOnly.PassengerIndexes.Count == 1 && passengerOnly.PassengerIndexes[0] == 0);

        // The exact bug: 'Passenger Seat 2 is piloting'. IsUnderControl true on a
        // seat whose CanControlShip is false.
        var bug = new List<SeatSample> { Passenger(true, "Passenger Seat 2") };
        Check("classify: IsUnderControl on a passenger seat cannot pilot the ship",
            !PassengerMath.Classify(bug).HasPilot);

        var piloted = PassengerMath.Classify(new List<SeatSample> { Cockpit(true) });
        Check("classify: an occupied cockpit IS the pilot", piloted.HasPilot && piloted.PilotIndex == 0);

        var rc = PassengerMath.Classify(new List<SeatSample> { RemoteControl(true) });
        Check("classify: a Remote Control a player is driving IS the pilot", rc.HasPilot && rc.PilotIndex == 0);

        var rcIdle = PassengerMath.Classify(new List<SeatSample> { RemoteControl(false) });
        Check("classify: an idle Remote Control is not a pilot", !rcIdle.HasPilot && !rcIdle.HasPassengers);

        var mixed = PassengerMath.Classify(new List<SeatSample> { Passenger(true, "Seat A"), Cockpit(true), Passenger(true, "Seat B") });
        Check("classify: pilot + two passengers", mixed.HasPilot && mixed.PilotIndex == 1 && mixed.PassengerIndexes.Count == 2);

        var twoControlSeats = PassengerMath.Classify(new List<SeatSample> { Cockpit(true, true, "Cockpit"), Cockpit(true, true, "Flight Seat") });
        Check("classify: exactly one pilot (first occupied controllable seat)",
            twoControlSeats.HasPilot && twoControlSeats.PilotIndex == 0 && twoControlSeats.PassengerIndexes.Count == 1);

        var nullSeats = PassengerMath.Classify(null);
        Check("classify: null list is empty, not a crash", !nullSeats.HasPilot && !nullSeats.HasPassengers);

        // ---------------------------------------------------------------- limits
        var noLimits = PassengerMath.Limits(false, false, 9.81);
        Check("limits: no one aboard -> null (normal profile)", noLimits == null);

        var pax = PassengerMath.Limits(true, false, 9.81)!;
        Near("limits: passenger speed cap is 60 m/s", pax.MaxSpeedMps, 60, 1e-9);
        Near("limits: passenger lateral is 0.5 g", pax.MaxLateralAccelMps2, 4.905, 1e-6);
        Near("limits: passenger vertical is 1 g", pax.MaxVerticalAccelMps2, 9.81, 1e-6);
        Check("limits: passenger forbids dampeners off", !pax.AllowDampenersOff);
        Check("limits: passenger forbids the free-fall phase", !pax.AllowFreeFall);
        Check("limits: passenger is carrying, not standing", pax.Carrying && !pax.Standing);

        var standing = PassengerMath.Limits(false, true, 9.81)!;
        Near("limits: standing lateral is 0.25 g (half a passenger)", standing.MaxLateralAccelMps2, 2.4525, 1e-6);
        Near("limits: standing vertical is 0.5 g", standing.MaxVerticalAccelMps2, 4.905, 1e-6);
        Check("limits: standing forbids dampeners off and free fall",
            !standing.AllowDampenersOff && !standing.AllowFreeFall);
        Check("limits: standing is the hard cap", standing.Standing);
        Check("limits: standing wins over a seated passenger (harder limits)",
            standing.MaxLateralAccelMps2 < pax.MaxLateralAccelMps2);

        var moon = PassengerMath.Limits(true, false, 1.62)!;
        Near("limits: caps scale with local gravity (moon 1.62)", moon.MaxVerticalAccelMps2, 1.62, 1e-6);
        var unknownG = PassengerMath.Limits(true, false, double.NaN)!;
        Near("limits: unknown gravity falls back to 9.81", unknownG.MaxVerticalAccelMps2, 9.81, 1e-6);
        var zeroG = PassengerMath.Limits(true, false, 0)!;
        Near("limits: zero-g telemetry still gets a sane cap", zeroG.MaxVerticalAccelMps2, 9.81, 1e-6);

        // ------------------------------------------------------------- caps/verbs
        Near("cap: a 100 m/s cruise becomes 60", PassengerMath.CapSpeed(100, pax), 60, 1e-9);
        Near("cap: a 12 m/s approach is untouched", PassengerMath.CapSpeed(12, pax), 12, 1e-9);
        Near("cap: no limits leaves the speed alone", PassengerMath.CapSpeed(100, null), 100, 1e-9);
        Near("cap: lateral accel clamps 20 -> 4.905", PassengerMath.CapAccel(20, false, pax), 4.905, 1e-6);
        Near("cap: vertical accel clamps 20 -> 9.81", PassengerMath.CapAccel(20, true, pax), 9.81, 1e-6);
        Near("cap: standing lateral clamps 20 -> 2.4525", PassengerMath.CapAccel(20, false, standing), 2.4525, 1e-6);
        Check("verb: dampeners off refused with a passenger", !PassengerMath.DampenersOffAllowed(pax));
        Check("verb: dampeners off allowed with nobody aboard", PassengerMath.DampenersOffAllowed(null));
        Check("verb: free fall refused with a passenger", !PassengerMath.FreeFallAllowed(pax));
        Check("verb: free fall allowed with nobody aboard", PassengerMath.FreeFallAllowed(null));

        // ------------------------------------------------------- standing geometry
        Check("aabb: a point in the middle is inside",
            PassengerMath.InsideAabb(0, 0, 0, -5, -5, -5, 5, 5, 5, 2));
        Check("aabb: 1 m outside a face is still aboard (margin 2)",
            PassengerMath.InsideAabb(5.5, 0, 0, -5, -5, -5, 5, 5, 5, 2));
        Check("aabb: 10 m outside a face is not aboard",
            !PassengerMath.InsideAabb(15, 0, 0, -5, -5, -5, 5, 5, 5, 2));
        Check("aabb: negative margin is treated as zero",
            !PassengerMath.InsideAabb(5.5, 0, 0, -5, -5, -5, 5, 5, 5, -3));

        // ------------------------------------------------------------- sentences
        var sentence = PassengerMath.Describe(pax, new List<string> { "owner" });
        Check("text: names the passenger", sentence.Contains("owner"), sentence);
        Check("text: states the speed cap", sentence.Contains("60 m/s"), sentence);
        var standSentence = PassengerMath.Describe(standing, new List<string> { "owner" });
        Check("text: standing is called out", standSentence.Contains("standing"), standSentence);
        Check("text: no passengers is a plain phrase", PassengerMath.Describe(null, null) == "no passengers");

        Console.WriteLine();
        Console.WriteLine(_fail == 0
            ? "ALL PASS (" + _pass + " checks)"
            : _fail + " FAILED of " + (_pass + _fail) + " checks");
        return _fail == 0 ? 0 : 1;
    }
}
