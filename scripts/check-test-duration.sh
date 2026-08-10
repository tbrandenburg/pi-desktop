#!/usr/bin/env bash
# Duration-budget check for the test suite (see issues #185, #197).
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
# Each breach is classified as "soft" (over the threshold above) or "hard"
# (over ~3x that threshold, or 2x the total-suite threshold). Soft breaches
# remain warn-only, exactly as before (#185): they never fail the build,
# only emit `::warning::` annotations / job-summary lines. A HARD breach is
# a genuine regression signal: this script exits non-zero if any hard
# breach exists, regardless of vitest's own exit code.
#
# When running as a real PR CI job (GITHUB_EVENT_NAME=pull_request and a
# usable `gh` CLI + GH_TOKEN), any soft/hard warning also gets posted (or,
# on repeat runs for the same PR, updated in place via a hidden HTML
# comment marker) as a PR comment mentioning $REPO_ADMIN_HANDLE (default
# @tbrandenburg) so it can't be missed. This step is fully gated off for
# local runs: a plain `make test` with no GITHUB_ACTIONS/GH_TOKEN/gh never
# attempts to post anything.
#
# The suite's own pass/fail exit status is preserved and combined with the
# hard-breach status (either one failing means this script exits non-zero),
# so callers (e.g. `make test`) can rely on it.

set -uo pipefail

LOCAL_TOTAL_THRESHOLD_MS=90000
CI_TOTAL_THRESHOLD_MS=150000
NODE_FILE_THRESHOLD_MS=1000
JSDOM_FILE_THRESHOLD_MS=5000
# Hard ceiling: ~3x the soft per-file threshold, 2x the total-suite one.
HARD_MULTIPLIER_FILE=3
HARD_MULTIPLIER_TOTAL=2

REPO_ADMIN_HANDLE="${REPO_ADMIN_HANDLE:-@tbrandenburg}"
PR_COMMENT_MARKER="<!-- test-duration-check -->"

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
const hardMultiplierFile = Number(process.argv[6]);
const hardMultiplierTotal = Number(process.argv[7]);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`check-test-duration: ERROR: could not parse vitest JSON report: ${error.message}`);
  process.exit(1);
}

const warnings = [];
let hardBreach = false;

const totalMs = Math.round((report.testResults ?? []).reduce((sum, r) => {
  const start = r.startTime ?? 0;
  const end = r.endTime ?? start;
  return sum + (end - start);
}, 0));

// Prefer the overall wall-clock span across all files when available.
const starts = (report.testResults ?? []).map((r) => r.startTime).filter((n) => typeof n === "number");
const ends = (report.testResults ?? []).map((r) => r.endTime).filter((n) => typeof n === "number");
const wallClockMs = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : totalMs;

const hardTotalThresholdMs = totalThresholdMs * hardMultiplierTotal;
if (wallClockMs > totalThresholdMs) {
  const isHard = wallClockMs > hardTotalThresholdMs;
  if (isHard) hardBreach = true;
  const level = isHard ? "HARD" : "SOFT";
  warnings.push(`[${level}] test suite took ${(wallClockMs / 1000).toFixed(1)}s (${envLabel} threshold: ${(totalThresholdMs / 1000).toFixed(0)}s)`);
}

for (const result of report.testResults ?? []) {
  const name = result.name ?? "unknown";
  const start = result.startTime ?? 0;
  const end = result.endTime ?? start;
  const durationMs = end - start;
  const isJsdom = name.endsWith(".tsx");
  const threshold = isJsdom ? jsdomThresholdMs : nodeThresholdMs;
  const hardThreshold = threshold * hardMultiplierFile;
  const kind = isJsdom ? "jsdom" : "node";
  if (durationMs > threshold) {
    const isHard = durationMs > hardThreshold;
    if (isHard) hardBreach = true;
    const level = isHard ? "HARD" : "SOFT";
    warnings.push(`[${level}] ${name} (${kind}) took ${(durationMs / 1000).toFixed(2)}s (threshold: ${(threshold / 1000).toFixed(1)}s)`);
  }
}

for (const message of warnings) {
  console.log(`__WARN__${message}`);
}

if (warnings.length === 0) {
  console.log("check-test-duration: no duration thresholds exceeded");
}

if (hardBreach) {
  console.log("__HARD_BREACH__");
}
' "$report_file" "$env_label" "$total_threshold_ms" "$NODE_FILE_THRESHOLD_MS" "$JSDOM_FILE_THRESHOLD_MS" "$HARD_MULTIPLIER_FILE" "$HARD_MULTIPLIER_TOTAL" > /tmp/check-test-duration.out
node_status=$?

if [ "$node_status" -ne 0 ]; then
  cat /tmp/check-test-duration.out >&2
  rm -f /tmp/check-test-duration.out
  exit 1
fi

hard_breach=0
warning_messages=()
while IFS= read -r line; do
  if [[ "$line" == __WARN__* ]]; then
    message="${line#__WARN__}"
    warning_messages+=("$message")
    warn "$message"
  elif [[ "$line" == __HARD_BREACH__ ]]; then
    hard_breach=1
  else
    echo "$line"
  fi
done < /tmp/check-test-duration.out
rm -f /tmp/check-test-duration.out

if [ "$hard_breach" -eq 1 ]; then
  echo "check-test-duration: ERROR: at least one HARD duration breach detected (see warnings above)" >&2
fi

# Post/update a loud PR comment, but only when this is a genuine PR CI job
# with a usable gh CLI. Never attempted for local runs or push-to-main runs.
if [ ${#warning_messages[@]} -gt 0 ] \
  && [ -n "${GITHUB_ACTIONS:-}" ] \
  && [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] \
  && [ -n "${GH_TOKEN:-}" ] \
  && command -v gh >/dev/null 2>&1; then

  pr_number="${PR_NUMBER:-}"
  if [ -z "$pr_number" ] && [ -n "${GITHUB_REF:-}" ]; then
    # e.g. refs/pull/123/merge
    pr_number=$(echo "$GITHUB_REF" | sed -n 's#refs/pull/\([0-9]\+\)/merge#\1#p')
  fi

  if [ -n "$pr_number" ]; then
    body_file=$(mktemp /tmp/test-duration-comment.XXXXXX.md)
    {
      echo "$PR_COMMENT_MARKER"
      echo "### ⚠️ Test duration budget warning"
      echo
      echo "$REPO_ADMIN_HANDLE the test suite exceeded its duration budget:"
      echo
      for message in "${warning_messages[@]}"; do
        echo "- $message"
      done
    } > "$body_file"

    existing_id=$(gh api "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" --paginate \
      --jq ".[] | select(.body | startswith(\"$PR_COMMENT_MARKER\")) | .id" 2>/dev/null | head -n1)

    if [ -n "$existing_id" ]; then
      gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" -F body=@"$body_file" >/dev/null 2>&1 \
        || echo "check-test-duration: WARNING: failed to update existing PR comment" >&2
    else
      gh pr comment "$pr_number" --repo "${GITHUB_REPOSITORY}" --body-file "$body_file" >/dev/null 2>&1 \
        || echo "check-test-duration: WARNING: failed to post PR comment" >&2
    fi
    rm -f "$body_file"
  fi
fi

if [ "$test_status" -ne 0 ]; then
  exit "$test_status"
fi

if [ "$hard_breach" -eq 1 ]; then
  exit 1
fi

exit 0
