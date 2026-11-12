using System;
using System.Collections.Generic;

namespace HermesRts.Plugin
{
    /// <summary>Which channel an action belongs to.</summary>
    public enum ActionChannel
    {
        /// <summary>Legitimate: compiled into BOTH builds, sent as `orderType: "action"`.</summary>
        Production,

        /// <summary>Admin/cheat: test build only, reached only over `orderType: "test"`.</summary>
        Admin,

        /// <summary>Neither table knows it.</summary>
        Unknown,
    }

    /// <summary>
    /// The channel routing table, pure and game-free so the offline harness
    /// (`tests/channel-routing`, `dotnet run`) can prove it without a Space
    /// Engineers install. Names only: the code behind them lives in
    /// <see cref="HermesActions"/>.
    ///
    /// The split is the whole point of the live build: an action on the
    /// production list can be flown by a player, an action on the admin list
    /// cannot (it spawns, clones, deletes, teleports, freezes or takes ownership).
    /// Anything not on the production list is refused by the production channel
    /// in both builds, so the table is the single place a capability is granted.
    /// </summary>
    public static class ActionChannelRules
    {
        /// <summary>The orderType a legitimate action travels under.</summary>
        public const string ProductionOrderType = "action";

        /// <summary>The orderType the test harness listens on.</summary>
        public const string TestOrderType = "test";

        /// <summary>Prefix of every production-channel refusal.</summary>
        public const string UnavailablePrefix = "not available in survival build: ";

        /// <summary>
        /// The legitimate set: reads and everything a pilot could do from the
        /// cockpit. Keep in step with PRODUCTION_ACTIONS in the backend
        /// (`packages/backend/src/demo/channel.ts`).
        /// </summary>
        private static readonly string[] ProductionNames =
        {
            // reads
            "identity", "ownership_check", "profile", "inspect", "list_tagged", "list_grids",
            "radio_links", "laser_state", "is_under_control", "deadman_status", "diag",
            "sim_ratio",
            "connector_state", "probe_ground", "probe_los", "get_block_props",
            // reads a player could take from the cockpit (session-wide)
            "list_players", "planets", "suit_radio", "dock_state",
            // HUD markers: the player can add/delete these themselves
            "gps_add", "gps_remove", "gps_list",
            // naming + switching built-in AI off (owned grids / own autopilot)
            "rename_grid", "ai_off",
            // flight and ship handling
            "move", "waypoint", "drive", "hold", "stop", "brake", "dock", "undock",
            "set_dampeners", "wake", "physics_wake", "gyro_fix",
            "set_block_props", "rename_block",
            "level_hold", "level_move", "level_stop", "level_status",
            "land_at", "land_ground", "land_status", "land_stop",
            "convert_to_ship", "convert_to_station",
            // lasers
            "laser_target", "laser_connect", "laser_disconnect",
        };

        /// <summary>
        /// The admin set. None of these names exists in this build: they are
        /// listed so a client that asks for one gets a policy refusal naming the
        /// action instead of an "unknown action" error. What is listed here
        /// creates, deletes, teleports, refills or re-owns something, or mutates
        /// world content, so it has no survival analogue.
        /// </summary>
        private static readonly string[] AdminNames =
        {
            "spawn_prefab", "clone_grid", "delete_grid", "refill_grid",
            "teleport", "teleport_player", "zero_velocity", "set_orientation",
            "ownership", "delete_planets", "snap_dock",
            "despawn_state", "save",
        };

        private static readonly HashSet<string> Production =
            new HashSet<string>(ProductionNames, StringComparer.OrdinalIgnoreCase);

        private static readonly HashSet<string> Admin =
            new HashSet<string>(AdminNames, StringComparer.OrdinalIgnoreCase);

        public static ActionChannel Classify(string action)
        {
            var name = Normalize(action);
            if (name.Length == 0) return ActionChannel.Unknown;
            if (Production.Contains(name)) return ActionChannel.Production;
            if (Admin.Contains(name)) return ActionChannel.Admin;
            return ActionChannel.Unknown;
        }

        public static bool IsProduction(string action)
        {
            return Classify(action) == ActionChannel.Production;
        }

        public static bool IsAdmin(string action)
        {
            return Classify(action) == ActionChannel.Admin;
        }

        /// <summary>The exact reason a production-channel refusal carries.</summary>
        public static string Unavailable(string action)
        {
            return UnavailablePrefix + (string.IsNullOrEmpty(action) ? "?" : action.Trim());
        }

        /// <summary>Copy, for the harness and the capability audit.</summary>
        public static string[] ProductionActionNames()
        {
            return (string[])ProductionNames.Clone();
        }

        /// <summary>Copy, for the harness and the capability audit.</summary>
        public static string[] AdminActionNames()
        {
            return (string[])AdminNames.Clone();
        }

        private static string Normalize(string action)
        {
            return action == null ? string.Empty : action.Trim().ToLowerInvariant();
        }
    }
}
