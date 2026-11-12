using System;
using System.Collections.Generic;

namespace HermesRts.Plugin
{
    /// <summary>
    /// T61 passenger rule: which occupied seats may steer, and how gently a ship
    /// carrying non-pilots may be flown.
    ///
    /// WHY THIS FILE EXISTS. The old control check treated ANY occupied ship
    /// controller as "under control" (`IMyShipController.IsUnderControl`), so a
    /// player sitting in a PASSENGER SEAT made telemetry say
    /// "Passenger Seat 2 is piloting" and the backend stopped sending that ship
    /// every order. Verified against the referenced DLLs (Sandbox.Game.dll,
    /// build 01_210_014):
    ///
    ///   MyShipController.get_IsUnderControl  => ControllerInfo.Controller != null
    ///   MyShipController.get_CanControlShip  => this.EnableShipControl
    ///
    /// i.e. IsUnderControl means "somebody is attached to this seat", NOT "this
    /// seat can fly the ship". A passenger seat (subtypes PassengerSeatLarge /
    /// PassengerSeatSmallNew / PassengerSeatSmallOffset / PassengerBench) has
    /// EnableShipControl = false, so its CanControlShip is false while a seated
    /// player still makes IsUnderControl true. A real pilot seat (Cockpit,
    /// ControlSeat, FlightSeat, and a Remote Control a player is driving) has
    /// CanControlShip = true.
    ///
    /// So: PILOT = occupied AND CanControlShip. Everything else occupied is a
    /// passenger. Pure C# (no game types) so the classification and the limit
    /// maths are unit-tested offline (tests/passenger-math).
    /// </summary>
    public sealed class SeatSample
    {
        /// <summary>Block custom name ('Passenger Seat 2').</summary>
        public string Name = "";
        /// <summary>Concrete block type name ('MyCockpit', 'MyRemoteControl').</summary>
        public string ControllerType = "";
        /// <summary>Definition subtype ('Cockpit', 'PassengerSeatLarge', 'LargeBlockRemoteControl').</summary>
        public string Subtype = "";
        /// <summary>`IMyShipController.IsUnderControl`: a player is attached to this seat.</summary>
        public bool Occupied;
        /// <summary>`IMyShipController.CanControlShip`: the definition enables ship control.</summary>
        public bool CanControlShip;
        public bool IsRemoteControl;
        public bool IsMain;
    }

    public sealed class CrewClassification
    {
        /// <summary>Index into the input list, or -1 when nobody is flying.</summary>
        public int PilotIndex = -1;
        public readonly List<int> PassengerIndexes = new List<int>();

        public bool HasPilot { get { return PilotIndex >= 0; } }
        public bool HasPassengers { get { return PassengerIndexes.Count > 0; } }
    }

    /// <summary>
    /// Limits for a ship with people aboard who are not flying it. `null`
    /// limits mean "no change": the normal flight profile applies.
    /// </summary>
    public sealed class PassengerLimits
    {
        public double MaxSpeedMps;
        public double MaxLateralAccelMps2;
        public double MaxVerticalAccelMps2;
        /// <summary>Vacuum cruise with the dampeners released is refused.</summary>
        public bool AllowDampenersOff;
        /// <summary>A ballistic free-fall descent phase is refused.</summary>
        public bool AllowFreeFall;
        /// <summary>A player is standing on/inside the hull but not seated.</summary>
        public bool Standing;
        public bool Carrying;
        public string Reason = "";
    }

    public static class PassengerMath
    {
        /// <summary>Passenger cruise cap, m/s (the normal cap is the config's 100).</summary>
        public const double PassengerSpeedCapMps = 60.0;
        /// <summary>Lateral acceleration cap with a seated passenger, g.</summary>
        public const double PassengerLateralAccelG = 0.5;
        /// <summary>Vertical (climb/descent) acceleration cap with a passenger, g.</summary>
        public const double PassengerVerticalAccelG = 1.0;
        /// <summary>
        /// A player standing inside the hull is held on by nothing but friction
        /// and SE throws them off under sustained thrust (T61.3), so a standing
        /// player gets half a passenger's allowance and no dampener release.
        /// </summary>
        public const double StandingLateralAccelG = 0.25;
        public const double StandingVerticalAccelG = 0.5;
        /// <summary>Reference gravity when the local value is unknown, m/s2.</summary>
        public const double StandardGravityMps2 = 9.81;
        /// <summary>A character within this distance outside the grid AABB still counts as aboard.</summary>
        public const double HullAabbMarginM = 2.0;

