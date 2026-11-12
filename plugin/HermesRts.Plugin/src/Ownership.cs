using System;
using Sandbox.ModAPI;
using VRage.Game.ModAPI;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Single ownership rule shared by telemetry, handoff detection and safe
    /// mode. Fails closed: if no owners are configured, nothing is ours.
    /// </summary>
    public static class Ownership
    {
        public static bool IsOwned(IMyCubeGrid grid, PluginConfig config)
        {
            if (grid == null || grid.Closed) return false;

            // VERIFY: grid.BigOwners is the plugin-side owner list.
            var owners = grid.BigOwners;
            if (owners == null || owners.Count == 0) return false;

            foreach (var owner in owners)
            {
                if (Array.IndexOf(config.OwnerSteamIds, owner) >= 0) return true;

                // grid.BigOwners carries identity ids, not Steam ids. Reflected
                // 01_210_014: IMyPlayerCollection.TryGetIdentityId(ulong steamId)
                // -> long identityId. Map the configured Steam ids once per grid.
                for (var i = 0; i < config.OwnerSteamIds.Length; i++)
                {
                    try
                    {
                        var steam = config.OwnerSteamIds[i];
                        if (steam > 0 && MyAPIGateway.Players.TryGetIdentityId((ulong)steam) == owner)
                            return true;
                    }
                    catch { /* player collection unavailable: fall through */ }
                }
                if (string.IsNullOrEmpty(config.FactionTag)) continue;
                try
                {
                    // VERIFY: faction lookup shape on the plugin API.
                    var faction = MyAPIGateway.Session.Factions.TryGetPlayerFaction(owner);
                    if (faction != null &&
                        string.Equals(faction.Tag, config.FactionTag, StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                catch
                {
                    // Faction API unavailable: owner-ID check still applies.
                }
            }
            return false;
        }
    }
}
