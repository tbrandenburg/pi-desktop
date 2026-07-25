// @ts-check
/**
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "npm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.test.*"],
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
