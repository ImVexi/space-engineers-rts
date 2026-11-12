using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;

namespace HermesRts.Plugin
{
    /// <summary>
    /// T61 passenger rule: the classified control state of ONE grid.
    ///
    /// The old check ("any controller with IsUnderControl") is replaced by
    /// `PassengerMath.Classify` over every ship controller on the grid, using
    /// ModAPI properties verified against plugin/refs (Sandbox.Game.dll):
    ///
    ///   IMyShipController.IsUnderControl  -> MyShipController.ControllerInfo.Controller != null
    ///   IMyShipController.CanControlShip  -> MyShipController.EnableShipControl (the definition's
    ///                                        EnableShipControl: false for a passenger seat)
    ///   IMyShipController.IsMainCockpit   -> MyShipController.IsMainCockpit
    ///   IMyShipController.Pilot           -> the character attached to the seat
    ///   IMyCubeBlock.BlockDefinition.SubtypeId -> 'PassengerSeatLarge', 'Cockpit', ...
    ///   IMyControllableEntity.ControllerInfo.ControllingIdentityId -> who is attached
    ///
    /// `underControl` is kept for compatibility but is true ONLY for a real
    /// pilot, so a seated passenger can no longer silence the executor.
    /// </summary>
    public sealed class ControlReport
    {
        public sealed class Occupant
        {
            public string IdentityId = "";
            public string Name = "";
            public string Seat = "";
            public string ControllerType = "";
            public string Subtype = "";
            public bool RemoteControl;
            public bool Main;
        }

        /// <summary>One online player as this scan needs them.</summary>
        public sealed class Presence
        {
            public long IdentityId;
            public string Name = "";
            /// <summary>Block entity id of the ship controller the character sits in, 0 = on foot.</summary>
            public long SeatBlockEntityId;
            public Vector3D Position;
            public bool HasPosition;
            public bool Dead;
        }

        public Occupant Pilot;
        public readonly List<Occupant> Passengers = new List<Occupant>();
        public readonly List<Occupant> Aboard = new List<Occupant>();
        /// <summary>Raw per-controller rows: name/type/subtype/occupancy/canControl.</summary>
        public readonly JArray Controllers = new JArray();
        public bool HasPassengers { get { return Passengers.Count > 0; } }
        public bool HasStanding { get { return Aboard.Count > 0; } }
        /// <summary>Compatibility boolean: a real pilot is flying this grid.</summary>
        public bool UnderControl { get { return Pilot != null; } }

        public PassengerLimits Limits(double gravityMps2)
        {
            return PassengerMath.Limits(HasPassengers, HasStanding, gravityMps2);
        }

        public string PilotName { get { return Pilot != null ? Pilot.Name : null; } }

        public List<string> PassengerNames()
        {
            var names = new List<string>();
            foreach (var p in Passengers) names.Add(p.Name);
            foreach (var p in Aboard) names.Add(p.Name + " (standing)");
            return names;
        }

