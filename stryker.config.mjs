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
  mutate: [
    "src/**/*.ts",
    "src/**/*.tsx",
    "!src/**/*.test.*",
    "!src/main/index.ts",
    "!src/main/windows.ts",
  ],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html"],
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
