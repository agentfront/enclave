#!/usr/bin/env bash
# Usage: libs/core/spike/resumable/run.sh check | bench | demo
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
out="$root/tmp/spike-126"
mkdir -p "$out"
build() {
  npx esbuild "$root/libs/core/spike/resumable/$1.ts" --bundle --keep-names --platform=node --format=cjs \
    --target=node22 --tsconfig="$root/tsconfig.base.json" --conditions=development --outfile="$out/$1.js" --log-level=warning
}
case "${1:-check}" in
  check | bench)
    build "$1"
    node "$out/$1.js"
    ;;
  demo)
    build demo
    for scenario in loop parallel approval; do
      node "$out/demo.js" save "$scenario" "$out/state-$scenario.json"
      node "$out/demo.js" resume "$scenario" "$out/state-$scenario.json"
      echo
    done
    ;;
esac
