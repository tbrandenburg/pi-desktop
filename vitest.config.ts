import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // pi-ai's package.json "exports" map only publishes the root entry
      // point, but the main process intentionally deep-imports the
      // CommonJS-safe API module directly (see src/main/llm/chat-service.ts).
      // Point Vite/Vitest's resolver straight at the real file so tests can
      // exercise (and mock) that exact specifier.
      "@earendil-works/pi-ai/dist/api/openai-completions.js": fileURLToPath(
        new URL(
          "./node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Only measure real application source. Without this, the v8
      // provider's default "everything touched by a loaded module" scope
      // pulls in compiled build output (dist-main/**, when it happens to
      // exist on disk from a prior `npm run build`) and dev-only tooling
      // scripts (scripts/**, stryker.config.mjs) that have no unit tests
      // and aren't application logic - both silently dilute the "All
      // files" aggregate into a meaningless number. See issue #24.
      exclude: [
        "dist-main/**",
        "dist-renderer/**",
        "scripts/**",
        "*.config.*",
        "**/*.d.ts",
      ],
      // Intentionally no `thresholds` yet: Vitest's coverage.thresholds has
      // no warn-only mode (setting it always sets exit code 1 on failure,
      // see vitest-dev/vitest packages/vitest/src/node/coverage.ts
      // `reportThresholds`/`checkThresholds`), and there is no baseline
      // branch-coverage number yet. Report-only for now; a real threshold
      // can be added once a baseline exists (see follow-up issue #24).
    },
  },
});
