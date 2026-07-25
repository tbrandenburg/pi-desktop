#!/usr/bin/env bash
# Coverage ratchet: fails if current statement coverage regresses below the
# committed .coverage-baseline, and can auto-advance that baseline when
# coverage has genuinely improved.
#
# Scope decision (see issue #24): the baseline covers ALL of src/** as
# reported by vitest.config.ts's coverage.exclude (dist-main/**, scripts/**,
# config files, and *.d.ts are excluded - see that file's comment for why).
# This intentionally includes src/renderer/components/** even though those
# currently sit at 0% unit coverage - per this repo's AGENTS.md testing
# pyramid, renderer UI components are covered by Playwright E2E, not
# vitest unit tests, and are expected to stay low here. A ratchet only
# needs to prevent regression, not enforce a per-directory target, so a
# single whole-src baseline number is kept deliberately simple (KISS) rather
# than building per-directory threshold logic.
#
# Auto-advance is opt-in only (via --update), never automatic on a plain
# run: silently rewriting a committed file on every green CI run would mean
# the baseline drifts without an explicit, reviewable diff. Run with
# --update only when you've deliberately added coverage and want the new
# number committed.
#
# Usage:
#   scripts/check-coverage-ratchet.sh            # compare only, exit 1 on regression
#   scripts/check-coverage-ratchet.sh --update    # also advance the baseline on improvement

set -euo pipefail

BASELINE_FILE=".coverage-baseline"
SUMMARY_FILE="coverage/coverage-summary.json"
UPDATE=0

if [ "${1:-}" = "--update" ]; then
  UPDATE=1
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "error: $BASELINE_FILE not found. Run this from the repo root." >&2
  exit 1
fi

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "error: $SUMMARY_FILE not found. Run 'npm test -- --coverage' first." >&2
  exit 1
fi

baseline=$(tr -d '[:space:]' < "$BASELINE_FILE")
current=$(node -p "require('./$SUMMARY_FILE').total.statements.pct")

if [ -z "$baseline" ]; then
  echo "error: $BASELINE_FILE is empty." >&2
  exit 1
fi

# Compare as floats via awk (bash has no float comparison).
regressed=$(awk -v c="$current" -v b="$baseline" 'BEGIN { print (c < b) ? "1" : "0" }')
improved=$(awk -v c="$current" -v b="$baseline" 'BEGIN { print (c > b) ? "1" : "0" }')

if [ "$regressed" = "1" ]; then
  echo "FAIL: coverage regressed to ${current}% (baseline: ${baseline}%)" >&2
  exit 1
fi

if [ "$improved" = "1" ]; then
  if [ "$UPDATE" = "1" ]; then
    echo "$current" > "$BASELINE_FILE"
    echo "check-coverage-ratchet: coverage improved (${baseline}% -> ${current}%); baseline updated"
  else
    echo "check-coverage-ratchet: coverage improved (${baseline}% -> ${current}%); baseline unchanged (pass --update to advance it)"
  fi
  exit 0
fi

echo "check-coverage-ratchet: coverage at ${current}% (baseline: ${baseline}%), no regression"
exit 0
