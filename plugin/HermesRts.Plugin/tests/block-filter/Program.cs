using System;
using HermesRts.Plugin;
using Newtonsoft.Json.Linq;

// Offline unit tests for the `set_block_props` parameter parser (defect a,
// 2026-11-11). No game, no network: `dotnet run` in this directory, exit code
// 0 = all pass.
//
// The defect it pins, measured in game: the backend's touchdown gear lock sent
//   { "filter": { "type": ["LandingGear","MagneticPlate"] },
//     "props": { "Autolock": true, "Lock": true }, "actions": ["Lock"] }
// and the plugin answered
//   ArgumentException: Can not convert Array to String.
// ten times, because `MatchingBlocks` read `filter.type` with a plain
// `(string)` cast; the landing was already down, and the executor then marked
// the mission FAILED over a housekeeping order.
internal static class Program
{
    private static int _pass;
    private static int _fail;

    private static void Check(string name, bool ok, string detail = "")
    {
        if (ok) { _pass++; Console.WriteLine("PASS " + name); }
        else { _fail++; Console.WriteLine("FAIL " + name + (detail.Length > 0 ? " :: " + detail : "")); }
    }

    private static void Terms(string name, JToken token, params string[] expected)
    {
        var got = BlockFilter.Terms(token);
        var ok = got.Length == expected.Length;
        if (ok)
        {
            for (var i = 0; i < expected.Length; i++)
                if (got[i] != expected[i]) { ok = false; break; }
        }
        Check(name, ok, "got [" + string.Join("|", got) + "] expected [" + string.Join("|", expected) + "]");
    }

    private static int Main()
    {
        // --- the measured failing payload: an ARRAY of types is legal
        var order = JObject.Parse(@"{
            ""filter"": { ""type"": [""LandingGear"", ""MagneticPlate""] },
            ""props"": { ""Autolock"": true, ""Lock"": true },
            ""actions"": [""Lock""]
        }");
        Terms("array: filter.type flattens to two terms", order["filter"]["type"], "LandingGear", "MagneticPlate");
        Terms("array: actions flattens to one term", order["actions"], "Lock");

        // --- a single string stays a single term (every older caller)
        Terms("string: filter.type is one term", JValue.CreateString("Thruster"), "Thruster");
        Terms("string: actions is one term", JValue.CreateString("OnOff_Off"), "OnOff_Off");

        // --- the staging handoff the report blamed: type + subtype + action
        var handoff = JObject.Parse(@"{
            ""filter"": { ""type"": ""Thruster"", ""subtype"": ""Hydrogen"" },
            ""props"": { ""OnOff"": false },
            ""actions"": [""OnOff_Off""]
        }");
        Terms("handoff: type", handoff["filter"]["type"], "Thruster");
        Terms("handoff: subtype", handoff["filter"]["subtype"], "Hydrogen");
        Terms("handoff: actions", handoff["actions"], "OnOff_Off");

        // --- absent / null / empty / whitespace: no terms, never a throw
        Terms("absent: undefined token is no terms", null);
        Terms("null: JSON null is no terms", JValue.CreateNull());
        Terms("empty array: no terms", JArray.Parse("[]"));
        Terms("empty string: no terms", JValue.CreateString(""));
        Terms("whitespace: trimmed to no terms", JValue.CreateString("   "));
        Terms("array with blanks: blanks dropped, order kept",
            JArray.Parse(@"["" "", ""Lock"", null, "" Unlock ""]"), "Lock", "Unlock");
        Terms("nested array: flattened one level", JArray.Parse(@"[""A"", [""B""]]"), "A", "B");
        Terms("numbers keep their text form", JArray.Parse("[7, 8]"), "7", "8");

        // --- the match rules the filter uses
        Check("AnyMatch: empty terms match anything",
            BlockFilter.AnyMatch("Landing Gear", new string[0], StringComparison.OrdinalIgnoreCase));
        Check("AnyMatch: OR semantics, first term",
            BlockFilter.AnyMatch("SmallBlockLandingGear", new[] { "LandingGear", "MagneticPlate" }, StringComparison.OrdinalIgnoreCase));
        Check("AnyMatch: OR semantics, second term",
            BlockFilter.AnyMatch("LargeBlockMagneticPlate", new[] { "LandingGear", "MagneticPlate" }, StringComparison.OrdinalIgnoreCase));
        Check("AnyMatch: no term matches is false",
            !BlockFilter.AnyMatch("Hydrogen Thruster", new[] { "LandingGear", "MagneticPlate" }, StringComparison.OrdinalIgnoreCase));
        Check("AnyMatch: case insensitive",
            BlockFilter.AnyMatch("SMALLBLOCKLANDINGGEAR", new[] { "landinggear" }, StringComparison.OrdinalIgnoreCase));
        Check("AnyEquals: exact action id",
            BlockFilter.AnyEquals("OnOff_Off", new[] { "OnOff_Off" }));
        Check("AnyEquals: is not a substring match",
            !BlockFilter.AnyEquals("OnOff_Off_Extra", new[] { "OnOff_Off" }));

        // --- describe() is what a refusal would echo back
        Check("Describe: names the terms",
            BlockFilter.Describe("type", new[] { "A", "B" }).Contains("A, B"));

        Console.WriteLine();
        Console.WriteLine(_fail == 0
            ? "OK " + _pass + " checks passed"
            : "FAILED " + _fail + " of " + (_pass + _fail) + " checks");
        return _fail == 0 ? 0 : 1;
    }
}
