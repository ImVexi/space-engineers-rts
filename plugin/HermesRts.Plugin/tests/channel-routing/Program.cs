using System;
using System.Collections.Generic;
using System.Linq;
using HermesRts.Plugin;

// Offline unit tests for the order-channel table. No game, no network: run with
// `dotnet run` in this directory. Exit code 0 = all pass.
//
// Why this exists: the 2026-11-11 survival rehearsal showed every action failing
// on the live build because nothing routed to it. The channel table is the one
// place a capability is granted, so it is pinned here for both halves:
//   * production -> orderType "action", compiled into both builds;
//   * admin      -> orderType "test", test build only, refused on "action".
internal static class Program
{
    private static int _pass;
    private static int _fail;

    private static void Check(string name, bool ok, string detail = "")
    {
        if (ok) { _pass++; Console.WriteLine("PASS " + name); }
        else { _fail++; Console.WriteLine("FAIL " + name + (detail.Length > 0 ? " :: " + detail : "")); }
    }

    /// <summary>The legit set the backend must be able to send in survival.</summary>
    private static readonly string[] RequiredProduction =
    {
        "identity", "inspect", "profile", "list_tagged", "radio_links", "laser_state",
        "is_under_control", "deadman_status", "connector_state", "get_block_props",
        "sim_ratio",
        "set_block_props", "set_dampeners", "wake", "gyro_fix", "physics_wake",
        "move", "hold", "stop", "level_hold", "level_move", "level_stop", "level_status",
        "land_at", "land_ground", "land_status", "land_stop",
        "convert_to_station", "convert_to_ship",
        "laser_target", "laser_connect", "laser_disconnect", "rename_block",
        // 2026-11-11 reclassification: cockpit-grade reads, HUD markers, a grid's
        // own autopilot switch and ownership-guarded auto-naming.
        "list_players", "planets", "suit_radio", "dock_state",
        "gps_add", "gps_remove", "gps_list", "rename_grid", "ai_off",
    };

    /// <summary>Backend ADMIN_ACTIONS (packages/backend/src/demo/survival.ts).</summary>
    private static readonly string[] BackendAdmin =
    {
        "spawn_prefab", "clone_grid", "delete_grid", "refill_grid", "teleport",
        "teleport_player", "zero_velocity", "set_orientation", "ownership",
        "delete_planets", "snap_dock",
    };

    /// <summary>Actions the live build must never answer over any channel.</summary>
    private static readonly string[] NeverInLive =
    {
        "spawn_prefab", "clone_grid", "delete_grid", "refill_grid", "teleport",
        "teleport_player", "zero_velocity", "set_orientation", "ownership",
        "delete_planets", "snap_dock", "save", "despawn_state",
    };

