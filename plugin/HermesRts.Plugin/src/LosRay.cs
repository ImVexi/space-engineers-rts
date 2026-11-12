using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.Game.Entities;
using Sandbox.ModAPI;
using VRage.Game.Components;
using VRage.Game.Models;
using VRage.Game.ModAPI;
using VRage.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// A real line-of-sight / ground raycast that covers both collision bodies
    /// and voxel volumes.
    ///
    /// Why this exists: `MyAPIGateway.Physics.CastRay` only reports collision
    /// bodies (grids, characters, items) on 01_210_014 — it returned `hit:false`
    /// in a straight-down ray over bare planet voxels on the test server
    /// (measured 2026-11-10). Terrain and asteroid rock live in voxel maps, so
    /// they are intersected separately with `MyVoxelBase.GetIntersectionWithLine`
    /// and the nearer of the two hits wins. Every caller gets an honest
    /// `source` field ("voxel" vs "physics") telling it which detector fired.
    /// </summary>
    public static class LosRay
    {
        public sealed class Hit
        {
            public double Distance;
            public Vector3D Position;
            public Vector3D Normal;
            public string EntityId;
            public string Kind;      // grid | planet | asteroid | character | entity
            public string Name;
            public double Fraction;
            public string Source;    // voxel | physics
        }

        public sealed class Result
        {
            public bool Clear;
            public double DistanceM;
            public double RayLengthM;
            public Hit First;
            public int VoxelBasesTested;
            public int PhysicsBodiesIgnored;
            public string Note;
        }

        /// <summary>
        /// Cast <paramref name="from"/> to <paramref name="to"/> and return the
        /// nearest voxel or physics hit. <paramref name="ignoreEntityIds"/> lets a
        /// caller skip the grid it launches from.
        /// </summary>
        public static Result Cast(Vector3D from, Vector3D to, ICollection<long> ignoreEntityIds = null)
        {
            var result = new Result
            {
                RayLengthM = Math.Round((to - from).Length(), 3),
                Clear = true,
            };

            var direction = to - from;
            var length = direction.Length();
            if (length < 1e-3)
            {
                result.Note = "zero-length ray";
                return result;
            }
            direction /= length;

            // --- voxels (planet terrain, asteroid / voxel-map rock) -------------
            var line = new LineD(from, to);
            Hit bestVoxel = null;
            try
            {
                foreach (var entity in MyEntities.GetEntities())
                {
                    var voxel = entity as MyVoxelBase;
                    if (voxel == null || voxel.Closed) continue;
                    // A planet exposes child sector voxels; only the root owns the
                    // full map, and intersecting children double-counts.
                    if (voxel.RootVoxel != null && voxel.RootVoxel != voxel) continue;
                    result.VoxelBasesTested++;
                    try
                    {
                        Hit candidate = null;
                        var planet = voxel as MyPlanet;
                        if (planet != null && planet.Provider != null)
                        {
                            // Planets have no triangle-mesh geometry (storage
                            // geometry is null for procedural terrain), so
                            // MyVoxelBase.GetIntersectionWithLine always fails on
                            // them. The planet shape provider is the real path:
                            // it returns normalised offsets along the line.
                            var origin = planet.PositionComp.GetPosition();
                            var localLine = new LineD(from - origin, to - origin);
                            double t0, t1;
                            if (planet.Provider.IntersectExact(ref localLine, out t0, out t1))
                            {
                                var t = Math.Max(0.0, Math.Min(1.0, t0));
                                var point = from + (to - from) * t;
                                candidate = new Hit
                                {
                                    Distance = (point - from).Length(),
                                    Position = point,
                                    Normal = Vector3D.Normalize(point - origin),
                                    Kind = "planet",
                                    Name = SafeVoxelName(voxel),
                                    EntityId = voxel.EntityId.ToString(),
                                    Fraction = t,
                                    Source = "voxel",
                                };
                            }
                        }
                        else
                        {
                            MyIntersectionResultLineTriangleEx? hit;
                            if (voxel.GetIntersectionWithLine(ref line, out hit, IntersectionFlags.ALL_TRIANGLES) && hit != null)
                            {
                                var point = hit.Value.IntersectionPointInWorldSpace;
                                candidate = new Hit
                                {
                                    Distance = (point - from).Length(),
                                    Position = point,
                                    Normal = hit.Value.NormalInWorldSpace,
                                    Kind = "asteroid",
                                    Name = SafeVoxelName(voxel),
                                    EntityId = voxel.EntityId.ToString(),
                                    Fraction = length > 0 ? (point - from).Length() / length : 0,
                                    Source = "voxel",
                                };
                            }
                        }
                        if (candidate == null) continue;
                        if (bestVoxel != null && candidate.Distance >= bestVoxel.Distance) continue;
                        bestVoxel = candidate;
                    }
                    catch { /* one bad voxel must not lose the rest of the ray */ }
                }
            }
            catch (Exception ex)
            {
                result.Note = "voxel scan failed: " + ex.GetType().Name + ": " + ex.Message;
            }

            // --- physics bodies (grids, characters, loose entities) -------------
            Hit bestPhysics = null;
            try
            {
                // A ray that starts inside a body cannot report that body, so when
                // the caller says "ignore this grid" (the usual case: casting from
                // a ship's centre) step out of its bounding box first.
                var cursor = StepOutOfIgnored(from, direction, length, ignoreEntityIds);
                for (var attempt = 0; attempt < 6; attempt++)
                {
                    IHitInfo hit;
                    if (!MyAPIGateway.Physics.CastRay(cursor, to, out hit) || hit == null) break;
                    var hitEntity = hit.HitEntity;
                    long hitId = 0;
                    if (hitEntity != null)
                    {
                        try { hitId = hitEntity.EntityId; } catch { }
                    }
                    if (ignoreEntityIds != null && hitId != 0 && ignoreEntityIds.Contains(hitId))
                    {
                        result.PhysicsBodiesIgnored++;
                        var advance = hit.Position + direction * 0.5;
                        if ((advance - cursor).Length() < 1e-3) break;
                        cursor = advance;
                        continue;
                    }
                    bestPhysics = new Hit
                    {
                        Distance = (hit.Position - from).Length(),
                        Position = hit.Position,
                        Normal = hit.Normal,
                        EntityId = hitEntity != null ? "grid:" + hitId : null,
                        Kind = ClassifyEntity(hitEntity),
                        Name = SafeEntityName(hitEntity),
                        Fraction = hit.Fraction,
                        Source = "physics",
                    };
                    break;
                }
            }
            catch (Exception ex)
            {
                result.Note = Append(result.Note, "physics cast failed: " + ex.GetType().Name + ": " + ex.Message);
            }

            var best = bestVoxel;
            if (bestPhysics != null && (best == null || bestPhysics.Distance < best.Distance)) best = bestPhysics;

            result.First = best;
            result.Clear = best == null;
            result.DistanceM = best != null ? Math.Round(best.Distance, 3) : Math.Round(length, 3);
            return result;
        }

        private static string Append(string a, string b)
        {
            return string.IsNullOrEmpty(a) ? b : a + "; " + b;
        }

        /// <summary>
        /// Advance the ray start out of every ignored entity's bounding box.
        /// CastRay reports nothing when the origin is inside a shape, so a probe
        /// launched from a ship's centre would otherwise miss everything beyond
        /// that ship.
        /// </summary>
        private static Vector3D StepOutOfIgnored(Vector3D from, Vector3D direction, double length, ICollection<long> ignore)
        {
            if (ignore == null || ignore.Count == 0) return from;
            var boxes = new List<BoundingBoxD>();
            foreach (var id in ignore)
            {
                IMyEntity entity;
                if (!MyAPIGateway.Entities.TryGetEntityById(id, out entity) || entity == null) continue;
                try
                {
                    if (entity.PositionComp != null) boxes.Add(entity.PositionComp.WorldAABB);
                }
                catch { }
            }
            if (boxes.Count == 0) return from;

            var point = from;
            var limit = Math.Min(length * 0.8, 400.0);
            for (var step = 0; step < 400; step++)
            {
                var inside = false;
                foreach (var box in boxes)
                {
                    if (box.Contains(point) != ContainmentType.Disjoint) { inside = true; break; }
                }
                if (!inside) return point;
                point = point + direction;
                if ((point - from).Length() > limit) break;
            }
            return point;
        }

        private static string ClassifyEntity(object entity)
        {
            if (entity is IMyCubeGrid) return "grid";
            if (entity is IMyVoxelBase) return "voxel";
            if (entity is IMyCharacter) return "character";
            return "entity";
        }

        private static string SafeEntityName(object entity)
        {
            try
            {
                var e = entity as IMyEntity;
                if (e == null) return null;
                return e.DisplayName;
            }
            catch { return null; }
        }

        private static string SafeVoxelName(MyVoxelBase voxel)
        {
            try { return voxel.StorageName ?? voxel.DisplayName; }
            catch { return null; }
        }

        /// <summary>Raycast result as the JSON shape the probe actions return.</summary>
        public static JObject ToJson(Result r)
        {
            var json = new JObject
            {
                ["clear"] = r.Clear,
                ["distanceM"] = r.DistanceM,
                ["rayLengthM"] = r.RayLengthM,
                ["voxelBasesTested"] = r.VoxelBasesTested,
            };
            if (r.First != null)
            {
                json["hitPosition"] = Vec(r.First.Position);
                json["hitNormal"] = Vec(r.First.Normal);
                json["hitEntityId"] = r.First.EntityId;
                json["hitType"] = r.First.Kind;
                json["hitName"] = r.First.Name;
                json["hitBy"] = r.First.Source;
                json["fraction"] = Math.Round(r.First.Fraction, 5);
            }
            if (!string.IsNullOrEmpty(r.Note)) json["note"] = r.Note;
            return json;
        }

        private static JObject Vec(Vector3D v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }

        private static JObject Vec(Vector3 v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }
    }
}
