#!/usr/bin/env node
// Parses a Stryker JSON mutation report (reports/mutation/mutation.json) and
// files/updates GitHub issues for files with weak mutation coverage.
//
// Implements triggers 1 (below-floor), 3 (new file / zero coverage) and 5
// (bootstrap, no baseline) from issue #181. Trigger 2 (regression vs. prior
// run) and 4 (survived-mutant spike) require baseline storage and are
// intentionally deferred as a follow-up.
//
// Usage:
//   node scripts/mutation-issue-sync.mjs [--report <path>] [--dry-run] [--max-new <n>]
//
// Environment:
//   GH_REPO   "owner/repo" slug passed to `gh` (falls back to gh's own repo
//             detection when unset).
//   RUN_URL   optional link to the workflow run, included in issue bodies.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const LABEL = "mutation-gap";
export const LOW_THRESHOLD = 60;
export const DEFAULT_MAX_NEW_ISSUES = 5;

const COUNTED_STATUSES = ["Killed", "Survived", "Timeout", "NoCoverage"];
const KILLED_STATUSES = ["Killed", "Timeout"];

/**
 * Computes a per-file mutation score summary from a Stryker JSON report.
 * @param {{files: Record<string, {mutants: {status: string}[]}>}} report
 * @returns {Array<{file: string, score: number|null, killed: number, survived: number, noCoverage: number, total: number}>}
 */
export function computeFileScores(report) {
  const files = report?.files ?? {};
  return Object.entries(files).map(([file, result]) => {
    const mutants = result?.mutants ?? [];
    const counted = mutants.filter((m) => COUNTED_STATUSES.includes(m.status));
    const killed = mutants.filter((m) => KILLED_STATUSES.includes(m.status)).length;
    const survived = mutants.filter((m) => m.status === "Survived").length;
    const noCoverage = mutants.filter((m) => m.status === "NoCoverage").length;
    const total = counted.length;
    const score = total === 0 ? null : (killed / total) * 100;
    return { file, score, killed, survived, noCoverage, total };
  });
}

/**
 * Determines which files need a tracking issue filed/updated.
 * @param {ReturnType<typeof computeFileScores>} scores
 * @param {number} lowThreshold
 * @returns {Array<{file: string, score: number, reason: string, killed: number, survived: number, noCoverage: number}>}
 */
export function determineGaps(scores, lowThreshold = LOW_THRESHOLD) {
  const gaps = [];
  for (const entry of scores) {
    if (entry.total === 0) continue; // no mutants counted (e.g. fully ignored)
    if (entry.score === null) continue;
    if (entry.score >= lowThreshold) continue;
    const reason =
      entry.killed === 0 && entry.noCoverage === entry.total
        ? "new file, zero coverage"
        : "below mutation score floor";
    gaps.push({
      file: entry.file,
      score: entry.score,
      reason,
      killed: entry.killed,
      survived: entry.survived,
      noCoverage: entry.noCoverage,
    });
  }
  // Weakest scores first, so the rate cap prioritizes the worst offenders.
  gaps.sort((a, b) => a.score - b.score);
  return gaps;
}

function issueTitle(file) {
  return `Weak mutation coverage: ${file}`;
}

function ghArgs(extra, repo) {
  return repo ? [...extra, "--repo", repo] : extra;
}

/**
 * Finds an existing open mutation-gap issue for the given file, if any.
 * @param {string} file
 * @param {{repo?: string, run?: typeof execFileSync}} opts
 * @returns {number|null} issue number, or null if none exists
 */
export function findExistingIssue(file, opts = {}) {
  const run = opts.run ?? defaultRun;
  const title = issueTitle(file);
  const out = run(
    "gh",
    ghArgs(
      [
        "issue",
        "list",
        "--label",
        LABEL,
        "--state",
        "open",
        "--search",
        `in:title "${title}"`,
        "--json",
        "number,title",
      ],
      opts.repo,
    ),
  );
  const results = JSON.parse(out || "[]");
  const match = results.find((r) => r.title === title);
  return match ? match.number : null;
}

function issueBody(entry, runUrl) {
  const lines = [
    `Mutation score for \`${entry.file}\` is **${entry.score.toFixed(1)}%** ` +
      `(${entry.reason}), below the ${LOW_THRESHOLD}% floor.`,
    "",
    `- Killed: ${entry.killed}`,
    `- Survived: ${entry.survived}`,
    `- No coverage: ${entry.noCoverage}`,
    `- Counted mutants: ${entry.killed + entry.survived + entry.noCoverage}`,
  ];
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  lines.push(
    "",
    "_Filed automatically by `scripts/mutation-issue-sync.mjs` from the weekly mutation report._",
  );
  return lines.join("\n");
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

/**
 * Syncs gaps to GitHub issues: creates a new issue per gap with no existing
 * open match (capped at maxNew), and comments on existing matches instead of
 * duplicating.
 * @param {ReturnType<typeof determineGaps>} gaps
 * @param {{repo?: string, runUrl?: string, maxNew?: number, dryRun?: boolean, run?: typeof execFileSync}} opts
 */
export function syncIssues(gaps, opts = {}) {
  const run = opts.run ?? defaultRun;
  const maxNew = opts.maxNew ?? DEFAULT_MAX_NEW_ISSUES;
  const dryRun = opts.dryRun ?? false;
  const result = { created: [], commented: [], skipped: [] };
  let newCount = 0;

  for (const entry of gaps) {
    const existing = findExistingIssue(entry.file, opts);
    if (existing) {
      const body = `Updated score: **${entry.score.toFixed(1)}%** (${entry.reason}).` +
        (opts.runUrl ? `\n\nRun: ${opts.runUrl}` : "");
      if (!dryRun) {
        run("gh", ghArgs(["issue", "comment", String(existing), "--body", body], opts.repo));
      }
      result.commented.push({ file: entry.file, issue: existing });
      continue;
    }

    if (newCount >= maxNew) {
      result.skipped.push(entry.file);
      continue;
    }

    if (!dryRun) {
      const out = run(
        "gh",
        ghArgs(
          [
            "issue",
            "create",
            "--title",
            issueTitle(entry.file),
            "--body",
            issueBody(entry, opts.runUrl),
            "--label",
            LABEL,
          ],
          opts.repo,
        ),
      );
      result.created.push({ file: entry.file, url: out.trim() });
    } else {
      result.created.push({ file: entry.file, url: "(dry-run)" });
    }
    newCount += 1;
  }

  return result;
}

function parseArgs(argv) {
  const opts = { report: "reports/mutation/mutation.json", dryRun: false, maxNew: DEFAULT_MAX_NEW_ISSUES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") opts.report = argv[++i];
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--max-new") opts.maxNew = Number(argv[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(opts.report, "utf8"));
  const scores = computeFileScores(report);
  const gaps = determineGaps(scores);
  const result = syncIssues(gaps, {
    repo: process.env.GH_REPO,
    runUrl: process.env.RUN_URL,
    maxNew: opts.maxNew,
    dryRun: opts.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
