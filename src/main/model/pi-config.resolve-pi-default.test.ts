import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiDefault } from "./pi-config";
import { realModelsLoaders } from "./test-support/real-models-loaders";

describe("resolvePiDefault", () => {
  let home: string;
  let agentDir: string;
  // resolvePiDefault also checks a project-local `<cwd>/.pi/agent`. Point cwd
  // at an empty, isolated directory (never the real repo cwd) so these tests
  // only exercise the global `~/.pi/agent` fallback in isolation, except the
  // dedicated project-local precedence test below, which uses `projectCwd`.
  let emptyCwd: string;
  let projectCwd: string;
  let projectAgentDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-home-"));
    agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-empty-cwd-"));
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-cwd-"));
    projectAgentDir = path.join(projectCwd, ".pi", "agent");
    fs.mkdirSync(projectAgentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
    fs.rmSync(projectCwd, { recursive: true, force: true });
  });

  it("returns null when there is no .pi config at all", async () => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    await expect(resolvePiDefault(home, emptyCwd, realModelsLoaders)).resolves.toBeNull();
  });

  it("resolves a custom openai-completions provider from models.json", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "llm7", defaultModel: "gpt-oss-20b" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_TEST",
            models: [{ id: "gpt-oss-20b" }],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_TEST = "llm7-test-token";

    const resolved = await resolvePiDefault(home, emptyCwd, realModelsLoaders);

    expect(resolved).toEqual({
      apiKey: "llm7-test-token",
      baseUrl: "https://api.llm7.io/v1",
      model: "gpt-oss-20b",
      label: "llm7/gpt-oss-20b",
    });

    delete process.env.LLM7_TOKEN_TEST;
  });

  // Note: resolveFromRegistry is API-agnostic (never branches on `api`), so
  // per-API behavior belongs in registry.test.ts, not repeated here.
  it("respects defaultModel from settings.json when the provider has multiple models", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "llm7", defaultModel: "minimax-m2.7" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_MINIMAX_TEST",
            models: [
              { id: "gpt-oss:20b" },
              { id: "codestral-latest" },
              { id: "minimax-m2.7" },
            ],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_MINIMAX_TEST = "llm7-minimax-token";

    const resolved = await resolvePiDefault(home, emptyCwd, realModelsLoaders);

    expect(resolved).toEqual({
      apiKey: "llm7-minimax-token",
      baseUrl: "https://api.llm7.io/v1",
      model: "minimax-m2.7",
      label: "llm7/minimax-m2.7",
    });

    delete process.env.LLM7_TOKEN_MINIMAX_TEST;
  });

  it("falls back to the provider's first model when defaultModel is not in that provider's model list", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "llm7", defaultModel: "does-not-exist" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_FALLBACK_TEST",
            models: [{ id: "gpt-oss:20b" }, { id: "minimax-m2.7" }],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_FALLBACK_TEST = "llm7-fallback-token";

    const resolved = await resolvePiDefault(home, emptyCwd, realModelsLoaders);

    expect(resolved?.model).toBe("gpt-oss:20b");
    expect(resolved?.label).toBe("llm7/gpt-oss:20b");

    delete process.env.LLM7_TOKEN_FALLBACK_TEST;
  });

  it("returns null when a custom provider's referenced env var is unset", async () => {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_UNSET_TEST",
            models: [{ id: "gpt-oss-20b" }],
          },
        },
      }),
    );

    await expect(resolvePiDefault(home, emptyCwd, realModelsLoaders)).resolves.toBeNull();
  });

  it("prefers a project-local .pi/agent over the global one", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "global-provider", defaultModel: "global-model" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "global-provider": {
            baseUrl: "https://global.example.com/v1",
            api: "openai-completions",
            apiKey: "$GLOBAL_TOKEN_TEST",
            models: [{ id: "global-model" }],
          },
        },
      }),
    );
    process.env.GLOBAL_TOKEN_TEST = "global-token";

    fs.writeFileSync(
      path.join(projectAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "llm7", defaultModel: "minimax-m2.7" }),
    );
    fs.writeFileSync(
      path.join(projectAgentDir, "models.json"),
      JSON.stringify({
        providers: {
          llm7: {
            baseUrl: "https://api.llm7.io/v1",
            api: "openai-completions",
            apiKey: "$LLM7_TOKEN_PROJECT_TEST",
            models: [{ id: "minimax-m2.7" }],
          },
        },
      }),
    );
    process.env.LLM7_TOKEN_PROJECT_TEST = "llm7-project-token";

    const resolved = await resolvePiDefault(home, projectCwd, realModelsLoaders);

    expect(resolved).toEqual({
      apiKey: "llm7-project-token",
      baseUrl: "https://api.llm7.io/v1",
      model: "minimax-m2.7",
      label: "llm7/minimax-m2.7",
    });

    delete process.env.GLOBAL_TOKEN_TEST;
    delete process.env.LLM7_TOKEN_PROJECT_TEST;
  });
});
