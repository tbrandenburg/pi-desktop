// @ts-check
/**
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "npm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // src/main/index.ts and src/main/windows.ts are intentionally excluded:
  // thin Electron bootstrap/window-construction glue (app.whenReady/app.on
  // wiring, BrowserWindow constructor) with no real branching logic to
  // mutate. Per AGENTS.md lessons #16/#17, this is validated via real
  // packaged-app CDP verification (scripts/cdp-drive.ts), not unit tests -
  // unit-testing it would require mocking Electron's app/BrowserWindow APIs
  // wholesale just to hit a coverage number (see issue #70).
  // src/main/agent/test-support/real-agent-core-loaders.ts is intentionally
  // excluded: a test-support re-export helper that trivially forwards real
  // @earendil-works/pi-agent-core symbols via a normal static import (so
  // Vitest's ESM-aware transform can load them directly), with no
  // independent branching logic of its own to mutate. Testing it would mean
  // mocking @earendil-works/pi-agent-core just to assert the wrapper calls
  // through, which defeats its whole purpose - letting tests exercise the
  // REAL, unmocked library. Its real branching logic lives in, and is
  // tested via, the code that consumes AgentCoreLoaders (see issue #223).
  // src/main/agent/test-support/real-coding-agent-loaders.ts is intentionally
  // excluded for the identical reason: a test-support re-export helper that
  // trivially forwards real @earendil-works/pi-coding-agent symbols via a
  // normal static import, with no independent branching logic of its own to
  // mutate. Testing it would mean mocking @earendil-works/pi-coding-agent
  // just to assert the wrapper calls through, which defeats its whole
  // purpose - letting tests exercise the REAL, unmocked library. Its real
  // branching logic lives in, and is tested via, the code that consumes
  // CodingAgentLoaders (see issue #269).
  mutate: [
    "src/**/*.ts",
    "src/**/*.tsx",
    "!src/**/*.test.*",
    "!src/main/index.ts",
    "!src/main/windows.ts",
    "!src/main/agent/test-support/real-agent-core-loaders.ts",
    "!src/main/agent/test-support/real-coding-agent-loaders.ts",
  ],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  thresholds: {
    high: 80,
    low: 60,
    // No baseline mutation score exists yet (only 8-9 test files). Never
    // hard-fail CI on a low score until a real baseline is established -
    // matches this repo's warn-first coverage philosophy (see
    // vitest.config.ts's coverage.thresholds comment).
    break: null,
  },
};
