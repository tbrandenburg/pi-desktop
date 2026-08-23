import { describe, expect, it } from "vitest";
import {
  buildExhaustionError,
  resolveTranscriptionChain,
  resolveUnderstandingChain,
  runChain,
  type AudioCandidate,
} from "./audio-resolution.js";
import type { AudioToolResult } from "./audio.js";
import type { MinimalExtensionContext, RegistryModel } from "./index.js";
import { findModelByNameHint } from "./index.js";

const TRANSCRIBE_MODEL_ENV = "MULTIMEDIA_TRANSCRIBE_MODEL";
const AUDIO_MODEL_ENV = "MULTIMEDIA_AUDIO_MODEL";
const AUDIO_API_KEY_ENV = "MULTIMEDIA_AUDIO_API_KEY";
const AUDIO_BASE_URL_ENV = "MULTIMEDIA_AUDIO_BASE_URL";

function ctxWithProviderCredential(provider: string, apiKey = "resolved-key"): MinimalExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: false }),
      getProviderAuthStatus: (p: string) => ({ configured: p === provider }),
      getApiKeyForProvider: async (p: string) => (p === provider ? apiKey : undefined),
    },
  };
}

function ctxWithNoCredentials(): MinimalExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: false }),
      getProviderAuthStatus: () => ({ configured: false }),
      getApiKeyForProvider: async () => undefined,
    },
  };
}

describe("resolveTranscriptionChain", () => {
  it("trusts an explicit env override and skips discovery entirely", async () => {
    const ctx = ctxWithProviderCredential("openai", "should-not-be-used");
    const env = { [TRANSCRIBE_MODEL_ENV]: "custom-transcribe", [AUDIO_API_KEY_ENV]: "env-key" };

    const chain = await resolveTranscriptionChain(ctx, env, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ provider: "env", model: "custom-transcribe", apiKey: "env-key", source: "env-override" });
  });

  it("builds resolved candidates only for the provider with an actual credential (issue #243 regression: OpenRouter-only)", async () => {
    const ctx = ctxWithProviderCredential("openrouter", "openrouter-key");

    const chain = await resolveTranscriptionChain(ctx, {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    const openai = chain.filter((c) => c.provider === "openai");
    const openrouter = chain.filter((c) => c.provider === "openrouter");
    const groq = chain.filter((c) => c.provider === "groq");

    expect(openai).toEqual([{ provider: "openai", model: "gpt-4o-mini-transcribe", source: "registry-credential", unresolvedReason: "no-credential" }]);
    expect(groq).toEqual([{ provider: "groq", model: "whisper-large-v3", source: "registry-credential", unresolvedReason: "no-credential" }]);
    expect(openrouter).toEqual([{ provider: "openrouter", model: "whisper-1", source: "registry-credential", apiKey: "openrouter-key", baseUrl: "https://openrouter.ai/api/v1" }]);
  });

  it("marks every provider unresolved with no-credential when nothing is configured", async () => {
    const chain = await resolveTranscriptionChain(ctxWithNoCredentials(), {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    expect(chain.every((c) => c.unresolvedReason === "no-credential")).toBe(true);
    expect(chain.every((c) => c.apiKey === undefined)).toBe(true);
    expect(chain.length).toBeGreaterThan(0);
  });
});

describe("resolveUnderstandingChain", () => {
  const openaiModel = (id: string): RegistryModel => ({ id, name: id, api: "openai-completions", baseUrl: "https://api.openai.com/v1", provider: "openai" });

  it("trusts an explicit env override and skips discovery entirely", async () => {
    const ctx: MinimalExtensionContext = {};
    const env = { [AUDIO_MODEL_ENV]: "custom-audio-model", [AUDIO_API_KEY_ENV]: "env-key" };

    const chain = await resolveUnderstandingChain(ctx, env, AUDIO_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV, findModelByNameHint);

    expect(chain).toEqual([{ provider: "env", model: "custom-audio-model", apiKey: "env-key", baseUrl: undefined, source: "env-override" }]);
  });

  it("resolves via registry hint-match against the known audio-input model list", async () => {
    const ctx: MinimalExtensionContext = {
      modelRegistry: {
        getAvailable: () => [openaiModel("openai/gpt-audio")],
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "registry-key" }),
      },
    };

    const chain = await resolveUnderstandingChain(ctx, {}, AUDIO_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV, findModelByNameHint);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ model: "openai/gpt-audio", apiKey: "registry-key", source: "registry-hint" });
  });

  it("returns a single unresolved candidate when no registry model matches", async () => {
    const ctx: MinimalExtensionContext = {
      modelRegistry: { getAvailable: () => [openaiModel("claude-sonnet-5")], getApiKeyAndHeaders: async () => ({ ok: false }) },
    };

    const chain = await resolveUnderstandingChain(ctx, {}, AUDIO_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV, findModelByNameHint);

    expect(chain).toHaveLength(1);
    expect(chain[0].unresolvedReason).toBe("no-model-match");
  });
});

