import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiDefault } from "./pi-config";

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

  it("returns null when there is no .pi config at all", () => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    expect(resolvePiDefault(home, emptyCwd)).toBeNull();
  });

  it("resolves a known provider (e.g. openrouter) from settings.json + auth.json", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "openrouter", defaultModel: "openai/gpt-5.4-mini" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-test-key" } }),
    );

    const resolved = resolvePiDefault(home, emptyCwd);

    expect(resolved).toEqual({
      apiKey: "sk-or-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openai/gpt-5.4-mini",
      label: "openrouter/openai/gpt-5.4-mini",
    });
  });

  it("falls back to a custom OpenAI-compatible provider from models.json when the default provider has no usable key", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "github-copilot" }),
    );
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ "github-copilot": { type: "oauth" } }),
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

    const resolved = resolvePiDefault(home, emptyCwd);

    expect(resolved).toEqual({
      apiKey: "llm7-test-token",
      baseUrl: "https://api.llm7.io/v1",
      model: "gpt-oss-20b",
      label: "llm7/gpt-oss-20b",
    });

    delete process.env.LLM7_TOKEN_TEST;
  });

  it("respects defaultModel from settings.json when the provider is a custom models.json provider with multiple models", () => {
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

    const resolved = resolvePiDefault(home, emptyCwd);

    expect(resolved).toEqual({
      apiKey: "llm7-minimax-token",
      baseUrl: "https://api.llm7.io/v1",
      model: "minimax-m2.7",
      label: "llm7/minimax-m2.7",
    });

    delete process.env.LLM7_TOKEN_MINIMAX_TEST;
  });

  it("falls back to the provider's first model when defaultModel is not in that provider's model list", () => {
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

    const resolved = resolvePiDefault(home, emptyCwd);

    expect(resolved?.model).toBe("gpt-oss:20b");

    delete process.env.LLM7_TOKEN_FALLBACK_TEST;
  });

  it("returns null when a custom provider's referenced env var is unset", () => {
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

    expect(resolvePiDefault(home, emptyCwd)).toBeNull();
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

    it("prefers a project-local .pi/agent over the global one", () => {
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "openrouter", defaultModel: "openai/gpt-5.4-mini" }),
      );
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-global-key" } }),
      );

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

      const resolved = resolvePiDefault(home, cwd);

      expect(resolved).toEqual({
        apiKey: "llm7-project-token",
        baseUrl: "https://api.llm7.io/v1",
        model: "minimax-m2.7",
        label: "llm7/minimax-m2.7",
      });

      delete process.env.LLM7_TOKEN_PROJECT_TEST;
    });

    it("falls back to the global .pi/agent when the project-local one has nothing usable", () => {
      fs.rmSync(projectAgentDir, { recursive: true, force: true });

      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "openrouter", defaultModel: "openai/gpt-5.4-mini" }),
      );
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-global-key" } }),
      );

      const resolved = resolvePiDefault(home, cwd);

      expect(resolved).toEqual({
        apiKey: "sk-or-global-key",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5.4-mini",
        label: "openrouter/openai/gpt-5.4-mini",
      });
    });
  });
});
