using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace HermesRts.Plugin
{
    /// <summary>
    /// String-or-array parsing for test-order parameters, and the match rules
    /// they feed.
    ///
    /// WHY THIS EXISTS. `set_block_props` read `filter.type`, `filter.subtype`,
    /// `filter.nameContains` and `actions` with a plain `(string)` cast. A
    /// JSON array in any of those positions makes Newtonsoft throw
    /// `ArgumentException: Can not convert Array to String`, and the whole
    /// order is refused before a single block is touched. The backend's
    /// touchdown gear lock sends `{ "type": ["LandingGear","MagneticPlate"] }`,
    /// so on 2026-11-10 the gear lock was rejected 10 times after a successful
    /// touchdown and the executor marked a landed mission FAILED.
    ///
    /// Both shapes are legal now, in every one of those positions: one string,
    /// or an array of strings (nested one level deep). Entries are trimmed and
    /// empty ones dropped, so `{"type":""}` means "no type filter" exactly like
    /// an absent key.
    ///
    /// This file is pure C# + Newtonsoft (no game types) so the offline test
    /// project `tests/block-filter` can compile it directly.
    /// </summary>
    public static class BlockFilter
    {
        /// <summary>Flatten one parameter into its terms: string, array, or null.</summary>
        public static string[] Terms(JToken token)
        {
            var into = new List<string>();
            Add(token, into, 0);
            return into.ToArray();
        }

        private static void Add(JToken token, List<string> into, int depth)
        {
            if (token == null || depth > 2) return;
            if (token.Type == JTokenType.Array)
            {
                foreach (var child in token.Children()) Add(child, into, depth + 1);
                return;
            }
            if (token.Type == JTokenType.Null || token.Type == JTokenType.Undefined) return;
            if (token.Type == JTokenType.Object) return;
            var text = token.ToString().Trim();
            if (text.Length > 0) into.Add(text);
        }

        /// <summary>
        /// True when `value` matches ANY term under `comparison`, or when there
        /// are no terms at all (an empty filter never excludes anything).
        /// </summary>
        public static bool AnyMatch(string value, string[] terms, StringComparison comparison)
        {
            if (terms == null || terms.Length == 0) return true;
            var v = value ?? string.Empty;
            for (var i = 0; i < terms.Length; i++)
            {
                if (v.IndexOf(terms[i], comparison) >= 0) return true;
            }
            return false;
        }

        /// <summary>
        /// True when `value` equals ANY term (case-insensitive), or when there
        /// are no terms. Used for the boolean actions a caller names in full
        /// (`OnOff_Off`), where a substring match would be wrong.
        /// </summary>
        public static bool AnyEquals(string value, string[] terms)
        {
            if (terms == null || terms.Length == 0) return true;
            for (var i = 0; i < terms.Length; i++)
            {
                if (string.Equals(value ?? string.Empty, terms[i], StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// The sentence every refusal uses, so a caller that sent the wrong
        /// shape learns what was received.
        /// </summary>
        public static string Describe(string name, string[] terms)
        {
            return terms == null || terms.Length == 0
                ? name + ": (none)"
                : name + ": " + string.Join(", ", terms);
        }
    }
}