        /// <summary>
        /// Classify one grid. `presence` is one scan of the online players for
        /// the whole telemetry frame (identity names + who sits where), so this
        /// costs one pass over the players, not one per grid.
        /// </summary>
        public static ControlReport Classify(IMyCubeGrid grid, IList<Presence> presence)
        {
            var report = new ControlReport();
            if (grid == null) return report;

            var seats = new List<SeatSample>();
            var controllers = new List<IMyShipController>();
            foreach (var c in grid.GetFatBlocks<IMyShipController>())
            {
                if (c == null) continue;
                var sample = new SeatSample
                {
                    Name = NameOf(c),
                    ControllerType = c.GetType().Name,
                    Subtype = SubtypeOf(c),
                    Occupied = false,
                    CanControlShip = false,
                    IsRemoteControl = c is IMyRemoteControl,
                    IsMain = false,
                };
                try { sample.Occupied = c.IsUnderControl; } catch { }
                try { sample.CanControlShip = c.CanControlShip; } catch { }
                // A cockpit whose Pilot is attached but whose controller info has
                // not been published yet still counts as occupied: the seated
                // character's `Parent`/`Pilot` is the same fact from the other
                // side, and a seat read as empty would hide a passenger.
                if (!sample.Occupied)
                {
                    try
                    {
                        var cockpit = c as IMyCockpit;
                        if (cockpit != null && cockpit.Pilot != null) sample.Occupied = true;
                    }
                    catch { }
                }
                try { sample.IsMain = c.IsMainCockpit; } catch { }
                seats.Add(sample);
                controllers.Add(c);
            }

            var classified = PassengerMath.Classify(seats);
            for (var i = 0; i < seats.Count; i++)
            {
                var s = seats[i];
                report.Controllers.Add(new JObject
                {
                    ["name"] = s.Name,
                    ["type"] = s.ControllerType,
                    ["subtype"] = s.Subtype,
                    ["occupied"] = s.Occupied,
                    ["canControlShip"] = s.CanControlShip,
                    ["isRemoteControl"] = s.IsRemoteControl,
                    ["isMain"] = s.IsMain,
                });
                if (!s.Occupied) continue;

                var occupant = OccupantOf(controllers[i], s, report, presence);
                if (i == classified.PilotIndex) report.Pilot = occupant;
                else report.Passengers.Add(occupant);
            }

            // A player standing on or inside the hull is not seated, so no
            // controller reports them. Geometry is the only honest signal: the
            // character's world position inside the grid's AABB (padded 2 m),
            // excluding anyone seated in ANY controller.
            if (presence != null)
            {
                Vector3D min, max;
                var haveBox = false;
                try
                {
                    var box = grid.PositionComp.WorldAABB;
                    min = box.Min;
                    max = box.Max;
                    haveBox = true;
                }
                catch { min = Vector3D.Zero; max = Vector3D.Zero; }

                if (haveBox)
                {
                    foreach (var who in presence)
                    {
                        if (who == null || who.Dead || !who.HasPosition) continue;
                        if (who.SeatBlockEntityId != 0) continue;
                        if (!PassengerMath.InsideAabb(
                                who.Position.X, who.Position.Y, who.Position.Z,
                                min.X, min.Y, min.Z, max.X, max.Y, max.Z,
                                PassengerMath.HullAabbMarginM)) continue;
                        report.Aboard.Add(new Occupant
                        {
                            IdentityId = who.IdentityId.ToString(),
                            Name = who.Name,
                            Seat = "standing",
                            ControllerType = "character",
                            Subtype = "",
                        });
                    }
                }
            }
            return report;
        }

        /// <summary>One scan of the online players: identity, name, seat, position.</summary>
        public static List<Presence> ScanPlayers(Action<string, string> log)
        {
            var rows = new List<Presence>();
            List<IMyPlayer> players;
            try
            {
                players = new List<IMyPlayer>();
                MyAPIGateway.Players.GetPlayers(players, null);
            }
            catch (Exception ex)
            {
                if (log != null) log("warn", "control: GetPlayers failed: " + ex.GetType().Name + ": " + ex.Message);
                return rows;
            }

            foreach (var player in players)
            {
                if (player == null || player.IsBot) continue;
                var row = new Presence();
                try
                {
                    row.IdentityId = player.IdentityId;
                    row.Name = player.DisplayName ?? "";
                    var identity = player.Identity;
                    row.Dead = identity != null && identity.IsDead;
                }
                catch { continue; }

                var character = player.Character;
                if (character == null) { rows.Add(row); continue; }
                try
                {
                    row.Position = character.PositionComp.GetPosition();
                    row.HasPosition = true;
                    var seat = character.Parent as IMyTerminalBlock;
                    if (seat is IMyShipController) row.SeatBlockEntityId = seat.EntityId;
                }
                catch { }
                rows.Add(row);
            }
            return rows;
        }

