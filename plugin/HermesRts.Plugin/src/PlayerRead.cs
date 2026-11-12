using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.Game.Entities;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// T61: one online player, sampled from the live session. Every id is kept
    /// as a string here because identity ids (~1.4e17) and entity ids exceed
    /// 2^53 and would round if they ever passed through a JS number.
    /// </summary>
    public sealed class PlayerRecord
    {
        public long IdentityId;
        public ulong SteamId;
        public string DisplayName = "";
        public long CharacterEntityId;
        public bool HasCharacter;
        public Vector3D Position;
        public Vector3 Velocity;
        public bool HasPosition;

        /// <summary>The grid the player is seated in / controlling, if any.</summary>
        public long ControlledGridId;
        public string SeatName;
        /// <summary>
        /// T61: TRUE only when the occupied seat can actually fly the ship
        /// (CanControlShip). A passenger seat reports false.
        /// </summary>
        public bool Piloting;
        /// <summary>The seat's CanControlShip (definition EnableShipControl).</summary>
        public bool SeatCanControl;
        public bool HasGrid;

        public bool OnFoot = true;
        public bool IsDead;
        public string Planet;
        public double AglM = -1;
        public double AltitudeM = -1;
        public double GravityMps2 = -1;
        public string FactionTag;
        public string FactionId;
    }

    /// <summary>
    /// Reads the characters of online players. Data comes from
    /// `MyAPIGateway.Players.GetPlayers` (who is connected), the player's
    /// `Character` (position/velocity/seated grid) and the live session
    /// faction (identity id -> faction tag). Nothing here is inferred: a field
    /// that cannot be read is reported as null, never as a guessed value.
    /// </summary>
    public static class PlayerRead
    {
        public static List<PlayerRecord> Collect(Action<string, string> log)
        {
            var rows = new List<PlayerRecord>();
            List<IMyPlayer> players;
            try
            {
                players = new List<IMyPlayer>();
                MyAPIGateway.Players.GetPlayers(players, null);
            }
            catch (Exception ex)
            {
                if (log != null) log("warn", "players: GetPlayers failed: " + ex.GetType().Name + ": " + ex.Message);
                return rows;
            }

            var factions = FactionLookup();
            foreach (var player in players)
            {
                if (player == null) continue;
                if (player.IsBot) continue;
                var row = new PlayerRecord();
                try
                {
                    row.IdentityId = player.IdentityId;
                    row.SteamId = player.SteamUserId;
                    row.DisplayName = player.DisplayName ?? "";
                }
                catch (Exception ex)
                {
                    if (log != null) log("warn", "players: player identity unreadable: " + ex.Message);
                    continue;
                }

                try
                {
                    var identity = player.Identity;
                    row.IsDead = identity != null && identity.IsDead;
                }
                catch { /* identity not resolvable: leave false, report nothing */ }

                string factionId;
                if (factions.TryGetValue(row.IdentityId, out factionId))
                {
                    row.FactionId = factionId;
                    row.FactionTag = FactionTag(factionId);
                }

                var character = player.Character;
                if (character != null)
                {
                    try
                    {
                        row.HasCharacter = true;
                        row.CharacterEntityId = character.EntityId;
                        row.HasPosition = true;
                        row.Position = character.PositionComp.GetPosition();
                        if (character.Physics != null) row.Velocity = character.Physics.LinearVelocity;

                        // Seated / piloting: the character's seat block is its
                        // controller. On foot both are null.
                        var controller = CharacterController(character, row.IdentityId);
                        if (controller != null)
                        {
                            row.OnFoot = false;
                            row.SeatName = controller is IMyTerminalBlock ? SafeName((IMyTerminalBlock)controller) : null;
                            var block = controller as IMyCubeBlock;
                            if (block != null && block.CubeGrid != null)
                            {
                                row.HasGrid = true;
                                row.ControlledGridId = block.CubeGrid.EntityId;
                                // T61: a seated PASSENGER is not piloting. Verified
                                // against Sandbox.Game.dll: IsUnderControl means a
                                // controller is attached; CanControlShip is the
                                // definition's EnableShipControl (false for a
                                // passenger seat). That mismatch is what produced
                                // 'Passenger Seat 2 is piloting'.
                                bool underControl = false;
                                bool canControl = false;
                                try { underControl = controller.IsUnderControl; } catch { }
                                try { canControl = controller.CanControlShip; } catch { }
                                row.Piloting = underControl && canControl;
                                row.SeatCanControl = canControl;
                            }
                        }
                        else
                        {
                            row.OnFoot = true;
                        }

                        PlanetAt(row);
                    }
                    catch (Exception ex)
                    {
                        if (log != null) log("warn", "players: character sample failed for " + row.DisplayName + ": " + ex.Message);
                    }
                }
                else
                {
                    row.HasCharacter = false;
                    row.OnFoot = true;
                }

                rows.Add(row);
            }
            return rows;
        }

        /// <summary>
        /// The ship controller the character is seated in, or null when on foot.
        /// IMyCharacter.Parent is the seat/control block while seated; the
        /// IMyCockpit.Pilot fallback covers a seat that does not report a parent.
        /// When neither answers the player is reported as on foot.
        /// </summary>
        private static IMyShipController CharacterController(IMyCharacter character, long identity)
        {
            try
            {
                var seat = character.Parent as IMyShipController;
                if (seat != null) return seat;
            }
            catch { }

            try
            {
                if (identity == 0) return null;
                var grid = character.Parent as IMyCubeGrid;
                if (grid == null) return null;
                foreach (var c in grid.GetFatBlocks<IMyShipController>())
                {
                    if (c == null) continue;
                    var cockpit = c as IMyCockpit;
                    if (cockpit == null) continue;
                    var pilot = cockpit.Pilot as IMyCharacter;
                    if (pilot != null && pilot.EntityId == character.EntityId) return c;
                }
            }
            catch { }
            return null;
        }

        /// <summary>
        /// Friendly tag/name lookup. Faction ids are keys, tags are values; the
        /// identity dictionary maps identity id -> faction id.
        /// </summary>
        private static Dictionary<long, string> _factionOfIdentity;
        private static Dictionary<string, string> _factionTags;

        private static Dictionary<long, string> FactionLookup()
        {
            if (_factionOfIdentity != null) return _factionOfIdentity;
            _factionOfIdentity = new Dictionary<long, string>();
            _factionTags = new Dictionary<string, string>();
            try
            {
                // Dictionary key: faction id. Members: identityId -> rank.
                foreach (var kv in MyAPIGateway.Session.Factions.Factions)
                {
                    var faction = kv.Value;
                    if (faction == null) continue;
                    var factionId = kv.Key.ToString();
                    _factionTags["id:" + factionId] = faction.Tag;
                    foreach (var fid in faction.Members.Keys)
                        _factionOfIdentity[fid] = factionId;
                }
            }
            catch (Exception)
            {
                _factionOfIdentity.Clear();
            }
            return _factionOfIdentity;
        }

        private static string FactionTag(string factionId)
        {
            if (factionId == null || _factionTags == null) return null;
            string tag;
            return _factionTags.TryGetValue("id:" + factionId, out tag) ? tag : null;
        }

        /// <summary>
        /// Planet gravity + height for a character. AGL is the raycast distance
        /// down the local gravity vector against terrain (LosRay covers planet
        /// voxels; MyPlanet.GetHeightFromSurface is not on the plugin surface in
        /// this build), and altitudeM is the height above the mean sphere.
        /// </summary>
        private static void PlanetAt(PlayerRecord row)
        {
            var pos = row.Position;
            var best = NearestPlanet(pos);
            if (best == null) return;
            row.Planet = best.Name ?? "unknown";
            try { row.AltitudeM = Math.Round((pos - best.PositionComp.GetPosition()).Length() - (double)best.AverageRadius, 1); }
            catch { row.AltitudeM = -1; }

            Vector3D up;
            float g = 0f;
            try
            {
                MyAPIGateway.Physics.CalculateNaturalGravityAt(pos, out g);
                row.GravityMps2 = Math.Round((double)g, 3);
            }
            catch { row.GravityMps2 = -1; }

            var centre = best.PositionComp.GetPosition();
            var radial = pos - centre;
            up = radial.LengthSquared() > 1e-6 ? Vector3D.Normalize(radial) : Vector3D.UnitY;
            try
            {
                var hit = LosRay.Cast(pos - up * 2.0, pos - up * ((double)best.MaximumRadius + 1000.0));
                row.AglM = hit.First != null
                    ? Math.Round(Vector3D.Dot(pos - hit.First.Position, up), 1)
                    : -1;
            }
            catch { row.AglM = -1; }
        }

        private static Sandbox.Game.Entities.MyPlanet NearestPlanet(Vector3D pos)
        {
            Sandbox.Game.Entities.MyPlanet best = null;
            double bestDist = double.MaxValue;
            try
            {
                var entities = new HashSet<VRage.ModAPI.IMyEntity>();
                MyAPIGateway.Entities.GetEntities(entities, e => e is Sandbox.Game.Entities.MyPlanet);
                foreach (var planet in entities)
                {
                    var p = planet as Sandbox.Game.Entities.MyPlanet;
                    if (p == null) continue;
                    var dist = (p.PositionComp.GetPosition() - pos).Length();
                    if (dist > p.MaximumRadius * 4.0) continue;
                    if (dist < bestDist) { bestDist = dist; best = p; }
                }
            }
            catch { }
            return best;
        }

        private static string SafeName(IMyTerminalBlock block)
        {
            try { return block != null ? (block.CustomName ?? "") : null; }
            catch { return null; }
        }

        /// <summary>JSON exactly as the backend contract describes it; ids are strings.</summary>
        public static JObject ToJson(PlayerRecord row)
        {
            var obj = new JObject
            {
                ["identityId"] = row.IdentityId.ToString(),
                ["steamId"] = row.SteamId.ToString(),
                ["displayName"] = row.DisplayName ?? "",
                ["characterEntityId"] = row.HasCharacter ? row.CharacterEntityId.ToString() : null,
                ["pos"] = row.HasPosition ? Vec(row.Position.X, row.Position.Y, row.Position.Z) : null,
                ["vel"] = row.HasPosition ? Vec(row.Velocity.X, row.Velocity.Y, row.Velocity.Z) : null,
                ["gridId"] = row.HasGrid ? "grid:" + row.ControlledGridId : null,
                ["seatName"] = row.SeatName,
                ["piloting"] = row.Piloting,
                ["seatCanControl"] = row.SeatCanControl,
                ["planet"] = row.Planet,
                ["aglM"] = row.AglM >= 0 ? (JToken)Math.Round(row.AglM, 1) : null,
                ["altitudeM"] = row.AltitudeM >= 0 ? (JToken)Math.Round(row.AltitudeM, 1) : null,
                ["gravityMps2"] = row.GravityMps2 >= 0 ? (JToken)Math.Round(row.GravityMps2, 3) : null,
                ["onFoot"] = row.OnFoot,
                ["isDead"] = row.IsDead,
                ["factionTag"] = row.FactionTag,
                ["factionId"] = row.FactionId,
            };
            return obj;
        }

        public static JArray CollectJson(Action<string, string> log)
        {
            var arr = new JArray();
            foreach (var row in Collect(log)) arr.Add(ToJson(row));
            return arr;
        }

        private static JToken Vec(double x, double y, double z)
        {
            return new JObject { ["x"] = x, ["y"] = y, ["z"] = z };
        }
    }
}
