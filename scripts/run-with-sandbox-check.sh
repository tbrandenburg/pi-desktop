#!/usr/bin/env bash
# Shared by `make run` and `make run-web`: Electron always needs a working
# Chromium setuid sandbox to start (even in `run-web`'s headless mode, since
# app.whenReady() itself spawns a zygote/GPU process). If
# node_modules/electron/dist/chrome-sandbox isn't root-owned/4755 (common in
# containers/CI), disable Electron's sandbox for this dev-only invocation
# instead of failing with a FATAL setuid error.
#
# Electron's zygote/GPU process also needs *a* display, even when
# `run-web`'s PI_DESKTOP_WEB_BRIDGE_HEADLESS=1 skips creating a visible
# BrowserWindow. If DISPLAY isn't set (e.g. a bare shell/CI session) and
# xvfb-run is available, re-exec this script under a virtual display instead
# of failing or reaching for a full container -- Docker/Xvfb-in-a-container
# is for testing install/packaging cleanliness, not for working around a
# missing display, which this one flag already fixes.
set -euo pipefail

if [ -z "${DISPLAY:-}" ]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "make: no DISPLAY set; running under xvfb-run"
    exec xvfb-run -a "$0" "$@"
  fi
  echo "make: no DISPLAY set and xvfb-run is not installed (apt install xvfb); continuing without it" >&2
fi

npm_script="$1"
sandbox_bin="node_modules/electron/dist/chrome-sandbox"

if [ -e "$sandbox_bin" ] && [ "$(stat -c '%U:%a' "$sandbox_bin" 2>/dev/null)" != "root:4755" ]; then
  echo "make: $sandbox_bin is not root-owned/4755; running with ELECTRON_DISABLE_SANDBOX=1"
  ELECTRON_DISABLE_SANDBOX=1 npm run "$npm_script"
else
  npm run "$npm_script"
fi
