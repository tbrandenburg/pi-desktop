import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiDefault, listConfiguredModels } from "./pi-config";
import { realModelsLoaders } from "./test-support/real-models-loaders";

describe("resolvePiDefault", () => {
  let home: string;
  let agentDir: string;
  // resolvePiDefault also checks a project-local `<cwd>/.pi/agent`. Point cwd
  // at an empty, isolated directory (never the real repo cwd) so these tests
  // only exercise the global `~/.pi/agent` fallback in isolation.
  let emptyCwd: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-home-"));
    agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-empty-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(emptyCwd, { recursive: true, force: true });
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

  it("resolves a custom anthropic-messages provider from models.json (non-openai API)", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic-custom", defaultModel: "claude-opus" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "anthropic-custom": {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            apiKey: "$ANTHROPIC_TOKEN_TEST",
            models: [{ id: "claude-opus" }],
          },
        },
      }),
    );
    process.env.ANTHROPIC_TOKEN_TEST = "anthropic-test-token";

    const resolved = await resolvePiDefault(home, emptyCwd, realModelsLoaders);

    expect(resolved).toEqual({
      apiKey: "anthropic-test-token",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus",
      label: "anthropic-custom/claude-opus",
    });

    delete process.env.ANTHROPIC_TOKEN_TEST;
  });

  it("resolves a custom google-generative-ai provider from models.json", async () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "google-custom", defaultModel: "gemini-pro" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "google-custom": {
            baseUrl: "https://generativelanguage.googleapis.com",
            api: "google-generative-ai",
            apiKey: "$GOOGLE_TOKEN_TEST",
            models: [{ id: "gemini-pro" }],
          },
        },
      }),
    );
    process.env.GOOGLE_TOKEN_TEST = "google-test-token";

    const resolved = await resolvePiDefault(home, emptyCwd, realModelsLoaders);

    expect(resolved).toEqual({
      apiKey: "google-test-token",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-pro",
      label: "google-custom/gemini-pro",
    });

    delete process.env.GOOGLE_TOKEN_TEST;
  });

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

  describe("project-local .pi/agent", () => {
    let cwd: string;
    let projectAgentDir: string;

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-cwd-"));
      projectAgentDir = path.join(cwd, ".pi", "agent");
      fs.mkdirSync(projectAgentDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true });
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

      const resolved = await resolvePiDefault(home, cwd, realModelsLoaders);

      expect(resolved).toEqual({
        apiKey: "llm7-project-token",
        baseUrl: "https://api.llm7.io/v1",
        model: "minimax-m2.7",
        label: "llm7/minimax-m2.7",
      });

      delete process.env.GLOBAL_TOKEN_TEST;
      delete process.env.LLM7_TOKEN_PROJECT_TEST;
    });

    it("falls back to the global .pi/agent when the project-local one has nothing usable", async () => {
      fs.rmSync(projectAgentDir, { recursive: true, force: true });

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
              apiKey: "$LLM7_TOKEN_GLOBAL_FALLBACK_TEST",
              models: [{ id: "gpt-oss-20b" }],
            },
          },
        }),
      );
      process.env.LLM7_TOKEN_GLOBAL_FALLBACK_TEST = "llm7-global-token";

      const resolved = await resolvePiDefault(home, cwd, realModelsLoaders);

      expect(resolved).toEqual({
        apiKey: "llm7-global-token",
        baseUrl: "https://api.llm7.io/v1",
        model: "gpt-oss-20b",
        label: "llm7/gpt-oss-20b",
      });

      delete process.env.LLM7_TOKEN_GLOBAL_FALLBACK_TEST;
    });

    it("upserts a same-id provider by id: project-local overrides the global provider's own fields", async () => {
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "shared-id", defaultModel: "global-model" }),
      );
      fs.writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "shared-id": {
              baseUrl: "https://global.example.com/v1",
              api: "openai-completions",
              apiKey: "$SHARED_ID_GLOBAL_TEST",
              models: [{ id: "global-model" }],
            },
          },
        }),
      );
      process.env.SHARED_ID_GLOBAL_TEST = "global-shared-token";

      fs.writeFileSync(
        path.join(projectAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "shared-id", defaultModel: "project-model" }),
      );
      fs.writeFileSync(
        path.join(projectAgentDir, "models.json"),
        JSON.stringify({
          providers: {
            "shared-id": {
              baseUrl: "https://project.example.com/v1",
              api: "openai-completions",
              apiKey: "$SHARED_ID_PROJECT_TEST",
              models: [{ id: "project-model" }],
            },
          },
        }),
      );
      process.env.SHARED_ID_PROJECT_TEST = "project-shared-token";

      const resolved = await resolvePiDefault(home, cwd, realModelsLoaders);

      expect(resolved).toEqual({
        apiKey: "project-shared-token",
        baseUrl: "https://project.example.com/v1",
        model: "project-model",
        label: "shared-id/project-model",
      });

      delete process.env.SHARED_ID_GLOBAL_TEST;
      delete process.env.SHARED_ID_PROJECT_TEST;
    });
  });
});

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
    await expect(listConfiguredModels(home, emptyCwd, realModelsLoaders)).resolves.toEqual([]);
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

    const models = await listConfiguredModels(home, emptyCwd, realModelsLoaders);

    expect(models).toEqual(
      expect.arrayContaining([
        { id: "gpt-oss-20b", label: "llm7/gpt-oss-20b" },
        { id: "minimax-m2.7", label: "llm7/minimax-m2.7" },
        { id: "claude-opus", label: "anthropic-custom/claude-opus" },
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

    await expect(listConfiguredModels(home, emptyCwd, realModelsLoaders)).resolves.toEqual([]);
  });
});
