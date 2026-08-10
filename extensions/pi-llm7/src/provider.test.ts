import { describe, expect, it } from "vitest";
import { LLM7_MODELS, LLM7_BASE_URL, LLM7_PROVIDER_ID } from "./models.js";
import { ANONYMOUS_API_KEY, buildLlm7ProviderConfig, resolveApiKey } from "./provider.js";

describe("resolveApiKey", () => {
  it("never resolves to an empty key when nothing is configured", () => {
    const key = resolveApiKey({});

    expect(key).toBe("anonymous");
    expect(key.length).toBeGreaterThan(0);
  });

  it("falls back to the placeholder for empty and whitespace-only env values", () => {
    expect(resolveApiKey({ LLM7_API_KEY: "" })).toBe("anonymous");
    expect(resolveApiKey({ LLM7_API_KEY: "   " })).toBe("anonymous");
    expect(resolveApiKey({ LLM7_API_KEY: undefined })).toBe("anonymous");
  });

  it("uses a real configured key instead of the placeholder", () => {
    expect(resolveApiKey({ LLM7_API_KEY: "sk-real-token" })).toBe("sk-real-token");
    expect(resolveApiKey({ LLM7_API_KEY: "  sk-padded  " })).toBe("sk-padded");
  });
});

describe("LLM7_MODELS", () => {
  it("exposes exactly the two free selectors", () => {
    expect(LLM7_MODELS.map((m) => m.id)).toEqual(["default", "fast"]);
    expect(LLM7_MODELS.map((m) => m.name)).toEqual(["LLM7 Default", "LLM7 Fast"]);
  });

  it("marks both selectors as free with a 32K context window", () => {
    for (const model of LLM7_MODELS) {
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(model.contextWindow).toBe(128000);
      expect(model.maxTokens).toBe(4096);
    }
  });

  it("does not expose the paid pro selector", () => {
    expect(LLM7_MODELS.some((m) => m.id === "pro")).toBe(false);
    expect(LLM7_MODELS).toHaveLength(2);
  });
});

describe("buildLlm7ProviderConfig", () => {
  it("builds an openai-completions config with a non-empty key when unconfigured", () => {
    const config = buildLlm7ProviderConfig({});

    expect(config.apiKey).toBe(ANONYMOUS_API_KEY);
    expect(config.api).toBe("openai-completions");
    expect(config.baseUrl).toBe("https://api.llm7.io/v1");
  });

  it("carries the real key and the full catalog through", () => {
    const config = buildLlm7ProviderConfig({ LLM7_API_KEY: "sk-real-token" });

    expect(config.apiKey).toBe("sk-real-token");
    expect(config.models.map((m) => m.id)).toEqual(["default", "fast"]);
  });

  it("targets the collision-free provider id and base url constants", () => {
    expect(LLM7_PROVIDER_ID).toBe("llm7-free");
    expect(LLM7_BASE_URL).toBe("https://api.llm7.io/v1");
  });
});