function okResult(text: string): AudioToolResult {
  return { isError: false, content: [{ type: "text", text }] };
}

function errorResult(status: number | undefined, text: string): AudioToolResult {
  return { isError: true, status, content: [{ type: "text", text }] };
}

describe("runChain", () => {
  it("stops at the first successful candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(c.model);
      return okResult(`success from ${c.model}`);
    };

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "success", result: okResult("success from a") });
    expect(calls).toEqual(["a"]); // never called the second candidate
  });

  it("skips unresolved candidates without invoking call()", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", unresolvedReason: "no-credential" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(c.model);
      return okResult("ok");
    };

    const outcome = await runChain("test", candidates, call);

    expect(calls).toEqual(["b"]);
    expect(outcome.kind).toBe("success");
  });

  it("treats a 400 model-not-found-shaped failure as skippable and tries the next candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "bad-model", source: "registry-credential", apiKey: "k1" },
      { provider: "openrouter", model: "whisper-1", source: "registry-credential", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) => (c.model === "bad-model" ? errorResult(400, "model does not exist") : okResult("real result"));

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "success", result: okResult("real result") });
  });

  it("surfaces a 401 immediately instead of trying the next candidate (never silently retries past a real auth error)", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", apiKey: "bad-key" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(c.model);
      return c.model === "a" ? errorResult(401, "Unauthorized") : okResult("should never be reached");
    };

    const outcome = await runChain("test", candidates, call);

    expect(calls).toEqual(["a"]); // second candidate never attempted
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.result.status).toBe(401);
      expect(outcome.result.content[0].text).toContain("Unauthorized");
      expect(outcome.result.content[0].text).toContain("openrouter/b"); // names the skipped remaining candidate
    }
  });

  it("surfaces a 429 immediately instead of trying the next candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) => (c.model === "a" ? errorResult(429, "Too Many Requests") : okResult("unreached"));

    const outcome = await runChain("test", candidates, call);

    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") expect(outcome.result.status).toBe(429);
  });

  it("surfaces a network failure (no status) immediately instead of trying the next candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) => (c.model === "a" ? errorResult(undefined, "network error") : okResult("unreached"));

    const outcome = await runChain("test", candidates, call);

    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") expect(outcome.result.status).toBeUndefined();
  });

  it("returns kind:'exhausted' with every skip reason when every candidate is unresolved", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", unresolvedReason: "no-credential" },
      { provider: "groq", model: "b", source: "registry-credential", unresolvedReason: "no-credential" },
    ];
    const call = async () => okResult("should never be reached");

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "exhausted", reasons: ["openai (no-credential)", "groq (no-credential)"] });
  });

  it("invokes the injected logger once per candidate, never calling console directly", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", unresolvedReason: "no-credential" },
      { provider: "openrouter", model: "b", source: "registry-credential", apiKey: "k2" },
    ];
    const lines: string[] = [];
    const call = async () => okResult("ok");

    await runChain("transcription", candidates, call, (line) => lines.push(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("chain=transcription candidate=1/2 provider=openai model=a result=skip reason=no-credential");
    expect(lines[1]).toContain("chain=transcription candidate=2/2 provider=openrouter model=b result=success");
  });
});

describe("buildExhaustionError", () => {
  it("names each tried reason and gives clear configuration guidance", () => {
    const result = buildExhaustionError(["openai (no-credential)", "openrouter (no transcription-capable model configured)"]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("openai (no-credential)");
    expect(result.content[0].text).toContain("openrouter (no transcription-capable model configured)");
    expect(result.content[0].text).toContain("MULTIMEDIA_AUDIO_API_KEY");
  });
});
