using System;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Pure math for the level-mode flight controller (T25). No game types are
    /// used here on purpose: this file is compiled into the plugin AND into a
    /// small offline test program (plugin/HermesRts.Plugin/tests/level-math), so
    /// the control law, the guard thresholds and the thrust distribution can be
    /// unit-tested without the game.
    ///
    /// All inputs are SI: metres, seconds, newtons, m/s, m/s^2, degrees.
    /// </summary>
    public static class LevelMath
    {
        public const double MinGravityMs2 = 0.05;

        public static double Clamp(double v, double lo, double hi)
        {
            if (double.IsNaN(v)) return lo;
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        /// <summary>Tilt between the grid's up axis and the anti-gravity "up", degrees.</summary>
        public static double TiltDeg(double dotGridUpAndUp)
        {
            var d = Clamp(dotGridUpAndUp, -1.0, 1.0);
            return Math.Acos(d) * 180.0 / Math.PI;
        }

        /// <summary>
        /// Vertical acceleration command for a PD loop on altitude AGL and
        /// vertical speed (positive = up). Clamped so the controller can never
        /// ask for more than the hull has.
        /// </summary>
        public static double VerticalAccel(
            double targetAglM, double aglM, double verticalSpeedMps,
            double kp, double kd, double maxUpAccel, double maxDownAccel)
        {
            var err = targetAglM - aglM;
            var a = kp * err - kd * verticalSpeedMps;
            return Clamp(a, -Math.Abs(maxDownAccel), Math.Abs(maxUpAccel));
        }

        /// <summary>
        /// Horizontal acceleration command for a PD loop on position and
        /// velocity. Returns a 2D vector in the plane perpendicular to gravity
        /// (x = unit east-ish, z = unit north-ish of the caller's frame).
        /// </summary>
        public static void HorizontalAccel(
            double errX, double errZ, double velX, double velZ,
            double kp, double kd, double maxLatAccel,
            double speedCapMps,
            out double ax, out double az)
        {
            ax = kp * errX - kd * velX;
            az = kp * errZ - kd * velZ;
            var mag = Math.Sqrt(ax * ax + az * az);
            var cap = Math.Abs(maxLatAccel);
            if (mag > cap && mag > 0)
            {
                ax = ax / mag * cap;
                az = az / mag * cap;
            }
            // Hard speed cap: above it, only brake (never accelerate further).
            var speed = Math.Sqrt(velX * velX + velZ * velZ);
            if (speedCapMps > 0 && speed > speedCapMps)
            {
                var bx = -velX / speed * cap;
                var bz = -velZ / speed * cap;
                if (ax * velX + az * velZ > 0) { ax = bx; az = bz; }
            }
        }

        /// <summary>
        /// Per-direction thrust override: how much of a bank's capacity is needed
        /// to supply <paramref name="forceN"/> along that bank's axis. 0..1.
        /// </summary>
        public static double AxisOverride(double forceN, double capacityN)
        {
            if (capacityN <= 1.0 || forceN <= 0) return 0.0;
            return Clamp(forceN / capacityN, 0.0, 1.0);
        }

        /// <summary>Ground floor: never descend into terrain, never below 25 m unless the target is lower.</summary>
        public static double GroundFloor(double targetAglM)
        {
            return targetAglM < 25.0 ? Math.Max(2.0, targetAglM - 3.0) : 25.0;
        }

        /// <summary>Braking distance at a constant decel (m).</summary>
        public static double BrakeDistance(double speedMps, double decelMs2)
        {
            if (decelMs2 <= 0.01) return double.MaxValue;
            return speedMps * speedMps / (2.0 * decelMs2);
        }

        /// <summary>
        /// Which bank direction is "lift": the sign that maps a grid thrust
        /// direction onto the grid's local up axis. Returns +1 when the game's
        /// GridThrustDirection is already the push direction (the common case),
        /// -1 when it is the exhaust direction.
        /// </summary>
        public static double LiftSign(double dotDirectionLocalUp)
        {
            return dotDirectionLocalUp >= 0 ? 1.0 : -1.0;
        }

        /// <summary>
        /// Decide whether a level job may start at all. Pure policy, so the
        /// refusal reasons are testable and identical in the plugin and in docs.
        /// </summary>
        public static string StartRefusal(
            bool isStatic, bool hasPhysics, double gravityMs2,
            double tiltDeg, double maxTiltDeg,
            double upThrustN, double massKg, double aglM, double minAglM,
            bool underPlayerControl)
        {
            if (underPlayerControl) return "manual control: a player is piloting this grid";
            if (isStatic) return "grid is static (station mode): convert_to_ship first";
            if (!hasPhysics) return "grid has no physics body";
            if (gravityMs2 < MinGravityMs2) return "no gravity: level mode is for gravity flight";
            if (massKg <= 0) return "mass unreadable";
            if (tiltDeg > maxTiltDeg) return "tilt " + Math.Round(tiltDeg, 1) + " deg exceeds " + maxTiltDeg + " deg before start";
            if (upThrustN < massKg * gravityMs2 * 1.05)
                return "lift thrust " + Math.Round(upThrustN / 1000) + " kN < 1.05 x weight " +
                       Math.Round(massKg * gravityMs2 / 1000) + " kN";
            if (aglM < minAglM) return "AGL " + Math.Round(aglM, 1) + " m below floor " + minAglM + " m";
            return null;
        }
    }
}
