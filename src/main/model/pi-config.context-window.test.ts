import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConfiguredModels } from "./pi-config";
import { realModelsLoaders } from "./test-support/real-models-loaders";

/**
 * Regression test for issue #178: `toModelInfos()` must copy the upstream
 * `Model`'s real `contextWindow`/`maxTokens` fields onto the mapped
 * `ModelInfo`, for both custom `models.json` providers and the app's own
 * `settings.json`-configured provider. Values here are the real, independent
 * defaults `@earendil-works/pi-ai` assigns a custom-provider model with no
 * explicit `contextWindow`/`maxTokens` override (verified once against the
 * real library, not derived from the code under test).
 */
describe("toModelInfos context window mapping (issue #178)", () => {
  let home: string;
  let agentDir: string;
  let emptyCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-home-ctxwin-"));
    agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-empty-cwd-ctxwin-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  });

  it("populates contextWindow and maxOutputTokens for a custom models.json provider", async () => {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_CTXWIN_TEST",
            models: [{ id: "gpt-oss-20b" }],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_CTXWIN_TEST = "llm7-ctxwin-token";

    const models = await listConfiguredModels(home, emptyCwd, undefined, realModelsLoaders);

    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(128000);
    expect(models[0]?.maxOutputTokens).toBe(16384);

    delete process.env.LLM7_TOKEN_CTXWIN_TEST;
  });

  it("populates contextWindow and maxOutputTokens for the app's own settings.json-configured model", async () => {
    const models = await listConfiguredModels(
      home,
      emptyCwd,
      { apiKey: "sk-app-only-ctxwin", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );

    expect(models).toHaveLength(1);
    expect(models[0]?.contextWindow).toBe(128000);
    expect(models[0]?.maxOutputTokens).toBe(16384);
  });
});
