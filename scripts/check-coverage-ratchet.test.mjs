import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "check-coverage-ratchet.sh");

async function runFixture(statements, baseline = "75") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-ratchet-"));
  try {
    await writeFile(path.join(directory, ".coverage-baseline"), `${baseline}\n`);
    await mkdir(path.join(directory, "coverage"));
    await writeFile(
      path.join(directory, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { statements } }),
    );
    return spawnSync("bash", [script], {
      cwd: directory,
      encoding: "utf8",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("check-coverage-ratchet.sh", () => {
  it("passes valid numeric statement coverage", async () => {
    const valid = await runFixture({ total: 100, covered: 76, pct: 76 });
    expect(valid.status).toBe(0);
    expect(valid.stdout).toMatch(/coverage improved \(75% -> 76%\); baseline unchanged/);
  });

  it("rejects invalid statement coverage summaries", async () => {
    for (const [label, statements] of [
      ["Unknown", { total: 100, covered: 0, pct: "Unknown" }],
      ["empty", { total: 100, covered: 0 }],
      ["zero-total", { total: 0, covered: 0, pct: 0 }],
      ["out-of-range", { total: 100, covered: 100, pct: 101 }],
    ]) {
      const result = await runFixture(statements);
      expect(result.status, `${label} coverage fails`).not.toBe(0);
      expect(result.stderr, `${label} reports a clear validation error`).toMatch(
        /invalid statement coverage \(expected a nonzero total and a percentage from 0 to 100\)/,
      );
    }
  });

  it("preserves the missing-baseline error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-ratchet-missing-"));
    try {
      await mkdir(path.join(directory, "coverage"));
      await writeFile(
        path.join(directory, "coverage", "coverage-summary.json"),
        JSON.stringify({ total: { statements: { total: 1, pct: 100 } } }),
      );
      const missingBaseline = spawnSync("bash", [script], {
        cwd: directory,
        encoding: "utf8",
      });
      expect(missingBaseline.status).not.toBe(0);
      expect(missingBaseline.stderr).toMatch(/\.coverage-baseline not found/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
