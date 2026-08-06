#!/usr/bin/env node
// Fails CI if @earendil-works/pi-ai, @earendil-works/pi-agent-core, and
// @earendil-works/pi-coding-agent in package.json don't share the same
// major.minor line. These three packages are released in lockstep upstream
// (verified against real npm tarballs -- pi-coding-agent@0.83.0 itself
// depends on pi-ai@^0.83.0 and pi-agent-core@^0.83.0); letting them drift
// apart in our own package.json risks depending on an unsupported
// cross-version combination that upstream never tests together.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
];

function majorMinor(range) {
  const match = /(\d+)\.(\d+)\.\d+/.exec(range);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

function main() {
  const rootDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  const pkgPath = path.join(rootDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const lines = PACKAGES.map((name) => {
    const range = deps[name];
    if (!range) return { name, range: undefined, line: null };
    return { name, range, line: majorMinor(range) };
  });

  const missing = lines.filter((entry) => !entry.range);
  if (missing.length > 0) {
    console.error(
      `check-pi-lockstep: missing dependency declaration(s) for: ${missing.map((m) => m.name).join(", ")}`,
    );
    process.exit(1);
  }

  const invalid = lines.filter((entry) => !entry.line);
  if (invalid.length > 0) {
    console.error(
      `check-pi-lockstep: could not parse a major.minor version from: ${invalid
        .map((entry) => `${entry.name}@${entry.range}`)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const distinctLines = new Set(lines.map((entry) => entry.line));
  if (distinctLines.size > 1) {
    console.error("check-pi-lockstep: pi-ai / pi-agent-core / pi-coding-agent are out of lockstep:");
    for (const entry of lines) {
      console.error(`  ${entry.name}: ${entry.range} (${entry.line}.x)`);
    }
    console.error("These three packages must share the same major.minor line.");
    process.exit(1);
  }

  console.log(`check-pi-lockstep: OK (${[...distinctLines][0]}.x across all three packages)`);
}

main();
