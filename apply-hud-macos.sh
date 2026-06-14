#!/usr/bin/env bash
# Apply the custom OMC HUD statusline on macOS.
# Thin launcher: all logic lives in apply-hud.mjs (cross-platform node).
# Uses only POSIX/BSD-safe shell so it runs on the stock macOS bash 3.2 and zsh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' was not found in PATH. Install Node.js (e.g. 'brew install node')." >&2
  exit 1
fi

exec node "$DIR/apply-hud.mjs"
