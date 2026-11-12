using System;
using Newtonsoft.Json.Linq;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;
using VRageMath;
using IMyShipConnector = Sandbox.ModAPI.IMyShipConnector;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Read-only connector table, compiled into BOTH build flavours. A dock is
    /// legitimate handling a pilot can do from the cockpit (a connector's
    /// Connect/Disconnect), so the live build has to be able to see the state
    /// it is in; the snap_dock world-matrix write stays a test-only cheat and
    /// is read-only here.
    /// </summary>
    public static class ConnectorRead
    {
        /// <summary>Connector table for one grid (used by the release/dock proof).</summary>
        public static JObject For(IMyCubeGrid grid)
        {
            var arr = new JArray();
            foreach (var c in grid.GetFatBlocks<IMyShipConnector>())
            {
                if (c == null) continue;
                var row = new JObject
                {
                    ["blockId"] = c.EntityId.ToString(),
                    ["name"] = SafeName(c),
                };
                try { row["status"] = c.Status.ToString(); } catch (Exception ex) { row["status"] = "unreadable: " + ex.Message; }
                try { row["isConnected"] = c.IsConnected; } catch { }
                try
                {
                    var other = c.OtherConnector;
                    if (other != null)
                    {
                        row["otherBlockId"] = other.EntityId.ToString();
                        var otherGrid = other.CubeGrid;
                        row["otherGridId"] = otherGrid != null ? "grid:" + otherGrid.EntityId : null;
                        row["distanceM"] = Math.Round((c.WorldMatrix.Translation - other.WorldMatrix.Translation).Length(), 3);
                    }
                }
                catch { }
                try
                {
                    row["position"] = Vec(c.WorldMatrix.Translation);
                    row["forward"] = Vec(c.WorldMatrix.Forward);
                }
                catch { }
                arr.Add(row);
            }
            return new JObject
            {
                ["gridId"] = "grid:" + grid.EntityId,
                ["name"] = grid.DisplayName ?? "",
                ["connectorCount"] = arr.Count,
                ["connectors"] = arr,
            };
        }

        private static string SafeName(IMyCubeBlock block)
        {
            try
            {
                var terminal = block as IMyTerminalBlock;
                return terminal != null ? (terminal.CustomName ?? "") : "";
            }
            catch { return ""; }
        }

        private static JObject Vec(Vector3D v)
        {
            return new JObject { ["x"] = Math.Round(v.X, 3), ["y"] = Math.Round(v.Y, 3), ["z"] = Math.Round(v.Z, 3) };
        }
    }
}
