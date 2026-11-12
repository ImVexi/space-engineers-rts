#!/usr/bin/env bash
# Build the documentation site from the repository README plus docs/.
#
#   scripts/build-docs-site.sh [output-dir]      default: ./site
#
# Needs mkdocs-material (`pip install mkdocs-material`, or point MKDOCS at a
# virtualenv binary). Nothing here touches the game server or the network.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO/site}"
MKDOCS="${MKDOCS:-mkdocs}"

if ! command -v "$MKDOCS" >/dev/null 2>&1; then
  echo "FATAL: $MKDOCS not found. Install with: pip install mkdocs-material" >&2
  exit 1
fi
if [ ! -f "$REPO/README.md" ]; then
  echo "FATAL: no README.md in $REPO" >&2
  exit 1
fi

# The site home page is the repository README. Inside the site, docs/ is served
# at the root, so `docs/X.md` links become `X.md`; leaving them would 404.
# docs/index.md is generated for the build only and is not committed.
INDEX="$REPO/docs/index.md"
ALLDOCS="$REPO/docs/all-docs.md"
cleanup() { rm -f "$INDEX" "$ALLDOCS"; }
trap cleanup EXIT

sed 's#](docs/#](#g' "$REPO/README.md" > "$INDEX"
# MkDocs treats README.md as the directory index, so the docs index is built as
# a separate page and linked from the nav as "All documentation".
cp "$REPO/docs/README.md" "$ALLDOCS"

cd "$REPO"
"$MKDOCS" build --clean --site-dir "$OUT"
echo "site: $OUT"
