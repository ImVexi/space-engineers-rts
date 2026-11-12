#!/usr/bin/env bash
# Build the survival plugin package and prove no admin handler is in it.
#
#   SE_DS_BIN=/path/to/DedicatedServer64 ./deploy/build-plugin.sh
#
# Output: deploy/plugin-out/HermesRts.Plugin.dll (+ .pdb). Never committed.
# This script never writes to a game server; installing the DLL is a separate,
# manual step (see docs/INSTALL.md).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/deploy/plugin-out"

if [ -z "${SE_DS_BIN:-}" ]; then
  echo "FATAL: SE_DS_BIN is not set. Point it at your DedicatedServer64 folder." >&2
  exit 1
fi
if [ ! -f "$SE_DS_BIN/Sandbox.Game.dll" ]; then
  echo "FATAL: no Sandbox.Game.dll in $SE_DS_BIN" >&2
  exit 1
fi
export SE_DS_BIN

mkdir -p "$OUT"
cd "$REPO/plugin/HermesRts.Plugin"
dotnet build -c Release -o "$OUT"

DLL="$OUT/HermesRts.Plugin.dll"
echo
echo "== built: $DLL"
md5sum "$DLL"
echo

# Admin HANDLERS are CLR method names (UTF-8 #Strings heap) and are not part of
# this build. The snake_case action NAMES do remain: they are the routing table
# and the refusal text, so grepping for `spawn_prefab` alone proves nothing.
#
# `strings | grep -q` under `set -o pipefail` reports PRESENT as absent (SIGPIPE
# on strings), so the string table goes to a file first.
TOK="$OUT/.strings.txt"
{ strings -a "$DLL"; strings -el "$DLL"; } | tr -c '[:print:]' '\n' > "$TOK"

FAIL=0
for sym in SpawnPrefab CloneGrid ZeroVelocity SetOrientation RefillGrid TeleportPlayer DsTestHarness; do
  if grep -qx "$sym" "$TOK"; then
    echo "FAIL: admin handler symbol present in the survival build: $sym"
    FAIL=1
  else
    echo "ok   absent: $sym"
  fi
done

echo
echo "== expected remnants (routing names / refusal text only):"
for name in spawn_prefab clone_grid delete_grid refill_grid teleport zero_velocity set_orientation ownership; do
  if grep -qx -- "$name" "$TOK"; then echo "     action name (routing/refusals): $name"; fi
done
rm -f "$TOK"

if [ "$FAIL" -ne 0 ]; then
  echo
  echo "BUILD REJECTED: admin handlers leaked into the survival package." >&2
  exit 1
fi
echo
echo "OK: survival package has no admin handler."
