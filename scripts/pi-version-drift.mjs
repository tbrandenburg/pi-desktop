#!/usr/bin/env node
// Checks whether the three lockstep @earendil-works/pi-* packages declared in
// package.json are behind their latest published npm versions, and upserts a
// single labeled GitHub issue when a minor or major bump is available.
//
// These three packages are released in lockstep upstream (see
// scripts/check-pi-lockstep.mjs), so Dependabot deliberately ignores them
// (.github/dependabot.yml) and this check reports drift as an informational
// issue instead of an auto-generated PR.
//
// Usage:
//   node scripts/pi-version-drift.mjs [--dry-run]
//
// Environment:
//   GH_REPO   "owner/repo" slug passed to `gh` (falls back to gh's own repo
//             detection when unset).
//   RUN_URL   optional link to the workflow run, included in the issue body.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const LABEL = "pi-version-drift";
export const ISSUE_TITLE = "pi-* lockstep version drift: upstream release available";

// Same list, same order as scripts/check-pi-lockstep.mjs.
export const PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
];

/**
 * Extracts a `{major, minor, patch}` triple from a semver range or version.
 * Mirrors check-pi-lockstep.mjs's lenient range parsing (`^0.83.0` -> 0.83.0).
 * @param {string|undefined} range
 * @returns {{major: number, minor: number, patch: number}|null}
 */
