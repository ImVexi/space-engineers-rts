using System;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Pure math for the plugin's final-descent landing controller (`land_at`).
    ///
    /// No game types are used here on purpose: this file is compiled into the
    /// plugin AND into an offline test program (plugin/HermesRts.Plugin/tests/
    /// land-math), so the setpoint schedule, the control law and the abort
    /// policy are unit-tested without the game.
    ///
    /// SIGN CONVENTION. `keelDepthM` is the signed pivot -> hull-bottom distance
    /// that `GridGeometry.KeelDepthM` measures and that telemetry reports:
    ///   positive -> the hull extends BELOW the pivot;
    ///   negative -> the hull's lowest block sits ABOVE the pivot (SAT-R-0001
    ///               measured -10 m, which is why a rule phrased on the pivot's
    ///               altitude can only fire with the hull 10 m inside the hill).
    /// Therefore, exactly as the backend's `hullBottomAglM`:
    ///   hullBottomAgl = positionAgl - keelDepth
    ///
    /// All inputs are SI: metres, seconds, newtons, m/s, m/s^2, degrees.
    /// </summary>
    public static class LandMath
    {
        // --- touchdown (the same thresholds the backend uses, so a controller
        // --- and the monitor that watches it cannot disagree)
        public const double TouchdownAglM = 2.0;
        public const double TouchdownMps = 0.5;
        /// <summary>Contact inside this speed while the lift bank is below weight.</summary>
        public const double ContactMps = 0.15;
        public const double ContactMaxAglM = 3.0;
        /// <summary>A hull pressing on terrain cannot need more than a hair under its weight.</summary>
        public const double ContactThrustRatio = 0.99;

        // --- abort rules
        /// <summary>
        /// Tilt that ends the DESCENT. Raised to 35 deg because a hull still
        /// carrying a little residual spin crossed 27 deg before the old 25 deg
        /// rule could learn its gyro sign, and the abort (in the old code) then
        /// dropped it 240 m. An abort no longer releases anything: it enters the
        /// safe-hover hold below, so a wider gate only means more attempts.
        /// </summary>
        public const double MaxTiltDeg = 35.0;
        public const double MinLiftRatio = 1.05;
        public const double MaxJobSec = 120.0;
        public const double ClimbWindowSec = 5.0;
        /// <summary>Rise above the best AGL seen that counts as "climbing", m.</summary>
        public const double ClimbToleranceM = 1.0;
        /// <summary>Terrain this much nearer than the ground datum aborts (safety valve).</summary>
        public const double GroundDisagreementM = 30.0;

        // --- live ground datum (defect b, 2026-11-11)
        /// <summary>
        /// A ground-radius update smaller than this is not worth a write: the
        /// level-5 height field is quantised and the hull drifts a metre or two
        /// per column. m.
        /// </summary>
        public const double GroundUpdateMinDeltaM = 1.5;
        /// <summary>
        /// A datum that moves more than this between two updates is not terrain,
        /// it is a broken sample (a descent crosses a few metres of radius per
        /// second, a ridge is tens): the update is refused and logged.
        /// </summary>
        public const double GroundUpdateMaxJumpM = 250.0;
        /// <summary>Rate limit for accepted updates, s.</summary>
        public const double GroundUpdateMinIntervalSec = 1.0;

        // --- rate damping on the roll/pitch axes during the descent (defect c)
        /// <summary>
        /// Extra damping gain on the horizontal angular rate. The attitude
        /// helper already carries `-omega * 1.1`; a single-gyro hull answered
        /// that with a residual ~1.5 deg/s that rode the whole descent, so the
        /// descent adds its own term that the tilt correction cannot swamp.
        /// </summary>
        public const double DescentRateDampGain = 1.6;
        /// <summary>Cap on the extra damping demand, rad/s of commanded rate.</summary>
        public const double DescentRateDampCapRadS = 0.35;
        /// <summary>Hulls at or under this residual spin are already damped, deg/s.</summary>
        public const double DescentRateDampDeadbandDegS = 0.2;

        /// <summary>
        /// True when a ground update should be accepted: a finite radius above
        /// zero, either the first update or a change inside the jump limit.
        /// Returns `reason == null` when accepted.
        /// </summary>
        public static bool AcceptGroundUpdate(double groundRadiusM, double previousRadiusM, out string reason)
        {
            reason = null;
            if (!IsFinite(groundRadiusM) || groundRadiusM <= 0)
            {
                reason = "ground radius " + groundRadiusM + " is not a ground radius";
                return false;
            }
            if (!IsFinite(previousRadiusM) || previousRadiusM <= 0) return true;
            var delta = Math.Abs(groundRadiusM - previousRadiusM);
            if (delta > GroundUpdateMaxJumpM)
            {
                reason = "ground radius jumped " + Math.Round(delta, 1) + " m (" +
                         Math.Round(previousRadiusM, 1) + " -> " + Math.Round(groundRadiusM, 1) +
                         "): more than terrain moves in an update, keeping the previous datum";
                return false;
            }
            return true;
        }

        /// <summary>
        /// Extra roll/pitch damping demand, rad/s of commanded angular rate, for
        /// a measured horizontal rate. Zero inside the deadband, capped, and
        /// NaN-safe so a bad sample can never command a spin.
        /// </summary>
        public static double RateDampDemandRadS(double rateRadS, bool fullGain,
            double gain = DescentRateDampGain, double capRadS = DescentRateDampCapRadS)
        {
            if (!IsFinite(rateRadS)) return 0.0;
            var rateDegS = Math.Abs(rateRadS) * 180.0 / Math.PI;
            if (rateDegS <= DescentRateDampDeadbandDegS) return 0.0;
            var g = fullGain ? gain : gain * 0.5;
            var demand = -rateRadS * g;
            if (Math.Abs(demand) > capRadS) demand = Math.Sign(demand) * capRadS;
            return demand;
        }

        // --- yaw (up-axis) rate damping during a landing (2026-11-11)
        //
        // WHY. `RateDamped` damps the HORIZONTAL rate only: a landing is not a
        // turn, so yaw was left alone by design. The 2026-11-11 run set 2 showed
        // what that costs: a datum jump cut the lift command to 35 % at ~18 m
        // clearance, the hull spun to 32.1 deg/s about its own up axis, and the
        // 10 deg/s descent abort fired (safe hover then levelled it in 2.1 s).
        // The gyro had the authority all along - 38.1 deg/s per unit of override,
        // measured by its own sign test - and simply was not asked to use it.
        //
        // The damper drives the up-axis RATE to zero, never to a heading: it
        // holds no attitude, it is a pure rate term. It is expressed against the
        // hull's MEASURED command scale, so the loop gain is the same on a hull
        // whose gyro delivers 38 deg/s per unit and on one that delivers 5.
        /// <summary>
        /// Loop gain of the yaw rate damper, per unit of the hull's measured
        /// command scale. 0.6 is deliberately below the 1.1 the horizontal
        /// attitude term carries: yaw may help steady the hull but must never be
        /// the fastest loop in the stack, or a yaw correction would out-run a
        /// tilt correction and (through the shared gyro vector) push the hull
        /// off level.
        /// </summary>
        public const double YawRateDampGain = 0.6;
        /// <summary>Hard cap on the yaw damping demand, gyro override units (0-1): half override.</summary>
        public const double YawRateDampMaxOverride = 0.5;
        /// <summary>Up-axis rate this small is already damped, deg/s.</summary>
        public const double YawRateDampDeadbandDegS = 0.5;
        /// <summary>
        /// Total attitude demand magnitude the controller may command, in
        /// override units: the same 0.9 `AttitudeRotation` caps its own output
        /// at. Yaw damping is fitted into what the tilt correction leaves free.
        /// </summary>
        public const double AttitudeOverrideCap = 0.9;

        /// <summary>
        /// Yaw rate damping demand, gyro override units, to oppose a measured
        /// up-axis rate. Signed: the caller adds it along the hull's up axis.
        ///
        /// DISABLED UNLESS THE YAW SIGN IS PROVEN. A wrong sign here would not
        /// merely fail to damp: the demand is computed FROM the measured rate, so
        /// inverted authority is POSITIVE FEEDBACK - on a saturated gyro (a torque
        /// source, no rate feedback) the rate grows exponentially instead of
        /// decaying. The sign test proves the three axes at once
        /// (it commands yaw about the hull's up axis and reads the rate CHANGE
        /// along it), so `yawSignProven` is the same evidence that lets the
        /// attitude loop run at full gain - and it is revoked on a sign flip.
        /// With no evidence this returns 0: not damped, never guessed.
        /// </summary>
        public static double YawRateDampOverride(
            double rateUpDegS, double ratePerCommandDegS, bool yawSignProven,
            double gain = YawRateDampGain, double maxOverride = YawRateDampMaxOverride)
        {
            if (!yawSignProven) return 0.0;
            if (!IsFinite(rateUpDegS)) return 0.0;
            if (Math.Abs(rateUpDegS) <= YawRateDampDeadbandDegS) return 0.0;
            if (!IsFinite(gain) || gain <= 0) return 0.0;
            var scale = IsFinite(ratePerCommandDegS) && ratePerCommandDegS > 0.1
                ? ratePerCommandDegS
                : NominalRatePerCommandDegS;
            var cap = IsFinite(maxOverride) && maxOverride > 0 ? maxOverride : YawRateDampMaxOverride;
            var demand = -(rateUpDegS / scale) * gain;
            return LevelMath.Clamp(demand, -cap, cap);
        }

        /// <summary>
        /// Fit a yaw demand into the override budget the tilt correction leaves.
        /// PITCH/ROLL KEEP PRIORITY: the tilt/magnitude command is never reduced
        /// by this function, only the yaw term is; a tilt correction already at
        /// the cap leaves no room and yaw damping is simply not flown this tick.
        /// </summary>
        public static double YawWithinAttitudeBudget(
            double attitudeMagnitude, double yawDemand, double cap = AttitudeOverrideCap)
        {
            if (!IsFinite(yawDemand) || yawDemand == 0.0) return 0.0;
            var used = IsFinite(attitudeMagnitude) ? Math.Abs(attitudeMagnitude) : cap;
            var room = (IsFinite(cap) && cap > 0 ? cap : AttitudeOverrideCap) - used;
            if (room <= 0.0) return 0.0;
            return Math.Abs(yawDemand) <= room ? yawDemand : Math.Sign(yawDemand) * room;
        }

        // --- safe hover (what an abort does instead of letting go)
        /// <summary>Tilt the hull must hold before the abort releases the overrides, deg.</summary>
        public const double SafeHoverTiltDeg = 5.0;
        /// <summary>Speed the hull must hold before the abort releases the overrides, m/s.</summary>
        public const double SafeHoverSpeedMps = 0.5;
        /// <summary>How long calm must last before the overrides are released, s.</summary>
        public const double SafeHoverCalmSec = 2.0;
        /// <summary>A hull this low is on the ground: the hover may hand back immediately, m.</summary>
        public const double SafeHoverGroundAglM = 1.0;
        /// <summary>Vertical-speed damping during the abort hold, 1/s.</summary>
        public const double SafeHoverGain = 1.8;
        /// <summary>Upward acceleration authority while holding, x g.</summary>
        public const double SafeHoverUpAccelG = 0.5;
        /// <summary>
        /// Downward authority while holding, x g. Deliberately smaller than the
        /// up side: a hold must never be able to command a fall, only to settle
        /// onto the ground it is already touching.
        /// </summary>
        public const double SafeHoverDownAccelG = 0.2;

        // --- settle (attitude gate before any descent)
        /// <summary>Angular rate the hull must be under before the descent starts, deg/s.</summary>
        public const double SettleRateDegS = 0.5;
        /// <summary>Hard cap on the settle. Never longer: the descent has to start.</summary>
        public const double SettleMaxSec = 15.0;
        /// <summary>
        /// Angular rate that refuses a `land_at` start outright, deg/s.
        ///
        /// 30, not 2. Measured 2026-11-10: both in-game attempts arrived with a
        /// residual spin from the previous aborted mission (10 and 23 deg/s) and
        /// the 2 deg/s start gate would have refused the ONLY run that could
        /// recover the hull. The settle phase exists precisely to damp an
        /// arrival spin, so the start gate must not be tighter than what the
        /// settle can fly: 30 deg/s is well inside the gyro's authority.
        ///
        /// Flight set 6 raised this to 90 deg/s because the lateral leg handed
        /// the hull over at 80.5 deg/s. That change is REVERTED pending the
        /// owner's explicit approval (a safety limit is the owner's call, not
        /// the agent's): the backend now runs its own settle step BEFORE the
        /// `land_at` handover and waits on the same measured rate, so the spin
        /// is brought under this gate on the backend side instead of by
        /// widening the gate. The IN-FLIGHT abort (`DescentSpinAbortDegS` = 10
        /// deg/s) was never touched.
        /// </summary>
        public const double SpinRefuseDegS = 30.0;
        /// <summary>
        /// Length of the gyro sign test, ticks (0.1 s each). Four ticks is the
        /// 0.4 s measurement window: inside the 0.5 s budget, long enough for a
        /// 1 deg/s command to move the hull by more than the noise floor.
        /// </summary>
        public const int SignTestTicks = 4;
        /// <summary>
        /// Yaw command the sign test applies (unitless gyro override, 0-1).
        /// Small on purpose: about 1 deg/s on a hull whose full override is
        /// ~20 deg/s, i.e. a rotation a pilot would not notice.
        /// </summary>
        public const double SignTestYawCommand = 0.06;
        /// <summary>Attempts at the sign test (the second one doubles the command).</summary>
        public const int SignTestAttempts = 2;
        /// <summary>Command multiplier per retry.</summary>
        public const double SignTestRetryScale = 2.0;
        /// <summary>A rate CHANGE below this is not evidence of a sign either way, deg/s.</summary>
        public const double SignTestMinRateDegS = 0.05;
        /// <summary>
        /// Nominal angular rate a full gyro override produces, deg/s. Only used
        /// to convert a deg/s^2 acceleration cap into a per-tick command step
        /// BEFORE the sign test has measured the hull's real response.
        /// </summary>
        public const double NominalRatePerCommandDegS = 20.0;
        /// <summary>
        /// Commanded angular-acceleration cap while the gyro sign is UNPROVEN,
        /// deg/s^2. This is the number that would have saved the hull: the
        /// wrong-sign fallback applied a full-gain correction and measured
        /// 15-68 deg/s^2 (7.5 deg of tilt in 0.11 s). At 2 deg/s^2 a wrong-sign
        /// tick can add at most 0.2 deg/s per tick and the sign-learning rule
        /// sees the growth long before the tilt gate.
        /// </summary>
        public const double UnprovenSignAngularAccelDegS2 = 2.0;
        /// <summary>Commanded angular-acceleration cap once the sign is proven, deg/s^2.</summary>
        public const double ProvenSignAngularAccelDegS2 = 20.0;
        /// <summary>
        /// Fraction of the normal attitude correction allowed while the sign is
        /// unproven (10 %). Never the full correction on an unverified sign.
        /// </summary>
        public const double UnprovenSignGainScale = 0.10;
        /// <summary>Cooldown between two sign flips, s: each flip needs its own evidence window.</summary>
        public const double SignFlipCooldownSec = 0.4;
        /// <summary>
        /// How long the low gain and the tight acceleration cap stay armed
        /// after the sign test or a flip, s: the loop is not trusted instantly.
        /// </summary>
        public const double SignSettleInSec = 1.0;
        /// <summary>
        /// Tilt growth inside one second that proves the gyro is pushing the
        /// wrong way, deg. The old rule needed a slow +0.02 deg per tick and
        /// took ~1 s to arm; this fires on the first real growth.
        /// </summary>
        public const double SignFlipGrowthDeg = 0.3;
        /// <summary>Window the growth must happen inside, s.</summary>
        public const double SignFlipWindowSec = 1.0;

        // --- start refusals
        /// <summary>
        /// A hull bottom this close to the ground is already down: there is
        /// nothing to land, and a "descent" from it only drags the hull.
        /// </summary>
        public const double MinStartHullBottomAglM = 1.0;

        /// <summary>
        /// Angular rate that ends a DESCENT (into the safe hover), deg/s: a
        /// tumbling hull is not landing. Unchanged at 10 — but it now applies to
        /// the descent phases ONLY (<see cref="DescentPhase"/>), never to the
        /// settle (whose job is to damp an arrival spin) and never to the abort
        /// hold (which is recovery).
        /// </summary>
        public const double DescentSpinAbortDegS = 10.0;

        /// <summary>
        /// Does <paramref name="phase"/> fly the controlled descent? Only these
        /// phases may be ended by the 10 deg/s spin rule. Measured 2026-11-10:
        /// both `land_at` attempts were killed by that rule while still in
        /// `settling`, which is the one phase that is supposed to bring the rate
        /// down.
        /// </summary>
        public static bool DescentPhase(string phase)
        {
            return phase == "fall" || phase == "brake" || phase == "descending";
        }

        /// <summary>
        /// Does <paramref name="phase"/> fly UNDER THE LIFT BANK while it still
        /// has a horizontal job? `brake` and `descending` only. A free fall is a
        /// ballistic leg - lateral authority there steals the brake - and the
        /// settle and the safe hover own the gyro for other reasons. This is
        /// deliberately NARROWER than <see cref="DescentPhase"/>.
        /// </summary>
        public static bool LateralHoldPhase(string phase)
        {
            return phase == "brake" || phase == "descending";
        }

        // --- whole descent: fall -> brake -> controlled descent -> touchdown
        //
        // WHY THE PLUGIN OWNS THE FALL TOO. The backend used to fly the fall and
        // the brake and hand over at 150 m. It decides at telemetry cadence on a
        // single-threaded event loop, and measured 2026-11-10 a 1 Hz external
        // sampler starved that loop for 12.3 s mid-fall: the hull reached the
        // ground at 57 m/s with the handover order never sent (SAT-R-0001 lost
        // its 24 blocks). A descent that starts at ANY height therefore runs
        // here, every tick, with the brake height recomputed from the live
        // vertical speed so a fast fall always brakes in time.
        /// <summary>
        /// Safety factor on the computed stopping distance. The brake must start
        /// with room to spare: thrust is reduced by tilt, the hull's real mass
        /// grows with cargo, and gravity is not uniform over a 1 km fall.
        /// </summary>
        public const double BrakeMarginFactor = 1.3;
        /// <summary>Floor on the measured shed deceleration, m/s^2.</summary>
        public const double MinBrakeAccelMs2 = 0.5;
        /// <summary>Ceiling on the measured shed deceleration, m/s^2.</summary>
        public const double MaxBrakeAccelMs2 = 15.0;
        /// <summary>
        /// Upward-authority cap during the BRAKE, x g. The normal descent caps at
        /// <see cref="MaxAccelG"/> (0.5 g) for smoothness, but a brake that used
        /// 0.5 g on a hull with 17 m/s^2 of excess thrust would start about three
        /// times too low and hit the ground.
        /// </summary>
        public const double BrakeAuthorityG = 1.5;
        /// <summary>Free-fall speed cap when the order does not carry one, m/s.</summary>
        public const double DefaultMaxFallMps = 100.0;
        /// <summary>Velocity gain of the fall-cap hold, 1/s.</summary>
        public const double FallCapGain = 2.0;

        /// <summary>
        /// The hull's measured shed deceleration, m/s^2:
        ///   a_brake = lift capacity / mass - g
        /// i.e. what the lift bank can take off the sink rate once it is pointed
        /// straight up, clamped to what a brake should ever use.
        /// </summary>
        public static double BrakeAccelMs2(double liftCapacityN, double massKg, double gravityMs2)
        {
            if (!(massKg > 0) || !(gravityMs2 > 0)) return MinBrakeAccelMs2;
            var excess = liftCapacityN / massKg - gravityMs2;
            if (!IsFinite(excess)) return MinBrakeAccelMs2;
            return LevelMath.Clamp(excess, MinBrakeAccelMs2, MaxBrakeAccelMs2);
        }

        /// <summary>
        /// Hull-bottom AGL at which the brake must begin for the CURRENT sink
        /// rate, m:
        ///   brakeAgl = v^2 / (2 * a_brake) * 1.3 + band
        /// Recomputing it every tick is the safety property: the faster the hull
        /// is falling, the higher the brake point moves.
        /// </summary>
        public static double BrakeAglM(double sinkMps, double brakeAccelMs2, double bandM)
        {
            var v = Math.Max(0.0, IsFinite(sinkMps) ? sinkMps : 0.0);
            var a = IsFinite(brakeAccelMs2) && brakeAccelMs2 > MinBrakeAccelMs2
                ? brakeAccelMs2
                : MinBrakeAccelMs2;
            var band = Math.Max(0.5, IsFinite(bandM) ? bandM : 0.5);
            return v * v / (2.0 * a) * BrakeMarginFactor + band;
        }

        /// <summary>Start the brake: the hull bottom is at or below its brake height.</summary>
        public static bool ShouldBrake(
            double hullBottomAglM, double verticalSpeedUpMps, double brakeAccelMs2, double bandM)
        {
            if (!IsFinite(hullBottomAglM)) return true;   // unknown height brakes
            var sink = Math.Max(0.0, -(IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0));
            return hullBottomAglM <= BrakeAglM(sink, brakeAccelMs2, bandM);
        }

        /// <summary>
        /// Lift override fraction 0..1 during the FREE FALL, holding an optional
        /// speed cap:
        ///   demand = k * (sink - maxFall)          (+ only: how hard to shed speed)
        ///   thrust = clamp(m * (g + demand), 0, lift capacity)
        ///
        /// Below the cap `g + demand &lt; 0`, so the thrust is exactly 0 — a real
        /// free fall, no dampener pulse and no override fighting gravity.
        /// Approaching the cap the command rises through the hull's weight
        /// (demand = 0 at sink = cap), which is what HOLDING a speed costs, and
        /// above it the command exceeds weight and sheds speed. No step at the
        /// cap, so the hull cannot slam on a brake it did not need.
        /// </summary>
        public static double FallThrustFraction(
            double massKg, double gravityMs2, double verticalSpeedUpMps, double maxFallMps,
            double liftCapacityN, double gain, double maxAccelG)
        {
            if (!(liftCapacityN > 1.0) || !(massKg > 0)) return 0.0;
            var cap = maxFallMps > 0 ? maxFallMps : DefaultMaxFallMps;
            var g = Math.Max(0.0, IsFinite(gravityMs2) ? gravityMs2 : 0.0);
            var sink = -(IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0);
            var k = IsFinite(gain) && gain > 0 ? gain : FallCapGain;
            var limit = Math.Max(0.05, maxAccelG * g);
            var demand = k * (sink - cap);
            if (demand > limit) demand = limit;
            if (demand <= -g) return 0.0;                 // weight alone already exceeds the demand
            return ThrustFraction(massKg, g, demand, liftCapacityN);
        }

        // --- control law
        /// <summary>
        /// Velocity gain, 1/s: acceleration command per m/s of sink-rate error.
        /// Closed loop is dv/dt = k(v_des - v), so the sink rate tracks the
        /// schedule with a 0.63 s time constant at 10 Hz.
        /// </summary>
        public const double VelocityGain = 1.6;
        /// <summary>Cap on the commanded acceleration, either direction, x g.</summary>
        public const double MaxAccelG = 0.5;
        /// <summary>Braking envelope the setpoint schedule never exceeds, m/s^2.</summary>
        public const double ScheduleStopAccelMs2 = 2.0;

        /// <summary>Hull-bottom AGL from the position's AGL and the signed keel depth.</summary>
        public static double HullBottomAglM(double positionAglM, double keelDepthM)
        {
            var agl = IsFinite(positionAglM) ? positionAglM : 0.0;
            var keel = IsFinite(keelDepthM) ? keelDepthM : 0.0;
            return agl - keel;
        }

        private static bool IsFinite(double v)
        {
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        /// <summary>Angular rate in deg/s from a rad/s vector length.</summary>
        public static double SpinDegS(double angularRateRadS)
        {
            if (!IsFinite(angularRateRadS)) return 0.0;
            return Math.Abs(angularRateRadS) * 180.0 / Math.PI;
        }

        /// <summary>
        /// Desired sink rate for a hull bottom at <paramref name="hullBottomAglM"/>,
        /// m/s and positive DOWN.
        ///
        ///   agl >= band          -> sinkMps            (the open descent)
        ///   agl <= band/2        -> finalSinkMps       (the final band)
        ///   in between           -> linear taper from sinkMps to finalSinkMps
        ///
        /// The taper exists because the step is real: at 15 m a jump from 5 m/s
        /// to 0.4 m/s is a 4.6 m/s error in one tick, and the hull answers with a
        /// full-thrust burn 15 m above the ground (measured 2026-11-10 the
        /// dampener version slammed the ship back up ~1 km).
        ///
        /// A physical braking envelope caps the result so the hull can always
        /// still stop by the ground:
        ///   v <= sqrt(2 * a * (agl - 1 m)) + finalSinkMps
        /// This is what catches a handover that arrives faster than the schedule.
        /// </summary>
        public static double SinkSetpoint(
            double hullBottomAglM, double sinkMps, double finalSinkMps, double finalBandM, double stopAccelMs2)
        {
            if (!IsFinite(hullBottomAglM) || hullBottomAglM <= 0) return 0.0;
            var sink = Math.Max(0.0, IsFinite(sinkMps) ? sinkMps : 0.0);
            var final = Math.Max(0.0, IsFinite(finalSinkMps) ? finalSinkMps : 0.0);
            if (final > sink) final = sink;
            var band = Math.Max(0.5, IsFinite(finalBandM) ? finalBandM : 0.5);

            double schedule;
            if (hullBottomAglM >= band) schedule = sink;
            else if (hullBottomAglM <= band * 0.5) schedule = final;
            else
            {
                var t = (hullBottomAglM - band * 0.5) / (band * 0.5);
                schedule = final + (sink - final) * t;
            }

            var accel = Math.Max(0.05, IsFinite(stopAccelMs2) ? stopAccelMs2 : ScheduleStopAccelMs2);
            var envelope = Math.Sqrt(2.0 * accel * Math.Max(0.0, hullBottomAglM - 1.0)) + final;
            return Math.Max(0.0, Math.Min(schedule, envelope));
        }

        /// <summary>
        /// Vertical acceleration command for a sink-rate setpoint, m/s^2 and
        /// positive UP:
        ///
        ///   a = k * (v_up_desired - v_up) = k * (-sinkDown - vUp)
        ///
        /// so the thrust the caller asks for is `m*(g + a)` — weight plus the
        /// acceleration needed to reach the schedule. Clamped to what the lift
        /// bank has, never more.
        /// </summary>
        public static double SinkAccel(
            double sinkDownMps, double verticalSpeedUpMps, double gain, double maxUpAccel, double maxDownAccel)
        {
            var sink = Math.Max(0.0, IsFinite(sinkDownMps) ? sinkDownMps : 0.0);
            var vUp = IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0;
            var k = IsFinite(gain) && gain > 0 ? gain : VelocityGain;
            var a = k * (-sink - vUp);
            return LevelMath.Clamp(a, -Math.Abs(maxDownAccel), Math.Abs(maxUpAccel));
        }

        /// <summary>
        /// Vertical acceleration command for the SAFE-HOVER hold, m/s^2 and
        /// positive UP: drive the vertical speed to zero, never below the small
        /// downward authority a hold is allowed.
        ///
        ///   a = -k * v_up,  clamped to [-SafeHoverDownAccelG*g, +SafeHoverUpAccelG*g]
        ///
        /// At rest this is exactly 0, so the lift thrust it produces is exactly
        /// the hull's weight — the plain "hover = weight / lift capacity" the
        /// abort is specified as. A hull that arrives at the abort sinking gets
        /// a real braking command instead, which is what turns "an abort" into
        /// a recovery rather than a slower fall.
        /// </summary>
        public static double HoverAccel(double verticalSpeedUpMps, double gravityMs2, double gain, double maxUpAccelG = SafeHoverUpAccelG)
        {
            var vUp = IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0;
            var g = Math.Max(0.0, IsFinite(gravityMs2) ? gravityMs2 : 0.0);
            var k = IsFinite(gain) && gain > 0 ? gain : SafeHoverGain;
            // A hull that arrives at the abort FAST gets the full brake
            // authority: a 0.5 g arrest from a 100 m/s fall would need a
            // kilometre it does not have. A calm arrival keeps the 0.5 g hold.
            var up = IsFinite(maxUpAccelG) && maxUpAccelG > 0 ? maxUpAccelG : SafeHoverUpAccelG;
            return LevelMath.Clamp(-k * vUp, -SafeHoverDownAccelG * g, up * g);
        }

        /// <summary>Hover thrust as a fraction of the lift bank's capacity, 0..1.</summary>
        public static double HoverFraction(double massKg, double gravityMs2, double liftCapacityN)
        {
            if (!(liftCapacityN > 1.0) || !(massKg > 0)) return 0.0;
            var g = Math.Max(0.0, IsFinite(gravityMs2) ? gravityMs2 : 0.0);
            return LevelMath.Clamp(massKg * g / liftCapacityN, 0.0, 1.0);
        }

        /// <summary>
        /// Usable upward acceleration authority: the lift bank's excess over
        /// weight, capped at <paramref name="maxAccelG"/> x g and floored at
        /// 0.05 so a barely-lifting hull can still be commanded something.
        /// </summary>
        public static double MaxUpAccelMs2(
            double liftCapacityN, double massKg, double gravityMs2, double maxAccelG)
        {
            if (!(massKg > 0) || !(gravityMs2 > 0)) return 0.0;
            var excess = liftCapacityN / massKg - gravityMs2;
            return Math.Max(0.05, Math.Min(maxAccelG * gravityMs2, 0.9 * excess));
        }

        /// <summary>Thrust the lift bank must produce for an acceleration command, N.</summary>
        public static double LiftThrustN(
            double massKg, double gravityMs2, double accelUpMs2, double liftCapacityN)
        {
            if (!(massKg > 0)) return 0.0;
            var g = Math.Max(0.0, IsFinite(gravityMs2) ? gravityMs2 : 0.0);
            var a = IsFinite(accelUpMs2) ? accelUpMs2 : 0.0;
            // Thrust cannot be negative (a bank can only push) and cannot exceed
            // the bank's capacity.
            return LevelMath.Clamp(massKg * (g + a), 0.0, Math.Max(0.0, liftCapacityN));
        }

        /// <summary>Override fraction 0..1 the lift bank is driven at.</summary>
        public static double ThrustFraction(
            double massKg, double gravityMs2, double accelUpMs2, double liftCapacityN)
        {
            if (!(liftCapacityN > 1.0)) return 0.0;
            return LevelMath.Clamp(
                LiftThrustN(massKg, gravityMs2, accelUpMs2, liftCapacityN) / liftCapacityN, 0.0, 1.0);
        }

        /// <summary>The strict touchdown rule: hull bottom under 2 m, |v| within 0.5 m/s.</summary>
        public static bool IsTouchdown(double hullBottomAglM, double verticalSpeedUpMps)
        {
            if (!IsFinite(hullBottomAglM)) return false;
            var v = IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0;
            return hullBottomAglM <= TouchdownAglM && Math.Abs(v) <= TouchdownMps;
        }

        // --- stall touchdown (2026-11-11 flight proof, second landing) --------
        //
        // A ground datum a metre or two HIGH leaves the hull resting on terrain
        // with the measured AGL never reaching the 2 m gate: it sat at 2.96 m,
        // -0.07 m/s, and crawled in the final band for ~41 s until the job
        // timed out. The hull is down — the datum is wrong. So a hull that is
        // inside the FINAL BAND, has a descent still commanded, and has not
        // moved for two seconds is on the ground too, whichever number the
        // radius says.
        //
        // The band is capped explicitly: a hull HOVERING at 20 m, or one held
        // by the safe-hover abort, is motionless and commanded nothing down,
        // and must never be declared landed. Both gates (band, stillness) plus
        // the caller's phase check are what keep a hover out of this rule.

        /// <summary>Highest AGL the stall rule may fire at, m (the final band is usually 15).</summary>
        public const double StallMaxAglM = 6.0;
        /// <summary>Speed under which the hull counts as not moving at all, m/s.</summary>
        public const double StallSpeedMps = 0.2;
        /// <summary>Position drift allowed inside the still window, m.</summary>
        public const double StallMoveM = 0.3;
        /// <summary>How long the hull must be still before the stall rule may fire, s.</summary>
        public const double StallHoldSec = 2.0;

        /// <summary>
        /// Is the hull still enough for the stall rule? Speed at or under
        /// <see cref="StallSpeedMps"/> and no more than <see cref="StallMoveM"/>
        /// of drift since the window began. NaN-safe: a bad sample is not still.
        /// </summary>
        public static bool StallStill(double speedMps, double movedM)
        {
            if (!IsFinite(speedMps) || !IsFinite(movedM)) return false;
            return Math.Abs(speedMps) <= StallSpeedMps && movedM <= StallMoveM;
        }

        /// <summary>
        /// The stall touchdown rule: hull bottom inside the final band (capped
        /// at <see cref="StallMaxAglM"/>), the hull still
        /// (<see cref="StallStill"/>) and still for at least
        /// <see cref="StallHoldSec"/>. The caller decides that a descent was
        /// COMMANDED and that the job is in its descend phase; this function
        /// only judges the geometry and the stillness.
        /// </summary>
        public static bool IsStallTouchdown(
            double hullBottomAglM, double finalBandM, double speedMps, double movedM, double stillSec)
        {
            if (!IsFinite(hullBottomAglM)) return false;
            var band = IsFinite(finalBandM) && finalBandM > 0 ? finalBandM : StallMaxAglM;
            if (band > StallMaxAglM) band = StallMaxAglM;
            if (hullBottomAglM > band) return false;
            if (!StallStill(speedMps, movedM)) return false;
            return IsFinite(stillSec) && stillSec >= StallHoldSec;
        }

        /// <summary>
        /// A `land_ground` update that moves the datum PAST the remaining AGL
        /// puts the hull at the contact gate without another metre of flight:
        /// the new AGL is the measurement, the old datum was the sample. The
        /// caller only asks this in a commanded descent.
        /// </summary>
        public static bool IsDatumTouchdown(double newHullBottomAglM)
        {
            return IsFinite(newHullBottomAglM) && newHullBottomAglM <= TouchdownAglM;
        }

        /// <summary>
        /// Contact: the hull is at the ground, vertical speed has gone to zero
        /// but the lift bank is still being asked for LESS than the hull's
        /// weight — i.e. terrain is carrying the ship, not thrust. A hull
        /// hovering on its own thrust never satisfies this.
        /// </summary>
        public static bool IsContact(
            double hullBottomAglM, double verticalSpeedUpMps, double liftThrustN, double massKg, double gravityMs2)
        {
            if (!IsFinite(hullBottomAglM) || hullBottomAglM > ContactMaxAglM) return false;
            if (Math.Abs(IsFinite(verticalSpeedUpMps) ? verticalSpeedUpMps : 0.0) > ContactMps) return false;
            if (!(massKg > 0) || !(gravityMs2 > 0)) return false;
            return liftThrustN < ContactThrustRatio * massKg * gravityMs2;
        }

        /// <summary>
        /// The settle gate: an angular rate this low is "not spinning" and the
        /// descent may start.
        /// </summary>
        public static bool Settled(double angularRateDegS)
        {
            return IsFinite(angularRateDegS) && Math.Abs(angularRateDegS) <= SettleRateDegS;
        }

        /// <summary>
        /// The abort-release gate: the overrides are only handed back when the
        /// hull is calm (or already on the ground — the caller checks that).
        /// </summary>
        public static bool SafeToRelease(double speedMps, double tiltDeg)
        {
            if (!IsFinite(speedMps) || !IsFinite(tiltDeg)) return false;
            return Math.Abs(speedMps) <= SafeHoverSpeedMps && Math.Abs(tiltDeg) < SafeHoverTiltDeg;
        }

        /// <summary>
        /// The gyro sign test: a commanded rotation about `axis` must produce an
        /// angular velocity ALONG that axis on a correctly signed hull. The
        /// measured dot product (rad/s) decides: +1, -1, or 0 for "no evidence".
        /// </summary>
        public static int SignFromRate(double measuredDotRadS, double minRateRadS)
        {
            if (!IsFinite(measuredDotRadS)) return 0;
            var min = minRateRadS > 0 ? minRateRadS : 0.0;
            if (Math.Abs(measuredDotRadS) < min) return 0;
            return measuredDotRadS > 0 ? 1 : -1;
        }

        /// <summary>
        /// The sign test measured as a CHANGE of the rate component, not as an
        /// absolute rate:
        ///   delta = (w_after - w_before) . axis
        ///
        /// WHY. A hull that arrives spinning (30 deg/s was measured) has a large
        /// component along any test axis that has nothing to do with the gyro.
        /// The old test averaged the absolute rate while commanding, so on such
        /// a hull it would have read the RESIDUAL SPIN as the response and
        /// picked its sign. The delta is what the command did, and nothing else.
        /// </summary>
        public static int SignFromDelta(double beforeDotRadS, double afterDotRadS, double minRateRadS)
        {
            if (!IsFinite(beforeDotRadS) || !IsFinite(afterDotRadS)) return 0;
            return SignFromRate(afterDotRadS - beforeDotRadS, minRateRadS);
        }

        /// <summary>
        /// Largest change of the gyro command allowed in one tick for a
        /// commanded angular-acceleration cap, in command units (0-1):
        ///
        ///   step = maxAccelDegS2 * tickSec / ratePerCommandDegS
        ///
        /// The gyro override is a rate DEMAND, so limiting how fast that demand
        /// may move is limiting the commanded angular acceleration. A step this
        /// small means a wrong-sign tick cannot build a rate faster than the cap,
        /// which is what turns "the correction pushed the wrong way" from a
        /// 7.5 deg/0.11 s event into a 0.2 deg/s-per-tick nuisance the flip rule
        /// catches.
        /// </summary>
        public static double MaxCommandDeltaPerTick(
            double maxAngularAccelDegS2, double tickSec, double ratePerCommandDegS)
        {
            if (!IsFinite(maxAngularAccelDegS2) || maxAngularAccelDegS2 <= 0) return 0.0;
            var dt = IsFinite(tickSec) && tickSec > 0 ? tickSec : 0.1;
            var rate = IsFinite(ratePerCommandDegS) && ratePerCommandDegS > 0.1
                ? ratePerCommandDegS
                : NominalRatePerCommandDegS;
            return maxAngularAccelDegS2 * dt / rate;
        }

        /// <summary>
        /// The hull's measured command scale, deg/s of achieved rate per unit of
        /// gyro override, from the sign test's own response. Clamped to 1/4..4x
        /// the nominal so one noisy measurement cannot disarm the acceleration
        /// cap: a response that looks 100x stronger than nominal would otherwise
        /// allow a 100x larger command step.
        /// </summary>
        public static double RatePerCommandDegS(double measuredDeltaDegS, double commandMagnitude)
        {
            if (!IsFinite(measuredDeltaDegS) || !IsFinite(commandMagnitude) || commandMagnitude <= 0)
                return NominalRatePerCommandDegS;
            var rate = Math.Abs(measuredDeltaDegS) / commandMagnitude;
            return LevelMath.Clamp(
                rate, NominalRatePerCommandDegS * 0.25, NominalRatePerCommandDegS * 4.0);
        }

        /// <summary>
        /// Attitude-gain scale for a hull whose gyro sign is not (yet) trusted:
        /// 10 % of the normal correction, or the full one once the sign test has
        /// proved the sign and the settle-in window has passed.
        /// </summary>
        public static double AttitudeGainScale(bool signTrusted)
        {
            return signTrusted ? 1.0 : UnprovenSignGainScale;
        }

        /// <summary>
        /// The sign-learning rule, in one place so the land and level loops
        /// cannot drift apart: tilt GROWING by <see cref="SignFlipGrowthDeg"/>
        /// inside one second while a correction is commanded proves the gyro is
        /// pushing the wrong way.
        /// </summary>
        public static bool SignFlipDue(
            double tiltDeg, double tiltAtWindowStartDeg, double windowSec, double rotMagnitude)
        {
            if (!IsFinite(tiltDeg) || !IsFinite(tiltAtWindowStartDeg) || !IsFinite(windowSec)) return false;
            if (!(rotMagnitude > 0.02)) return false;
            if (windowSec < 0 || windowSec > SignFlipWindowSec) return false;
            return tiltDeg - tiltAtWindowStartDeg >= SignFlipGrowthDeg;
        }

        // --- horizontal position hold during brake/descend (2026-11-11 set 3)
        //
        // WHY. `land_at` flew attitude only: the fall and brake held the hull
        // level and damped its rates, so any residual horizontal velocity
        // integrated for the whole descent. Measured drift from the ordered
        // column: 176.4 m on the 745 m drop, 51.5 m on the short one (set 2:
        // 196 m). The fix is a PD on the two TANGENTIAL axes toward the column
        // the order's ground datum was sampled at, expressed as a tilt request
        // that is ADDED to the levelling demand and never replaces it.
        //
        // The law is scalar per axis and the caller resolves the two axes, so
        // this file stays free of the game's vector types and stays unit-tested
        // offline. Sign convention of the scalar law: `offsetM` is measured from
        // the hull TOWARD the target along the chosen horizontal direction and
        // `velMps` is the hull's velocity along that same direction, so a hull
        // closing on the column gets a smaller request than a hull drifting
        // away from it (that is the D term).
        /// <summary>Position gain of the hold, deg of tilt per metre of offset.</summary>
        public const double LateralTiltPerM = 0.15;
        /// <summary>Rate (damping) gain of the hold, deg of tilt per m/s of closing rate.</summary>
        public const double LateralTiltPerMps = 0.6;
        /// <summary>Lateral tilt cap in brake and in the descent above 15 m AGL, deg.</summary>
        public const double LateralCapMaxDeg = 5.0;
        /// <summary>Lateral tilt cap at or below 15 m hull-bottom AGL, deg.</summary>
        public const double LateralCapNearGroundDeg = 2.0;
        /// <summary>AGL at which the cap narrows to <see cref="LateralCapNearGroundDeg"/>, m.</summary>
        public const double LateralNearGroundAglM = 15.0;
        /// <summary>AGL at or below which the lateral term is zero (hull must be level), m.</summary>
        public const double LateralZeroAglM = 6.0;
        /// <summary>Time spent inside the zero band after which the term is zero regardless, s.</summary>
        public const double LateralFinalSec = 2.0;
        /// <summary>
        /// Total attitude budget the hold may live inside, deg: 5 lateral + 2
        /// levelling allowance, 28 deg of margin under the untouched 35 deg
        /// <see cref="MaxTiltDeg"/>. Levelling always wins the argument.
        /// </summary>
        public const double LateralBudgetDeg = 7.0;
        /// <summary>
        /// Lift ratio (up thrust / weight) below which the hold is refused: a
        /// hull that cannot spare 20 % of its weight as a lateral vector has no
        /// bank to spend on position.
        /// </summary>
        public const double LateralMinLiftRatio = 1.2;
        /// <summary>
        /// Tilt gain of `LevelFlightController.AttitudeRotation`
        /// (`cross(hullUp, desiredUp) * 2.2`), override units per radian of
        /// tilt error. One place so the hold's tilt request converts to the
        /// same units the levelling demand uses.
        /// </summary>
        public const double AttitudeTiltGain = 2.2;

        /// <summary>
        /// Largest horizontal offset from the HANDOVER column to an ORDERED
        /// landing target that the hold will fly, m (2026-11-11 flight set 5).
        /// The backend now flies a lateral leg above the requested column before
        /// it hands over, so the target is normally metres away. An ORDERED
        /// target that is still beyond this cap (a lateral leg that timed out,
        /// or an older backend) is refused and the hold keeps the handover
        /// column: chasing 182 m with 5 deg of bank is not a landing, it is a
        /// long tilt into terrain with no authority to stop.
        /// </summary>
        public const double LateralTargetMaxM = 30.0;

        /// <summary>
        /// Is an ORDERED target inside <see cref="LateralTargetMaxM"/> of the
        /// handover column? Unreadable (NaN) offset is never accepted.
        /// </summary>
        public static bool TargetAcceptable(double horizontalOffsetM)
        {
            if (!IsFinite(horizontalOffsetM)) return false;
            return horizontalOffsetM <= LateralTargetMaxM;
        }

        /// <summary>
        /// Why an ordered target was refused for the hold, or null when it is
        /// used. The text reaches `land_status`, so it carries both numbers.
        /// </summary>
        public static string TargetRefusal(double horizontalOffsetM)
        {
            if (TargetAcceptable(horizontalOffsetM)) return null;
            var got = IsFinite(horizontalOffsetM) ? Math.Round(horizontalOffsetM, 1).ToString() : "unreadable";
            return "target too far for hold (" + got + " m > " + LateralTargetMaxM +
                   " m): holding the handover column";
        }

        /// <summary>
        /// Length of the part of an offset vector that lies in the local
        /// HORIZONTAL plane (perpendicular to <paramref name="up"/>), m. The
        /// hold must never spend tilt on the vertical axis: a descent that
        /// chases altitude with a bank fights its own sink schedule.
        /// </summary>
        public static double TangentialOffsetM(
            double ex, double ey, double ez, double ux, double uy, double uz)
        {
            if (!IsFinite(ex) || !IsFinite(ey) || !IsFinite(ez)) return 0.0;
            var ul = Math.Sqrt(ux * ux + uy * uy + uz * uz);
            if (!(ul > 1e-6)) return Math.Sqrt(ex * ex + ey * ey + ez * ez);
            var along = (ex * ux + ey * uy + ez * uz) / ul;
            var tx = ex - ux / ul * along;
            var ty = ey - uy / ul * along;
            var tz = ez - uz / ul * along;
            return Math.Sqrt(tx * tx + ty * ty + tz * tz);
        }

        /// <summary>
        /// Lateral tilt cap for the current AGL, deg. 5 deg in the brake and the
        /// upper descent, 2 deg below <see cref="LateralNearGroundAglM"/>, 0 at
        /// or below <see cref="LateralZeroAglM"/> and after
        /// <see cref="LateralFinalSec"/> seconds inside that band. NaN AGL is 0:
        /// an unreadable altitude never commands a bank.
        /// </summary>
        public static double LateralCapDeg(double hullBottomAglM, double finalBandM, double secInFinalBand)
        {
            if (!IsFinite(hullBottomAglM)) return 0.0;
            var zeroAgl = IsFinite(finalBandM) && finalBandM > 0
                ? Math.Min(finalBandM, LateralZeroAglM)
                : LateralZeroAglM;
            if (hullBottomAglM <= zeroAgl) return 0.0;
            if (IsFinite(secInFinalBand) && secInFinalBand >= LateralFinalSec) return 0.0;
            if (hullBottomAglM <= LateralNearGroundAglM) return LateralCapNearGroundDeg;
            return LateralCapMaxDeg;
        }

        /// <summary>
        /// The PD request along ONE horizontal axis, deg, signed toward the
        /// target, clamped to +/- <paramref name="capDeg"/>. Clamping the scalar
        /// (not each term) is what keeps a 1000 m offset from asking for 150 deg
        /// of bank. Zero on any non-finite input or a non-positive cap.
        /// </summary>
        public static double LateralTiltDeg(double offsetM, double velMps, double capDeg)
        {
            if (!IsFinite(offsetM) || !IsFinite(velMps) || !IsFinite(capDeg) || capDeg <= 0) return 0.0;
            var demand = LateralTiltPerM * offsetM - LateralTiltPerMps * velMps;
            return LevelMath.Clamp(demand, -capDeg, capDeg);
        }

        /// <summary>
        /// Clamp a two-axis tilt request to a vector magnitude, deg. Per-axis
        /// clamping alone would allow sqrt(2) x the cap on the diagonal.
        /// </summary>
        public static void ClampLateralDeg(ref double xDeg, ref double yDeg, double capDeg)
        {
            if (!IsFinite(xDeg)) xDeg = 0.0;
            if (!IsFinite(yDeg)) yDeg = 0.0;
            if (!IsFinite(capDeg) || capDeg <= 0) { xDeg = 0.0; yDeg = 0.0; return; }
            var mag = Math.Sqrt(xDeg * xDeg + yDeg * yDeg);
            if (mag <= capDeg || mag <= 0.0) return;
            var s = capDeg / mag;
            xDeg *= s;
            yDeg *= s;
        }

        /// <summary>
        /// Budget left for the lateral term after the LEVELLING demand, deg.
        /// Levelling keeps priority: if the attitude loop is already asking for
        /// more than <see cref="LateralBudgetDeg"/> on its own, the lateral term
        /// is 0 for that tick - never the other way round.
        /// </summary>
        public static double LateralBudget(double levellingTiltDeg, double capDeg)
        {
            if (!IsFinite(capDeg) || capDeg <= 0) return 0.0;
            var used = IsFinite(levellingTiltDeg) ? Math.Max(0.0, levellingTiltDeg) : LateralBudgetDeg;
            var room = LateralBudgetDeg - used;
            return LevelMath.Clamp(room, 0.0, capDeg);
        }

        /// <summary>
        /// Tilt request, deg, to a gyro override demand in the units
        /// `AttitudeRotation` returns: `tiltDeg * pi/180 * 2.2`. A 5 deg request
        /// is 0.192 of override, well inside the 0.9 total cap.
        /// </summary>
        public static double TiltToRotationOverride(double tiltDeg)
        {
            if (!IsFinite(tiltDeg)) return 0.0;
            return tiltDeg * Math.PI / 180.0 * AttitudeTiltGain;
        }

        /// <summary>
        /// The lift axis is PROVEN when the hull's own banks deliver thrust
        /// along the commanded up axis at all: `UpThrust` only counts banks the
        /// direction probe placed on that axis, and a hull whose convention was
        /// read backwards reports 0 N there (measured 2026-11-10 on SAT-R-0001:
        /// every lift bank reported the exhaust direction). Zero lift is not
        /// evidence of anything, so it is not a proof.
        /// </summary>
        public static bool LiftAxisProven(double upThrustN, double weightN)
        {
            return IsFinite(upThrustN) && IsFinite(weightN) && upThrustN > 0.0 && weightN > 0.0;
        }

        /// <summary>
        /// Why the horizontal hold is OFF this tick, or null when it may fly.
        /// Order matters: phase, then the two SIGN proofs (a guessed axis is a
        /// crash, not a drift), then authority, then the touchdown band.
        /// </summary>
        public static string LateralRefusal(
            string phase, bool gyroSignProven, bool liftAxisProven,
            double liftRatio, double capDeg, double spinDegS)
        {
            if (!LateralHoldPhase(phase)) return "refused: phase is not brake or descending";
            if (!gyroSignProven) return "refused: gyro sign unproven";
            if (!liftAxisProven) return "refused: lift-axis sign unproven";
            if (IsFinite(spinDegS) && Math.Abs(spinDegS) > DescentSpinAbortDegS)
                return "refused: spinning at " + Math.Round(spinDegS, 1) + " deg/s";
            if (!IsFinite(liftRatio) || liftRatio < LateralMinLiftRatio)
                return "refused: lift ratio " + (IsFinite(liftRatio) ? Math.Round(liftRatio, 2) : 0.0) +
                       " < " + LateralMinLiftRatio;
            if (!IsFinite(capDeg) || capDeg <= 0.0) return "refused: inside the final band (level for touchdown)";
            return null;
        }

        /// <summary>
        /// Should this tick's lateral-hold reason be PRINTED in `land_status`?
        ///
        /// The reason is a standing condition: "refused: gyro sign unproven"
        /// holds for the whole descent when the sign test measured no response,
        /// and logging it once a second (verify #4) reads like an active fault
        /// while the hull is descending correctly. Print a non-null reason when
        /// it differs from the last one printed (including the first time), and
        /// print nothing while it repeats. The value itself always stays in the
        /// `land_status` JSON (`lateralHold`), so nothing is hidden.
        /// </summary>
        public static bool ShouldLogLateralHold(string current, string previous)
        {
            if (current == null) return false;
            return !string.Equals(current, previous, StringComparison.Ordinal);
        }

        /// <summary>
        /// Refusal policy for a `land_at` start. Same shape as
        /// `LevelMath.StartRefusal`, with the landing thresholds, so the refusal
        /// text is testable without the game.
        ///
        /// The two new checks are the ones the first in-game attempt needed:
        /// a start 49 m BELOW the ground datum was accepted and called
        /// "touchdown", and a hull already sitting on the ground was flown.
        /// </summary>
        public static string StartRefusal(
            bool isStatic, bool hasPhysics, bool hasPlanet, double gravityMs2,
            double tiltDeg, double upThrustN, double massKg, bool underPlayerControl,
            double hullBottomAglM, double spinDegS)
        {
            if (underPlayerControl) return "manual control: a player is piloting this grid";
            if (isStatic) return "grid is static (station mode): convert_to_ship first";
            if (!hasPhysics) return "grid has no physics body";
            if (!hasPlanet) return "no planet under the hull: no ground datum to land on";
            if (gravityMs2 < LevelMath.MinGravityMs2) return "no gravity: nothing to land against";
            if (!(massKg > 0)) return "mass unreadable";
            if (!IsFinite(hullBottomAglM))
                return "hull-bottom altitude unreadable: the ground datum cannot be applied to this grid";
            if (hullBottomAglM < 0)
                return "hull bottom is " + Math.Round(-hullBottomAglM, 1) +
                       " m BELOW the ground datum at this column: the datum disagrees with reality, " +
                       "so refusing to fly a descent onto it";
            if (hullBottomAglM < MinStartHullBottomAglM)
                return "hull is already on the ground (" + Math.Round(hullBottomAglM, 2) +
                       " m hull-bottom AGL): nothing to land";
            var spin = Math.Abs(IsFinite(spinDegS) ? spinDegS : 0.0);
            if (spin > SpinRefuseDegS)
                return "spinning at " + Math.Round(spin, 1) + " deg/s (over " + SpinRefuseDegS +
                       " deg/s): settle the hull before landing";
            if (tiltDeg > MaxTiltDeg)
                return "tilt " + Math.Round(tiltDeg, 1) + " deg exceeds " + MaxTiltDeg + " deg before start";
            if (upThrustN < MinLiftRatio * massKg * gravityMs2)
                return "lift thrust " + Math.Round(upThrustN / 1000) + " kN < 1.05 x weight " +
                       Math.Round(massKg * gravityMs2 / 1000) + " kN";
            return null;
        }
    }
}
