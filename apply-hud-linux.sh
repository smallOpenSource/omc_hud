#!/usr/bin/env bash
# Apply the custom OMC HUD statusline on Linux.
# Thin launcher: all logic lives in apply-hud.mjs (cross-platform node).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' was not found in PATH. Install Node.js first." >&2
  exit 1
fi

exec node "$DIR/apply-hud.mjs"
