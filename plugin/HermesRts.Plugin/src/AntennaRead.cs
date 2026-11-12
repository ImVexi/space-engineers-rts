using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Sandbox.Game.Entities;
using Sandbox.Game.GameSystems;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRage.ModAPI;
using VRageMath;
using IMyRadioAntenna = Sandbox.ModAPI.IMyRadioAntenna;
using MyRadioBroadcaster = Sandbox.Game.Entities.Cube.MyRadioBroadcaster;
using MyLaserBroadcaster = Sandbox.Game.Entities.Blocks.MyLaserBroadcaster;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Real radio state for one grid: which broadcasters this grid actually
    /// hears, and which grids actually hear its antennas.
    ///
    /// This replaces the old `radio_links` implementation, which answered from
    /// `MyCubeGridGroups.Logical` (rotor/piston/connector mechanical groups).
    /// Measured on the test server 2026-11-10: two grids 200 m apart with both
    /// antennas on reported `sameLogicalGroup:false`, because mechanical grouping
    /// has nothing to do with radio. The engine's own antenna system is the only
    /// authority:
    ///
    ///   * `MyGridRadioSystem.Broadcasters` / `.Receivers` — the grid's own
    ///     registered radio + laser ends.
    ///   * `MyDataBroadcaster.ReceiversInRange` — receivers the engine currently
    ///     resolves for that antenna (i.e. who hears it).
    ///   * `MyDataReceiver.BroadcastersInRange` — broadcasters that antenna
    ///     currently hears.
    ///   * `MyAntennaSystem.GetAllRelayedBroadcasters` / `GetAllReachableReceivers`
    ///     — the relayed (multi-hop) view, when the build answers.
    ///
    /// A field that throws is reported UNVERIFIED with the exception text; the
    /// action never turns "could not read" into "no link".
    /// </summary>
    public static class AntennaRead
    {
        public sealed class GridRadio
        {
            public long GridId;
            public string Name;
            public Vector3D Position;
            public JArray Antennas = new JArray();
            public List<Contact> Hears = new List<Contact>();      // broadcasters this grid's receivers resolve
            public List<Contact> HeardBy = new List<Contact>();    // grids whose receivers resolve this grid's broadcasters
            public List<Contact> RelayedContacts = new List<Contact>();
            public JObject Relayed = new JObject();
            public int RadioCount;
            public int WorkingBroadcasters;
        }

        public sealed class Contact
        {
            public long GridId;
            public string GridName;
            public string ViaAntenna;
            public string ViaBlock;
            public double DistanceM;
            public string Via; // direct | relayed
        }

        public static GridRadio Read(IMyCubeGrid grid)
        {
            var data = new GridRadio
            {
                GridId = grid.EntityId,
                Name = grid.DisplayName ?? "",
                Position = grid.PositionComp.GetPosition(),
            };

            var cube = grid as MyCubeGrid;
            if (cube == null)
            {
                data.Antennas.Add(new JObject
                {
                    ["state"] = "UNVERIFIED",
                    ["reason"] = "grid is not a MyCubeGrid instance; radio system not reachable",
                });
                return data;
            }

            var cubeSystems = cube.GridSystems;
            var radioSystem = cubeSystems != null ? cubeSystems.RadioSystem : null;
            if (radioSystem == null)
            {
                data.Antennas.Add(new JObject
                {
                    ["state"] = "UNVERIFIED",
                    ["reason"] = "MyGridRadioSystem is null for this grid",
                });
                return data;
            }

            // Grid-local broadcaster ids so a contact can be traced to a block.
            var ownBroadcasters = new Dictionary<long, MyDataBroadcaster>();
            try
            {
                foreach (var b in radioSystem.Broadcasters)
                {
                    if (b == null) continue;
                    ownBroadcasters[b.AntennaEntityId] = b;
                }
            }
            catch (Exception ex)
            {
                data.Antennas.Add(new JObject
                {
                    ["state"] = "UNVERIFIED",
                    ["reason"] = "Broadcasters threw: " + ex.GetType().Name + ": " + ex.Message,
                });
            }

            // One row per radio antenna block: its engine-maintained hear sets.
            foreach (var antenna in grid.GetFatBlocks<IMyRadioAntenna>())
            {
                if (antenna == null) continue;
                data.RadioCount++;
                var row = new JObject
                {
                    ["blockId"] = antenna.EntityId.ToString(),
                    ["name"] = SafeName(antenna),
                    ["radiusM"] = Math.Round(antenna.Radius, 1),
                    ["enabled"] = antenna.Enabled,
                    ["working"] = antenna.IsWorking,
                    ["broadcasting"] = antenna.EnableBroadcasting,
                    ["isBroadcasting"] = antenna.IsBroadcasting,
                };

                var receiversInRange = new JArray();
                var heard = new JArray();
                if (!ownBroadcasters.ContainsKey(antenna.EntityId))
                {
                    row["broadcasterState"] = "not-registered: antenna is off, unpowered, or not broadcasting";
                }
                else
                {
                    var broadcaster = ownBroadcasters[antenna.EntityId];
                    try
                    {
                        if (antenna.Enabled && antenna.IsWorking && antenna.EnableBroadcasting) data.WorkingBroadcasters++;
                    }
                    catch { }

                    try
                    {
                        foreach (var receiver in broadcaster.ReceiversInRange)
                        {
                            if (receiver == null) continue;
                            var contact = ContactOfReceiver(receiver, data.Position, "direct");
                            if (contact == null) continue;
                            if (contact.GridId == data.GridId) continue;
                            receiversInRange.Add(ContactJson(contact, receiver.Entity != null ? receiver.Entity.EntityId : 0));
                            AddUnique(data.HeardBy, contact);
                        }
                        row["receiversInRange"] = receiversInRange;
                        row["receiversInRangeState"] = "readable";
                        row["receiversInRangeCount"] = receiversInRange.Count;
                    }
                    catch (Exception ex)
                    {
                        row["receiversInRangeState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
                    }
                }

                // What this antenna's receiver end resolves (who it hears).
                try
                {
                    var receiver = FindReceiver(radioSystem, antenna.EntityId);
                    if (receiver == null)
                    {
                        row["hearsState"] = "no receiver registered for this antenna";
                    }
                    else
                    {
                        foreach (var b in receiver.BroadcastersInRange)
                        {
                            if (b == null) continue;
                            var contact = ContactOfBroadcaster(b, grid, data.Position, "direct");
                            if (contact == null || contact.GridId == data.GridId) continue;
                            heard.Add(ContactJson(contact, b.AntennaEntityId));
                            AddUnique(data.Hears, contact);
                        }
                        row["hears"] = heard;
                        row["hearsState"] = "readable";
                        row["hearsCount"] = heard.Count;
                    }
                }
                catch (Exception ex)
                {
                    row["hearsState"] = "UNVERIFIED: " + ex.GetType().Name + ": " + ex.Message;
                }

                data.Antennas.Add(row);
            }

            // Relayed (multi-hop) view: the same call the game uses to decide
            // whether an antenna can contact a grid through relay antennas.
            try
            {
                var set = new HashSet<MyDataBroadcaster>();
                var returned = MyAntennaSystem.Static.GetAllRelayedBroadcasters(cube, 0L, true, set, false);
                var source = returned ?? set;
                var list = new JArray();
                foreach (var b in source)
                {
                    if (b == null) continue;
                    var contact = ContactOfBroadcaster(b, grid, data.Position, "relayed");
                    if (contact == null || contact.GridId == data.GridId) continue;
                    list.Add(ContactJson(contact, b.AntennaEntityId));
                    AddUnique(data.RelayedContacts, contact);
                }
                data.Relayed["state"] = "readable";
                data.Relayed["count"] = list.Count;
                data.Relayed["grids"] = list;
            }
            catch (Exception ex)
            {
                data.Relayed["state"] = "UNVERIFIED";
                data.Relayed["reason"] = ex.GetType().Name + ": " + ex.Message;
            }

            return data;
        }

        private static MyDataReceiver FindReceiver(MyGridRadioSystem radioSystem, long antennaEntityId)
        {
            try
            {
                foreach (var receiver in radioSystem.Receivers)
                {
                    if (receiver == null) continue;
                    var entity = receiver.Entity;
                    if (entity != null && entity.EntityId == antennaEntityId) return receiver;
                }
            }
            catch { }
            return null;
        }

        private static Contact ContactOfReceiver(MyDataReceiver receiver, Vector3D from, string via)
        {
            try
            {
                var entity = receiver.Entity;
                if (entity == null) return null;
                var grid = entity as IMyCubeGrid;
                if (grid == null && entity.Parent != null) grid = entity.Parent as IMyCubeGrid;
                var point = entity.PositionComp != null ? entity.PositionComp.GetPosition() : from;
                return new Contact
                {
                    GridId = grid != null ? grid.EntityId : entity.EntityId,
                    GridName = grid != null ? (grid.DisplayName ?? "") : (entity.DisplayName ?? ""),
                    ViaAntenna = SafeName(entity as IMyCubeBlock),
                    DistanceM = Math.Round((point - from).Length(), 1),
                    Via = via,
                };
            }
            catch { return null; }
        }

        internal static Contact ContactOfBroadcaster(MyDataBroadcaster broadcaster, IMyCubeGrid self, Vector3D from, string via)
        {
            try
            {
                var parent = MyAntennaSystem.Static.GetBroadcasterParentEntity(broadcaster);
                var grid = parent as IMyCubeGrid;
                if (grid == null && parent != null && parent.Parent != null) grid = parent.Parent as IMyCubeGrid;
                var point = broadcaster.BroadcastPosition;
                var name = "";
                string blockName;
                try
                {
                    var block = MyAPIGateway.Entities.GetEntityById(broadcaster.AntennaEntityId) as IMyCubeBlock;
                    blockName = block != null ? SafeName(block) : "";
                    if (grid != null) name = grid.DisplayName ?? "";
                }
                catch { blockName = ""; }

                if (grid == null && parent != null)
                {
                    name = parent.DisplayName ?? "";
                }

                return new Contact
                {
                    GridId = grid != null ? grid.EntityId : (parent != null ? parent.EntityId : 0),
                    GridName = name,
                    ViaBlock = blockName,
                    ViaAntenna = BroadcastKind(broadcaster),
                    DistanceM = Math.Round((point - from).Length(), 1),
                    Via = via,
                };
            }
            catch { return null; }
        }

        private static string BroadcastKind(MyDataBroadcaster broadcaster)
        {
            if (broadcaster is MyLaserBroadcaster) return "laser";
            if (broadcaster is MyRadioBroadcaster) return "radio";
            if (broadcaster.IsBeacon) return "beacon";
            return broadcaster.GetType().Name;
        }

        private static void AddUnique(List<Contact> list, Contact contact)
        {
            foreach (var existing in list)
            {
                if (existing.GridId == contact.GridId && existing.Via == contact.Via) return;
            }
            list.Add(contact);
        }

        private static JObject ContactJson(Contact contact, long blockEntityId)
        {
            var json = new JObject
            {
                ["gridId"] = "grid:" + contact.GridId,
                ["gridName"] = contact.GridName ?? "",
                ["distanceM"] = contact.DistanceM,
                ["via"] = contact.Via,
            };
            if (!string.IsNullOrEmpty(contact.ViaBlock)) json["blockName"] = contact.ViaBlock;
            if (!string.IsNullOrEmpty(contact.ViaAntenna)) json["medium"] = contact.ViaAntenna;
            if (blockEntityId != 0) json["blockId"] = blockEntityId.ToString();
            return json;
        }

        private static string SafeName(IMyCubeBlock block)
        {
            if (block == null) return "";
            try
            {
                var terminal = block as IMyTerminalBlock;
                return terminal != null ? (terminal.CustomName ?? "") : "";
            }
            catch { return ""; }
        }

        /// <summary>Per-grid JSON row for the `radio_links` action.</summary>
        public static JObject ToJson(GridRadio data)
        {
            var hears = new JArray();
            foreach (var c in data.Hears) hears.Add(ContactJson(c, 0));
            var heardBy = new JArray();
            foreach (var c in data.HeardBy) heardBy.Add(ContactJson(c, 0));

            return new JObject
            {
                ["gridId"] = "grid:" + data.GridId,
                ["name"] = data.Name,
                ["position"] = Vec(data.Position),
                ["radioAntennas"] = data.Antennas,
                ["radioCount"] = data.RadioCount,
                ["workingBroadcasters"] = data.WorkingBroadcasters,
                ["hears"] = hears,
                ["hearsCount"] = hears.Count,
                ["heardBy"] = heardBy,
                ["heardByCount"] = heardBy.Count,
                ["relayed"] = data.Relayed,
                ["logicalGroupRepresentative"] = LogicalGroup(data),
            };
        }

        /// <summary>
        /// Kept for the backend's existing reader, but explicitly labelled: this
        /// is the mechanical (rotor/piston/connector) group, not radio reach.
        /// </summary>
        private static JObject LogicalGroup(GridRadio data)
        {
            try
            {
                var grid = MyAPIGateway.Entities.GetEntityById(data.GridId) as MyCubeGrid;
                if (grid == null) return Unverified("grid not found by id");
                var rep = MyAntennaSystem.Static.GetLogicalGroupRepresentative(grid);
                return new JObject
                {
                    ["state"] = "readable",
                    ["value"] = "grid:" + rep.EntityId,
                    ["semantics"] = "MyCubeGridGroups.Logical (rotor/piston/connector mechanical group); NOT radio reach",
                };
            }
            catch (Exception ex)
            {
                return Unverified(ex.GetType().Name + ": " + ex.Message);
            }
        }

        public static JObject Unverified(string reason)
        {
            return new JObject { ["state"] = "UNVERIFIED", ["reason"] = reason };
        }

        private static JObject Vec(Vector3D v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }
    }
}
