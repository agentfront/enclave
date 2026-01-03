#!/usr/bin/env bash
#
# Extracts the version from a library's package.json with error handling.
# Usage: ./scripts/get-lib-version.sh <lib-name>
# Example: ./scripts/get-lib-version.sh enclave-vm
#
# Exits with code 1 if:
#   - No library name provided
#   - package.json doesn't exist
#   - package.json is malformed
#   - No version field in package.json
#

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Error: Library name required" >&2
  echo "Usage: $0 <lib-name>" >&2
  exit 1
fi

lib="$1"
pkg_path="./libs/$lib/package.json"

if [ ! -f "$pkg_path" ]; then
  echo "Error: package.json not found at $pkg_path" >&2
  exit 1
fi

node -e "
  try {
    const pkg = require('$pkg_path');
    if (!pkg.version) {
      console.error('Error: No version field in package.json');
      process.exit(1);
    }
    console.log(pkg.version);
  } catch (err) {
    console.error('Error: Failed to read package.json:', err.message);
    process.exit(1);
  }
"