        /// <summary>
        /// The classification rule, in one place: the FIRST occupied controller
        /// that can actually fly the ship is the pilot; every other occupied seat
        /// is a passenger. A Remote Control a player is driving is a pilot seat
        /// because its CanControlShip is true and its IsUnderControl is exactly
        /// "a controller is attached".
        /// </summary>
        public static CrewClassification Classify(IList<SeatSample> seats)
        {
            var result = new CrewClassification();
            if (seats == null) return result;
            for (var i = 0; i < seats.Count; i++)
            {
                var seat = seats[i];
                if (seat == null || !seat.Occupied) continue;
                if (seat.CanControlShip && result.PilotIndex < 0) result.PilotIndex = i;
                else result.PassengerIndexes.Add(i);
            }
            return result;
        }

        /// <summary>
        /// Limits for a ship with non-pilots aboard. Returns null when nobody is
        /// aboard besides the pilot, so the caller keeps the normal profile.
        /// </summary>
        public static PassengerLimits Limits(bool hasPassengers, bool hasStanding, double gravityMps2)
        {
            if (!hasPassengers && !hasStanding) return null;
            var g = gravityMps2 > 0.1 && !double.IsNaN(gravityMps2) ? gravityMps2 : StandardGravityMps2;
            var standing = hasStanding;
            var lateralG = standing ? StandingLateralAccelG : PassengerLateralAccelG;
            var verticalG = standing ? StandingVerticalAccelG : PassengerVerticalAccelG;
            return new PassengerLimits
            {
                MaxSpeedMps = PassengerSpeedCapMps,
                MaxLateralAccelMps2 = lateralG * g,
                MaxVerticalAccelMps2 = verticalG * g,
                AllowDampenersOff = false,
                AllowFreeFall = false,
                Standing = standing,
                Carrying = hasPassengers,
                Reason = standing
                    ? "a player is standing inside the hull (not seated): dampeners stay on, no free fall, " +
                      Math.Round(StandingLateralAccelG, 2) + " g lateral / " + Math.Round(StandingVerticalAccelG, 2) +
                      " g vertical and " + PassengerSpeedCapMps + " m/s"
                    : "carrying a passenger: dampeners stay on, no free fall, " +
                      Math.Round(PassengerLateralAccelG, 2) + " g lateral / " + Math.Round(PassengerVerticalAccelG, 2) +
                      " g vertical and " + PassengerSpeedCapMps + " m/s",
            };
        }

        /// <summary>Cap a commanded speed (m/s). Null limits change nothing.</summary>
        public static double CapSpeed(double speedMps, PassengerLimits limits)
        {
            if (limits == null || double.IsNaN(speedMps)) return speedMps;
            return Math.Min(speedMps, limits.MaxSpeedMps);
        }

        /// <summary>Cap an available acceleration (m/s2) along a vertical or lateral axis.</summary>
        public static double CapAccel(double accelMps2, bool vertical, PassengerLimits limits)
        {
            if (limits == null || double.IsNaN(accelMps2)) return accelMps2;
            var cap = vertical ? limits.MaxVerticalAccelMps2 : limits.MaxLateralAccelMps2;
            return Math.Min(accelMps2, cap);
        }

        /// <summary>May this ship fly a dampeners-off phase (vacuum cruise, free fall)?</summary>
        public static bool DampenersOffAllowed(PassengerLimits limits)
        {
            return limits == null || limits.AllowDampenersOff;
        }

        /// <summary>May this ship fly a ballistic free-fall descent phase?</summary>
        public static bool FreeFallAllowed(PassengerLimits limits)
        {
            return limits == null || limits.AllowFreeFall;
        }

        /// <summary>
        /// Is a world point inside a grid's AABB (padded by `margin`)? Used for
        /// "a player is standing on/inside the hull but not seated". A player
        /// seated in a controller is excluded by the caller, never by geometry.
        /// </summary>
        public static bool InsideAabb(
            double x, double y, double z,
            double minX, double minY, double minZ,
            double maxX, double maxY, double maxZ,
            double margin)
        {
            var m = margin > 0 ? margin : 0;
            return x >= minX - m && x <= maxX + m &&
                   y >= minY - m && y <= maxY + m &&
                   z >= minZ - m && z <= maxZ + m;
        }

        /// <summary>Plain sentence for the audit/site: who is aboard and what the caps are.</summary>
        public static string Describe(PassengerLimits limits, IList<string> passengerNames)
        {
            if (limits == null) return "no passengers";
            var names = passengerNames != null && passengerNames.Count > 0
                ? string.Join(", ", passengerNames)
                : "unnamed";
            var carrying = limits.Standing
                ? "standing aboard: " + names
                : "carrying " + names;
            return carrying + "; " + limits.Reason;
        }
    }
}