export function parseVersion(range) {
  if (typeof range !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Classifies the drift between a declared version and the latest published one.
 * @param {string|undefined} current
 * @param {string|undefined} latest
 * @returns {"none"|"patch"|"minor"|"major"|"unknown"}
 */
export function classifyDrift(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return "unknown";
  if (b.major > a.major) return "major";
  if (b.major < a.major) return "none";
  if (b.minor > a.minor) return "minor";
  if (b.minor < a.minor) return "none";
  if (b.patch > a.patch) return "patch";
  return "none";
}

/**
 * Decides whether the combined lockstep set warrants an issue. Only minor or
 * major drift is reportable; patch-only drift is intentionally ignored.
 * @param {Array<{name: string, current: string|undefined, latest: string|undefined}>} entries
 * @returns {{shouldReport: boolean, level: "none"|"patch"|"minor"|"major"|"unknown", entries: Array<{name: string, current: string|undefined, latest: string|undefined, drift: string}>}}
 */
export function determineDrift(entries) {
  const rank = { none: 0, patch: 1, minor: 2, major: 3 };
  const annotated = entries.map((entry) => ({
    ...entry,
    drift: classifyDrift(entry.current, entry.latest),
  }));

  if (annotated.some((entry) => entry.drift === "unknown")) {
    return { shouldReport: false, level: "unknown", entries: annotated };
  }

  let level = "none";
  for (const entry of annotated) {
    if (rank[entry.drift] > rank[level]) level = entry.drift;
  }
  return { shouldReport: level === "minor" || level === "major", level, entries: annotated };
}

/**
 * Builds the issue body for a reportable drift result.
 * @param {ReturnType<typeof determineDrift>} result
 * @param {string} [runUrl]
 * @returns {string}
 */
export function buildIssueBody(result, runUrl) {
  const lines = [
    `A **${result.level}** upstream release is available for the lockstep ` +
      "`@earendil-works/pi-*` packages.",
    "",
    "| Package | Declared | Latest | Drift |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of result.entries) {
    lines.push(`| \`${entry.name}\` | \`${entry.current ?? "?"}\` | \`${entry.latest ?? "?"}\` | ${entry.drift} |`);
  }
  lines.push(
    "",
    "These three packages must be bumped together (see `scripts/check-pi-lockstep.mjs`)",
    "and require real packaged-app verification before merging.",
  );
  for (const entry of result.entries) {
    lines.push(`- https://www.npmjs.com/package/${entry.name}`);
  }
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  lines.push("", "_Filed automatically by `scripts/pi-version-drift.mjs`._");
  return lines.join("\n");
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function ghArgs(extra, repo) {
  return repo ? [...extra, "--repo", repo] : extra;
}

/**
 * Finds the open drift issue, if any.
 * @param {{repo?: string, run?: typeof execFileSync}} opts
 * @returns {number|null}
 */
export function findExistingIssue(opts = {}) {
  const run = opts.run ?? defaultRun;
  const out = run(
    "gh",
    ghArgs(
      ["issue", "list", "--label", LABEL, "--state", "open", "--json", "number,title"],
      opts.repo,
    ),
  );
  const results = JSON.parse(out || "[]");
  const match = results.find((r) => r.title === ISSUE_TITLE);
  return match ? match.number : null;
}

/**
 * Creates the drift issue or comments on the existing one (upsert, never
 * duplicate).
 * @param {ReturnType<typeof determineDrift>} result
 * @param {{repo?: string, runUrl?: string, dryRun?: boolean, run?: typeof execFileSync}} opts
 */
export function syncIssue(result, opts = {}) {
  const run = opts.run ?? defaultRun;
  const dryRun = opts.dryRun ?? false;
  const body = buildIssueBody(result, opts.runUrl);
  let existing = null;
  try {
    existing = findExistingIssue({ repo: opts.repo, run });
  } catch (err) {
    // In --dry-run, `gh` may be unavailable/unauthenticated; that must not
    // mask the real drift result. In a real run it is a genuine failure.
    if (!dryRun) throw err;
    console.error(`Warning: could not query existing issues (${err.message}); assuming none.`);
  }

  if (existing) {
    if (!dryRun) {
      run("gh", ghArgs(["issue", "comment", String(existing), "--body", body], opts.repo));
    }
    return { action: "commented", issue: existing };
  }

  if (dryRun) return { action: "created", url: "(dry-run)" };

  const baseArgs = ["issue", "create", "--title", ISSUE_TITLE, "--body", body];
  try {
    const out = run("gh", ghArgs([...baseArgs, "--label", LABEL], opts.repo));
    return { action: "created", url: out.trim() };
  } catch (err) {
    // Label problems must never prevent the issue itself from being filed.
    console.error(
      `Warning: failed to create issue with label "${LABEL}" (${err.message}); retrying without a label.`,
    );
    const out = run("gh", ghArgs(baseArgs, opts.repo));
    return { action: "created", url: out.trim() };
  }
}

/**
 * Reads the declared pi-* ranges from package.json.
 * @param {string} pkgPath
 * @returns {Array<{name: string, current: string|undefined}>}
 */
export function readDeclaredVersions(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return PACKAGES.map((name) => ({ name, current: deps[name] }));
}

async function fetchLatest(name) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (!res.ok) {
    throw new Error(`registry returned HTTP ${res.status} for ${name}`);
  }
  const data = await res.json();
  const latest = data?.["dist-tags"]?.latest;
  if (!latest) throw new Error(`registry response for ${name} has no dist-tags.latest`);
  return latest;
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const declared = readDeclaredVersions(path.join(rootDir, "package.json"));

  const entries = [];
  for (const entry of declared) {
    entries.push({ ...entry, latest: await fetchLatest(entry.name) });
  }

  const result = determineDrift(entries);
  console.log(JSON.stringify({ level: result.level, entries: result.entries }, null, 2));

  if (!result.shouldReport) {
    console.log(`pi-version-drift: no minor/major drift (level: ${result.level}); no issue filed.`);
    return;
  }

  const sync = syncIssue(result, {
    repo: process.env.GH_REPO,
    runUrl: process.env.RUN_URL,
    dryRun: opts.dryRun,
  });
  console.log(JSON.stringify(sync, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    // A transient registry failure must surface loudly rather than silently
    // reporting "no drift".
    console.error(`pi-version-drift: ${err.message}`);
    process.exitCode = 1;
  });
}
