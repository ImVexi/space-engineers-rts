using System;
using System.Collections.Generic;

namespace HermesRts.Plugin
{
    /// <summary>
    /// Ship-role tag parsing ("marking"), shared by the plugin read and its
    /// offline tests. Pure string logic: no game types, so the harness can pin
    /// the aliases and precedence without a server.
    ///
    /// Tokens (case-insensitive), in ANY block's CustomName or a CustomData line:
    ///   [HERMES-PERSONAL] / [PERSONAL]  -> personal
    ///   [HERMES-BASE]     / [BASE]      -> base
    ///   [HERMES-OFF]      / [OFF]       -> off
    ///   [HERMES-MANAGED]  / [MANAGED]   -> managed (explicit; the live runbook)
    ///   [HERMES-TEST]                   -> managed (legacy tag)
    ///   HERMES_ROLE=managed|personal|base|off
    ///
    /// Precedence on one grid: OFF &gt; PERSONAL &gt; BASE &gt; MANAGED.
    /// </summary>
    public static class ShipRoleTags
    {
        public sealed class Hint
        {
            public string Role;
            public string Token;
            public string Source; // "block-name" | "custom-data"
            public string Block;
        }

        /// <summary>Longest tokens first, so an alias cannot shadow a full tag.</summary>
        public static readonly string[][] Tokens =
        {
            new[] { "[HERMES-PERSONAL]", "personal" },
            new[] { "[HERMES-MANAGED]", "managed" },
            new[] { "[HERMES-BASE]", "base" },
            new[] { "[HERMES-OFF]", "off" },
            new[] { "[HERMES-TEST]", "managed" },
            new[] { "[PERSONAL]", "personal" },
            new[] { "[MANAGED]", "managed" },
            new[] { "[BASE]", "base" },
            new[] { "[OFF]", "off" },
        };

        public static int Rank(string role)
        {
            switch (role)
            {
                case "off": return 4;
                case "personal": return 3;
                case "base": return 2;
                default: return 1;
            }
        }

        public static string ValueRole(string value)
        {
            if (string.IsNullOrEmpty(value)) return null;
            switch (value.Trim().Trim('"', '\'').ToLowerInvariant())
            {
                case "managed": return "managed";
                case "personal": return "personal";
                case "base": return "base";
                case "off": return "off";
                default: return null;
            }
        }

        /// <summary>Every distinct hint in one string (name or CustomData body).</summary>
        public static List<Hint> Parse(string text, string source, string block)
        {
            var hints = new List<Hint>();
            if (string.IsNullOrEmpty(text)) return hints;
            var lower = text.ToLowerInvariant();
            foreach (var pair in Tokens)
            {
                if (lower.IndexOf(pair[0], StringComparison.OrdinalIgnoreCase) < 0) continue;
                hints.Add(new Hint { Role = pair[1], Token = pair[0], Source = source, Block = block });
            }
            var idx = 0;
            while ((idx = lower.IndexOf("hermes_role", idx, StringComparison.Ordinal)) >= 0)
            {
                var eq = lower.IndexOf('=', idx);
                if (eq < 0) break;
                var end = eq + 1;
                while (end < lower.Length && (char.IsLetterOrDigit(lower[end]) || lower[end] == '_')) end++;
                var role = ValueRole(text.Substring(eq + 1, end - eq - 1));
                idx = end;
                if (role == null) continue;
                hints.Add(new Hint { Role = role, Token = "HERMES_ROLE=" + role, Source = source, Block = block });
            }
            return hints;
        }

        /// <summary>The most restrictive role in a set, or null when empty.</summary>
        public static string Worst(IEnumerable<string> roles)
        {
            string worst = null;
            foreach (var role in roles)
            {
                if (role == null) continue;
                if (worst == null || Rank(role) > Rank(worst)) worst = role;
            }
            return worst;
        }
    }
}