    private static int Main()
    {
        // --- the two channel names -------------------------------------------
        Check("channel: production orderType is 'action'", ActionChannelRules.ProductionOrderType == "action",
            ActionChannelRules.ProductionOrderType);
        Check("channel: test orderType is 'test'", ActionChannelRules.TestOrderType == "test");
        Check("channel: refusal names the build",
            ActionChannelRules.Unavailable("spawn_prefab") == "not available in survival build: spawn_prefab",
            ActionChannelRules.Unavailable("spawn_prefab"));

        // --- every legitimate action is production ---------------------------
        foreach (var name in RequiredProduction)
        {
            Check("production: " + name, ActionChannelRules.Classify(name) == ActionChannel.Production);
        }

        // --- every admin action is admin, in BOTH lists' vocabulary ----------
        foreach (var name in BackendAdmin)
        {
            Check("admin: " + name, ActionChannelRules.IsAdmin(name));
            Check("admin is not production: " + name, !ActionChannelRules.IsProduction(name));
        }
        foreach (var name in NeverInLive)
        {
            Check("refused over production: " + name, !ActionChannelRules.IsProduction(name));
        }

        // --- the tables do not overlap ---------------------------------------
        var prod = ActionChannelRules.ProductionActionNames();
        var admin = ActionChannelRules.AdminActionNames();
        Check("tables: no name in both", !prod.Intersect(admin, StringComparer.OrdinalIgnoreCase).Any(),
            string.Join(",", prod.Intersect(admin, StringComparer.OrdinalIgnoreCase)));
        Check("tables: production names are unique", prod.Length == prod.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Check("tables: admin names are unique", admin.Length == admin.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Check("tables: every admin name is classified", admin.All(n => ActionChannelRules.Classify(n) == ActionChannel.Admin));
        Check("tables: every production name is classified",
            prod.All(n => ActionChannelRules.Classify(n) == ActionChannel.Production));

        // --- normalisation: the wire may shout ------------------------------
        Check("normalise: 'Inspect' is production", ActionChannelRules.IsProduction("Inspect"));
        Check("normalise: ' SPAWN_PREFAB ' is admin", ActionChannelRules.IsAdmin(" SPAWN_PREFAB "));
        Check("normalise: null is unknown", ActionChannelRules.Classify(null) == ActionChannel.Unknown);
        Check("normalise: '' is unknown", ActionChannelRules.Classify("") == ActionChannel.Unknown);
        Check("normalise: whitespace is unknown", ActionChannelRules.Classify("   ") == ActionChannel.Unknown);
        Check("unknown: not production", !ActionChannelRules.IsProduction("make_me_a_sandwich"));

        // --- the capability story -------------------------------------------
        // The live build advertises action_api; test_api is test-build only.
        // Both facts are asserted in the build script, not here, because the
        // flag list is compiled per flavour. What this pins is that the channel
        // the live build advertises can actually answer the required set.
        Check("capability: required set is non-empty and fully routable",
            RequiredProduction.Length > 0 && RequiredProduction.All(ActionChannelRules.IsProduction));

        // --- ship-role tags ("marking"): pure parsing, no game ---------------
        Check("roles: list_tagged read is production", ActionChannelRules.IsProduction("list_tagged"));
        var personal = ShipRoleTags.Parse("[HERMES-TEST] personal hull [PERSONAL]", "block-name", "PB");
        Check("roles: legacy managed tag and personal alias both parse",
            personal.Any(h => h.Role == "personal") && personal.Any(h => h.Role == "managed"),
            string.Join(",", personal.Select(h => h.Token)));
        Check("roles: [HERMES-TEST] is managed", ShipRoleTags.Parse("[HERMES-TEST]", "block-name", "x")[0].Role == "managed");
        // T79: the live runbook's explicit managed tags, and the sim-ratio read.
        Check("roles: [HERMES-MANAGED] is managed",
            ShipRoleTags.Parse("[HERMES-MANAGED]", "block-name", "x").Count == 1
            && ShipRoleTags.Parse("[HERMES-MANAGED]", "block-name", "x")[0].Role == "managed",
            string.Join(",", ShipRoleTags.Parse("[HERMES-MANAGED]", "block-name", "x").Select(h => h.Token)));
        Check("roles: [MANAGED] is managed", ShipRoleTags.Parse("[MANAGED]", "block-name", "x")[0].Role == "managed");
        Check("roles: HERMES_ROLE=managed is managed",
            ShipRoleTags.Parse("HERMES_ROLE=managed", "custom-data", "x").Any(h => h.Role == "managed"));
        Check("channel: sim_ratio is a production action",
            ActionChannelRules.Classify("sim_ratio") == ActionChannel.Production);
        Check("roles: [BASE] alias is base", ShipRoleTags.Parse("[BASE]", "block-name", "x")[0].Role == "base");
        Check("roles: [OFF] alias is off", ShipRoleTags.Parse("[OFF]", "block-name", "x")[0].Role == "off");
        Check("roles: case-insensitive", ShipRoleTags.Parse("[personal]", "block-name", "x")[0].Role == "personal");
        Check("roles: CustomData line HERMES_ROLE=base",
            ShipRoleTags.Parse("piston\nHERMES_ROLE=base\n", "custom-data", "x").Any(h => h.Role == "base"));
        Check("roles: unknown HERMES_ROLE value ignored",
            !ShipRoleTags.Parse("HERMES_ROLE=pirate", "custom-data", "x").Any());
        Check("roles: full tag does not trigger its short alias",
            ShipRoleTags.Parse("[HERMES-BASE]", "block-name", "x").Count == 1,
            string.Join(",", ShipRoleTags.Parse("[HERMES-BASE]", "block-name", "x").Select(h => h.Token)));
        Check("roles: OFF beats PERSONAL beats BASE beats MANAGED",
            ShipRoleTags.Worst(new[] { "managed", "base", "personal", "off" }) == "off"
            && ShipRoleTags.Worst(new[] { "managed", "base", "personal" }) == "personal"
            && ShipRoleTags.Worst(new[] { "managed", "base" }) == "base"
            && ShipRoleTags.Worst(new[] { "managed" }) == "managed");
        Check("roles: no tag means no role", ShipRoleTags.Worst(new string[0]) == null);

        Console.WriteLine();
        Console.WriteLine(_fail == 0
            ? $"channel routing: {_pass} passed"
            : $"channel routing: {_pass} passed, {_fail} FAILED");
        return _fail == 0 ? 0 : 1;
    }
}