        private static Occupant OccupantOf(
            IMyShipController controller, SeatSample seat, ControlReport report, IList<Presence> presence)
        {
            var occupant = new Occupant
            {
                Seat = seat.Name,
                ControllerType = seat.ControllerType,
                Subtype = seat.Subtype,
                RemoteControl = seat.IsRemoteControl,
                Main = seat.IsMain,
            };

            long identity = 0;
            // Who is attached: the controller's ControllerInfo carries the identity
            // of the player in control (both a cockpit seat and a Remote Control).
            try { identity = controller.ControllerInfo.ControllingIdentityId; } catch { }
            // A cockpit's `Pilot` is the character in the seat; use it when the
            // controller info did not resolve (RCs report no Pilot).
            if (identity == 0)
            {
                try
                {
                    var pilotCharacter = controller.Pilot;
                    if (pilotCharacter != null) identity = pilotCharacter.ControllerInfo.ControllingIdentityId;
                }
                catch { }
            }

            // Fall back to the player scan: the character whose Parent is this block.
            if (identity == 0 && presence != null)
            {
                foreach (var who in presence)
                {
                    if (who != null && who.SeatBlockEntityId == controller.EntityId) { identity = who.IdentityId; break; }
                }
            }

            occupant.IdentityId = identity != 0 ? identity.ToString() : "";
            occupant.Name = NameOfIdentity(identity, presence, report);
            return occupant;
        }

        private static string NameOfIdentity(long identity, IList<Presence> presence, ControlReport report)
        {
            if (identity == 0) return "";
            if (presence != null)
            {
                foreach (var who in presence)
                    if (who != null && who.IdentityId == identity && !string.IsNullOrEmpty(who.Name)) return who.Name;
            }
            try
            {
                List<IMyIdentity> identities = new List<IMyIdentity>();
                MyAPIGateway.Players.GetAllIdentites(identities, i => i != null && i.IdentityId == identity);
                if (identities.Count > 0 && identities[0] != null) return identities[0].DisplayName ?? "";
            }
            catch { }
            return "";
        }

        private static string NameOf(IMyShipController c)
        {
            try
            {
                var terminal = c as IMyTerminalBlock;
                return terminal != null ? terminal.CustomName ?? "" : "";
            }
            catch { return ""; }
        }

        private static string SubtypeOf(IMyShipController c)
        {
            try
            {
                var block = c as IMyCubeBlock;
                if (block != null) return block.BlockDefinition.SubtypeId ?? "";
            }
            catch { }
            try
            {
                var slim = c.SlimBlock;
                if (slim != null && slim.BlockDefinition != null) return slim.BlockDefinition.Id.SubtypeName ?? "";
            }
            catch { }
            return "";
        }

        /// <summary>
        /// The wire shape. `underControl`/`by` stay for compatibility and mean
        /// PILOT ONLY; the classified detail rides alongside.
        /// </summary>
        public JObject ToJson()
        {
            var passengers = new JArray();
            foreach (var p in Passengers) passengers.Add(OccupantJson(p));
            var aboard = new JArray();
            foreach (var p in Aboard) aboard.Add(OccupantJson(p));

            return new JObject
            {
                ["underControl"] = UnderControl,
                ["by"] = PilotName,
                ["pilot"] = Pilot != null ? OccupantJson(Pilot) : null,
                ["passengers"] = passengers,
                ["aboard"] = aboard,
                ["carryingPassengers"] = HasPassengers,
                ["standingAboard"] = HasStanding,
                ["controllers"] = Controllers,
            };
        }

        private static JObject OccupantJson(Occupant o)
        {
            return new JObject
            {
                ["identityId"] = o.IdentityId,
                ["name"] = o.Name,
                ["seat"] = o.Seat,
                ["controllerType"] = o.ControllerType,
                ["subtype"] = o.Subtype,
                ["remoteControl"] = o.RemoteControl,
                ["main"] = o.Main,
            };
        }

        /// <summary>A plain sentence for the audit: 'Carrying the owner (Passenger Seat 2)'.</summary>
        public string CarryingSentence()
        {
            if (!HasPassengers && !HasStanding) return null;
            var parts = new List<string>();
            foreach (var p in Passengers)
                parts.Add(string.IsNullOrEmpty(p.Name) ? p.Seat : p.Name + " (" + p.Seat + ")");
            foreach (var p in Aboard)
                parts.Add(string.IsNullOrEmpty(p.Name) ? "unnamed (standing)" : p.Name + " (standing)");
            var who = string.Join(", ", parts);
            return HasStanding ? "carrying " + who + " — a player is standing, not seated" : "carrying " + who;
        }
    }
}
