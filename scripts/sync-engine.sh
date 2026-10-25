#!/bin/sh
# Copies the local-backtest engine into python/vendor/ from the main branch on GitHub of the HQG
# repos it comes from, so local results match the server. Run it before a release that should pick
# up engine changes, and commit python/vendor/.
#
# It expects hqg-backtester, hqg-datafeed and hqg-algorithms cloned next to this repo; set
# HQG_REPOS to the folder holding them if they live elsewhere. Your working copies are never
# changed: it fetches and copies origin/main directly.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPOS=${HQG_REPOS:-$(dirname "$ROOT")}
DEST="$ROOT/python/vendor"

rm -rf "$DEST"
mkdir -p "$DEST"
: > "$DEST/VERSIONS.txt"

copy() {
  repo=$1
  shift
  git -C "$REPOS/$repo" fetch -q origin main
  git -C "$REPOS/$repo" archive origin/main "$@" | tar -x -C "$DEST"
  echo "$repo $(git -C "$REPOS/$repo" rev-parse --short origin/main)" >> "$DEST/VERSIONS.txt"
}

# The backtest pipeline, without the web server (api/) and job queue (scheduler/).
copy hqg-backtester src/__init__.py src/config src/execution src/models src/services src/utils LICENSE
mv "$DEST/LICENSE" "$DEST/LICENSE-hqg-backtester"
# Price and alt-data downloads.
copy hqg-datafeed datafeed
# The strategy API. Bundled because the PyPI release lags the version the backtester expects.
copy hqg-algorithms hqg_algorithms

echo "Synced into python/vendor/:"
cat "$DEST/VERSIONS.txt"
