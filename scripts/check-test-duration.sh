#!/usr/bin/env bash
# Warn-only check for test-suite duration budgets (see issue #185).
#
# Runs `vitest run --reporter=json` (capturing its JSON report to a temp
# file), then checks:
#   1. Total wall-clock duration against a threshold that differs between
#      local dev machines and CI (CI is measurably slower/noisier): 90s
#      local, 150s CI (detected via the standard `CI` env var GitHub
#      Actions sets automatically).
#   2. Per-file duration against a per-test-class threshold: jsdom
#      component tests (files with a `// @vitest-environment jsdom` pragma)
#      get a 5s budget; plain node-env unit tests get a 1s budget.
#
# Never exits non-zero purely for exceeding a threshold (warn-only, matching
# this repo's `make lint`/`scripts/check-test-ratio.sh` philosophy). Exits
# non-zero only on a genuine script error (e.g. vitest itself crashing, or
# its JSON report being unparsable). When run in CI (`GITHUB_STEP_SUMMARY`
# is set), warnings are also emitted as `::warning::` annotations and
# appended to the job summary so they're impossible to miss in the log.
#
# The suite's own pass/fail exit status is preserved and returned as this
# script's exit status, so callers (e.g. `make test`) can rely on it.

set -uo pipefail

LOCAL_TOTAL_THRESHOLD_MS=90000
CI_TOTAL_THRESHOLD_MS=150000
NODE_FILE_THRESHOLD_MS=1000
JSDOM_FILE_THRESHOLD_MS=5000

total_threshold_ms=$LOCAL_TOTAL_THRESHOLD_MS
env_label="local"
if [ -n "${CI:-}" ]; then
  total_threshold_ms=$CI_TOTAL_THRESHOLD_MS
  env_label="CI"
fi

report_file=$(mktemp /tmp/vitest-report.XXXXXX.json)
trap 'rm -f "$report_file"' EXIT

npm run test -- --reporter=json --outputFile="$report_file"
test_status=$?

if [ ! -s "$report_file" ]; then
  echo "check-test-duration: ERROR: vitest produced no JSON report at $report_file" >&2
  exit 1
fi

warn() {
  local message="$1"
  echo "WARNING: $message"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "::warning::$message"
    echo "- WARNING: $message" >> "$GITHUB_STEP_SUMMARY"
  fi
}

node --input-type=module -e '
import { readFileSync } from "node:fs";

const reportPath = process.argv[1];
const envLabel = process.argv[2];
const totalThresholdMs = Number(process.argv[3]);
const nodeThresholdMs = Number(process.argv[4]);
const jsdomThresholdMs = Number(process.argv[5]);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`check-test-duration: ERROR: could not parse vitest JSON report: ${error.message}`);
  process.exit(1);
}

const warnings = [];

const totalMs = Math.round((report.testResults ?? []).reduce((sum, r) => {
  const start = r.startTime ?? 0;
  const end = r.endTime ?? start;
  return sum + (end - start);
}, 0));

// Prefer the overall wall-clock span across all files when available.
const starts = (report.testResults ?? []).map((r) => r.startTime).filter((n) => typeof n === "number");
const ends = (report.testResults ?? []).map((r) => r.endTime).filter((n) => typeof n === "number");
const wallClockMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : totalMs;

if (wallClockMs > totalThresholdMs) {
  warnings.push(`test suite took ${(wallClockMs / 1000).toFixed(1)}s (${envLabel} threshold: ${(totalThresholdMs / 1000).toFixed(0)}s)`);
}

for (const result of report.testResults ?? []) {
  const name = result.name ?? "unknown";
  const start = result.startTime ?? 0;
  const end = result.endTime ?? start;
  const durationMs = end - start;
  const isJsdom = name.endsWith(".tsx");
  const threshold = isJsdom ? jsdomThresholdMs : nodeThresholdMs;
  const kind = isJsdom ? "jsdom" : "node";
  if (durationMs > threshold) {
    warnings.push(`${name} (${kind}) took ${(durationMs / 1000).toFixed(2)}s (threshold: ${(threshold / 1000).toFixed(1)}s)`);
  }
}

for (const message of warnings) {
  console.log(`__WARN__${message}`);
}

if (warnings.length === 0) {
  console.log("check-test-duration: no duration thresholds exceeded");
}
' "$report_file" "$env_label" "$total_threshold_ms" "$NODE_FILE_THRESHOLD_MS" "$JSDOM_FILE_THRESHOLD_MS" > /tmp/check-test-duration.out
node_status=$?

if [ "$node_status" -ne 0 ]; then
  cat /tmp/check-test-duration.out >&2
  rm -f /tmp/check-test-duration.out
  exit 1
fi

while IFS= read -r line; do
  if [[ "$line" == __WARN__* ]]; then
    warn "${line#__WARN__}"
  else
    echo "$line"
  fi
done < /tmp/check-test-duration.out
rm -f /tmp/check-test-duration.out

exit $test_status
