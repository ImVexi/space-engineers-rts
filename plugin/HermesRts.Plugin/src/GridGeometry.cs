using System;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Hull geometry for ground work, measured on the game thread.
    ///
    /// The grid's reported position is its PIVOT, which is not its geometric
    /// centre and not its belly: measured on SAT-R-0001 (a 24-block large grid,
    /// 17.5 x 5 x 10 m) the pivot sits ~10 m BELOW the lowest block, so the
    /// hull touches terrain while the position still reads +10 m above it. Every
    /// ground computation (touchdown, flare, brake, 100 m clearance) has to be
    /// done against the hull's lowest point, not the pivot, or a landing can
    /// never reach the ground.
    ///
    /// `keelDepthM` is therefore the SIGNED distance from the pivot to the
    /// lowest point of the grid's local AABB along local down (= opposite the
    /// local gravity vector):
    ///   positive -> the hull extends below the pivot (the usual case);
    ///   negative -> the pivot sits below the hull (SAT-R-0001: the belly is
    ///               8.75 m above the pivot, so keel = -8.75).
    ///
    /// MEASURED BUG, FIXED 2026-11-10: this function used to keep the corner
    /// with the SMALLEST "below the pivot" value — the hull's TOP. SAT-R-0001
    /// therefore reported -18.75 (its roof) while resting, so every ground rule
    /// downstream (hold radius, flare, handover, touchdown) believed the hull
    /// was 10 m higher than it was. The in-game check is unambiguous: AABB local
    /// Y 8.75..18.75 with a level hull means the belly is 8.75 m ABOVE the pivot.
    /// </summary>
    public static class GridGeometry
    {
        /// <summary>Local up for ground work: opposite gravity, else the grid's own up.</summary>
        public static Vector3D UpFor(IMyCubeGrid grid)
        {
            Vector3D gravity = Vector3D.Zero;
            var phys = grid.Physics;
            if (phys != null) gravity = phys.Gravity;
            if (gravity.LengthSquared() > 1e-6) return Vector3D.Normalize(-gravity);
            var matrix = grid.PositionComp != null ? grid.PositionComp.WorldMatrixRef : MatrixD.Identity;
            return Vector3D.Normalize(matrix.Up);
        }

        /// <summary>
        /// Signed pivot -> lowest-point distance along local down, metres, plus
        /// the world position of that lowest point. Reads the block AABB, so it
        /// follows the hull's attitude (a tilted hull dips more).
        /// </summary>
        public static double KeelDepthM(IMyCubeGrid grid, out Vector3D up, out Vector3D hullBottomWorld)
        {
            up = UpFor(grid);
            hullBottomWorld = grid.PositionComp != null ? grid.PositionComp.GetPosition() : Vector3D.Zero;
            if (grid.PositionComp == null) return 0.0;
            var pos = grid.PositionComp.GetPosition();
            var matrix = grid.PositionComp.WorldMatrixRef;
            var box = grid.PositionComp.LocalAABB;

            // A grid whose AABB is degenerate (no blocks read yet) reports 0
            // rather than a nonsense keel.
            if (!(box.Max.X > box.Min.X) && !(box.Max.Y > box.Min.Y) && !(box.Max.Z > box.Min.Z)) return 0.0;

            double lowest = double.MinValue;
            for (int i = 0; i < 8; i++)
            {
                var local = new Vector3(
                    (i & 1) == 0 ? box.Min.X : box.Max.X,
                    (i & 2) == 0 ? box.Min.Y : box.Max.Y,
                    (i & 4) == 0 ? box.Min.Z : box.Max.Z);
                var world = Vector3D.Transform(local, matrix);
                var below = -Vector3D.Dot(world - pos, up); // metres below the pivot
                // The LOWEST point is the corner furthest below the pivot, i.e.
                // the LARGEST `below`. Measured in game 2026-11-10: this kept the
                // smallest value instead, so SAT-R-0001 (AABB local Y 8.75..18.75,
                // hull entirely above the pivot) reported -18.75 — the ROOF, and
                // `hullBottomWorld` was the roof corner 18.7 m up — while its
                // actual belly is 8.75 m above the pivot. Every ground rule then
                // believed the hull was 10 m higher than it was.
                if (below > lowest)
                {
                    lowest = below;
                    hullBottomWorld = world;
                }
            }
            return lowest == double.MinValue ? 0.0 : lowest;
        }

        /// <summary>Signed pivot -> lowest-point distance along local down, metres.</summary>
        public static double KeelDepthM(IMyCubeGrid grid)
        {
            Vector3D up, bottom;
            return KeelDepthM(grid, out up, out bottom);
        }

        /// <summary>Local AABB in metres (grid frame) as {min,max}, for the audit.</summary>
        public static void LocalAabbM(IMyCubeGrid grid, out Vector3D min, out Vector3D max)
        {
            min = Vector3D.Zero;
            max = Vector3D.Zero;
            if (grid.PositionComp == null) return;
            var box = grid.PositionComp.LocalAABB;
            min = new Vector3D(box.Min.X, box.Min.Y, box.Min.Z);
            max = new Vector3D(box.Max.X, box.Max.Y, box.Max.Z);
        }
    }
}
