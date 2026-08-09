import { describe, it, expect, vi } from "vitest";
import {
  computeFileScores,
  determineGaps,
  findExistingIssue,
  syncIssues,
  LABEL,
  LOW_THRESHOLD,
} from "./mutation-issue-sync.mjs";

function mutant(status) {
  return { status };
}

function report(files) {
  return { schemaVersion: "1", thresholds: { high: 80, low: 60 }, files };
}

describe("computeFileScores", () => {
  it("computes killed/(killed+survived+timeout+noCoverage) as a percentage", () => {
    const r = report({
      "src/a.ts": {
        language: "typescript",
        source: "",
        mutants: [mutant("Killed"), mutant("Killed"), mutant("Survived"), mutant("Survived")],
      },
    });
    const [entry] = computeFileScores(r);
    expect(entry.score).toBeCloseTo(50, 5);
    expect(entry.total).toBe(4);
  });

  it("treats Timeout as killed and CompileError/Ignored as uncounted", () => {
    const r = report({
      "src/b.ts": {
        language: "typescript",
        source: "",
        mutants: [mutant("Timeout"), mutant("Survived"), mutant("CompileError"), mutant("Ignored")],
      },
    });
    const [entry] = computeFileScores(r);
    // Only Timeout + Survived are counted -> 1/2 = 50%
    expect(entry.score).toBeCloseTo(50, 5);
    expect(entry.total).toBe(2);
  });

  it("returns null score and zero total for a file with no counted mutants", () => {
    const r = report({
      "src/c.ts": { language: "typescript", source: "", mutants: [mutant("CompileError")] },
    });
    const [entry] = computeFileScores(r);
    expect(entry.score).toBeNull();
    expect(entry.total).toBe(0);
  });
});

describe("determineGaps", () => {
  it("flags files below the threshold and skips files at or above it", () => {
    const scores = [
      { file: "weak.ts", score: 40, killed: 2, survived: 3, noCoverage: 0, total: 5 },
      { file: "strong.ts", score: 90, killed: 9, survived: 1, noCoverage: 0, total: 10 },
    ];
    const gaps = determineGaps(scores, LOW_THRESHOLD);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].file).toBe("weak.ts");
    expect(gaps[0].reason).toBe("below mutation score floor");
  });

  it("labels a file with zero kills and all no-coverage mutants distinctly", () => {
    const scores = [{ file: "new.ts", score: 0, killed: 0, survived: 0, noCoverage: 3, total: 3 }];
    const gaps = determineGaps(scores);
    expect(gaps[0].reason).toBe("new file, zero coverage");
    expect(gaps[0].score).toBe(0);
  });

  it("propagates killed/survived/noCoverage counts needed for the issue body", () => {
    const scores = [{ file: "weak.ts", score: 40, killed: 2, survived: 3, noCoverage: 1, total: 6 }];
    const [gap] = determineGaps(scores);
    expect(gap.killed).toBe(2);
    expect(gap.survived).toBe(3);
    expect(gap.noCoverage).toBe(1);
  });

  it("excludes files with zero counted mutants and sorts weakest first", () => {
    const scores = [
      { file: "no-mutants.ts", score: null, killed: 0, survived: 0, noCoverage: 0, total: 0 },
      { file: "weakest.ts", score: 10, killed: 1, survived: 9, noCoverage: 0, total: 10 },
      { file: "less-weak.ts", score: 50, killed: 5, survived: 5, noCoverage: 0, total: 10 },
    ];
    const gaps = determineGaps(scores);
    expect(gaps.map((g) => g.file)).toEqual(["weakest.ts", "less-weak.ts"]);
  });
});

describe("findExistingIssue", () => {
  it("returns the issue number on an exact title match and null otherwise", () => {
    const run = vi.fn().mockReturnValue(
      JSON.stringify([{ number: 42, title: "Weak mutation coverage: src/a.ts" }]),
    );
    const found = findExistingIssue("src/a.ts", { run });
    expect(found).toBe(42);
    expect(run).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["issue", "list", "--label", LABEL]),
    );

    const notFound = findExistingIssue("src/b.ts", { run });
    expect(notFound).toBeNull();
  });
});

describe("syncIssues", () => {
  it("creates a new issue when none exists and comments when a match is found", () => {
    const run = vi
      .fn()
      // findExistingIssue for gap 1 (no match)
      .mockReturnValueOnce("[]")
      // gh issue create for gap 1
      .mockReturnValueOnce("https://github.com/o/r/issues/1\n")
      // findExistingIssue for gap 2 (match)
      .mockReturnValueOnce(JSON.stringify([{ number: 7, title: "Weak mutation coverage: src/existing.ts" }]));

    const gaps = [
      { file: "src/new.ts", score: 10, reason: "below mutation score floor", killed: 1, survived: 9, noCoverage: 0 },
      { file: "src/existing.ts", score: 20, reason: "below mutation score floor", killed: 2, survived: 8, noCoverage: 0 },
    ];
    const result = syncIssues(gaps, { run, maxNew: 5 });

    expect(result.created).toEqual([{ file: "src/new.ts", url: "https://github.com/o/r/issues/1" }]);
    expect(result.commented).toEqual([{ file: "src/existing.ts", issue: 7 }]);
    expect(result.skipped).toEqual([]);
  });

  it("running twice against the same data creates zero duplicate issues (dedup)", () => {
    // Second run: findExistingIssue now reports a match for the file created
    // in the first run, so it must comment instead of creating again.
    const run = vi
      .fn()
      .mockReturnValueOnce(JSON.stringify([{ number: 99, title: "Weak mutation coverage: src/dup.ts" }]));
    const gaps = [{ file: "src/dup.ts", score: 5, reason: "below mutation score floor", killed: 0, survived: 19, noCoverage: 1 }];
    const result = syncIssues(gaps, { run });
    expect(result.created).toHaveLength(0);
    expect(result.commented).toEqual([{ file: "src/dup.ts", issue: 99 }]);
  });

  it("rate-limits new issue creation to maxNew and reports the rest as skipped", () => {
    const run = vi.fn((_cmd, args) => {
      if (args.includes("list")) return "[]";
      return "https://github.com/o/r/issues/1\n";
    });
    const gaps = Array.from({ length: 7 }, (_, i) => ({
      file: `src/f${i}.ts`,
      score: i,
      reason: "below mutation score floor",
      killed: 0,
      survived: 10,
      noCoverage: 0,
    }));
    const result = syncIssues(gaps, { run, maxNew: 5 });
    expect(result.created).toHaveLength(5);
    expect(result.skipped).toHaveLength(2);
    expect(result.commented).toHaveLength(0);
  });

  it("does not invoke gh in dry-run mode but still reports intended actions", () => {
    const run = vi.fn().mockReturnValue("[]");
    const gaps = [{ file: "src/dry.ts", score: 1, reason: "below mutation score floor", killed: 0, survived: 9, noCoverage: 1 }];
    const result = syncIssues(gaps, { run, dryRun: true });
    expect(result.created).toEqual([{ file: "src/dry.ts", url: "(dry-run)" }]);
    expect(run).toHaveBeenCalledTimes(1); // only the list lookup, no create
  });
});
