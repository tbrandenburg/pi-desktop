#!/usr/bin/env bash
# Shared by `make run` and `make run-web`: Electron always needs a working
# Chromium setuid sandbox to start (even in `run-web`'s headless mode, since
# app.whenReady() itself spawns a zygote/GPU process). If
# node_modules/electron/dist/chrome-sandbox isn't root-owned/4755 (common in
# containers/CI), disable Electron's sandbox for this dev-only invocation
# instead of failing with a FATAL setuid error.
set -euo pipefail

npm_script="$1"
sandbox_bin="node_modules/electron/dist/chrome-sandbox"

if [ -e "$sandbox_bin" ] && [ "$(stat -c '%U:%a' "$sandbox_bin" 2>/dev/null)" != "root:4755" ]; then
  echo "make: $sandbox_bin is not root-owned/4755; running with ELECTRON_DISABLE_SANDBOX=1"
  ELECTRON_DISABLE_SANDBOX=1 npm run "$npm_script"
else
  npm run "$npm_script"
fi
