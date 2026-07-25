import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConfiguredModels } from "./pi-config";
import { realModelsLoaders } from "./test-support/real-models-loaders";

describe("listConfiguredModels", () => {
  let home: string;
  let agentDir: string;
  let emptyCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-home-list-"));
    agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-empty-cwd-list-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
  });

  it("returns an empty list when nothing is configured", async () => {
    await expect(listConfiguredModels(home, emptyCwd, undefined, realModelsLoaders)).resolves.toEqual([]);
  });

  it("includes a model configured only via the app's own settings, with zero .pi files present", async () => {
    const models = await listConfiguredModels(
      home,
      emptyCwd,
      { apiKey: "sk-app-only", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      realModelsLoaders,
    );
    expect(models).toEqual([{ id: "app-settings/gpt-4o-mini", label: "app-settings/gpt-4o-mini" }]);
  });

  it("lists every model from every configured, credentialed provider across APIs", async () => {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_LIST_TEST",
            models: [{ id: "gpt-oss-20b" }, { id: "minimax-m2.7" }],
          },
          "anthropic-custom": {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            apiKey: "$ANTHROPIC_TOKEN_LIST_TEST",
            models: [{ id: "claude-opus" }],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_LIST_TEST = "llm7-list-token";
    process.env.ANTHROPIC_TOKEN_LIST_TEST = "anthropic-list-token";

    const models = await listConfiguredModels(home, emptyCwd, undefined, realModelsLoaders);

    expect(models).toEqual(
      expect.arrayContaining([
        { id: "llm7/gpt-oss-20b", label: "llm7/gpt-oss-20b" },
        { id: "llm7/minimax-m2.7", label: "llm7/minimax-m2.7" },
        { id: "anthropic-custom/claude-opus", label: "anthropic-custom/claude-opus" },
      ]),
    );
    expect(models).toHaveLength(3);

    delete process.env.LLM7_TOKEN_LIST_TEST;
    delete process.env.ANTHROPIC_TOKEN_LIST_TEST;
  });

  it("omits a provider whose referenced env var is unset (no usable credential)", async () => {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_MISSING_TEST",
            models: [{ id: "gpt-oss-20b" }],
          },
        },
      }),
    );

    await expect(listConfiguredModels(home, emptyCwd, undefined, realModelsLoaders)).resolves.toEqual([]);
  });
});
