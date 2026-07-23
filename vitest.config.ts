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
  },
});
