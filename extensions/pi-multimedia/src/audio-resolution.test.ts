import { describe, expect, it } from "vitest";
import { buildExhaustionError, resolveAudioChain, runChain, type AudioCandidate } from "./audio-resolution.js";
import type { AudioToolResult } from "./audio.js";
import type { MinimalExtensionContext } from "./index.js";

const TRANSCRIBE_MODEL_ENV = "MULTIMEDIA_TRANSCRIBE_MODEL";
const AUDIO_API_KEY_ENV = "MULTIMEDIA_AUDIO_API_KEY";
const AUDIO_BASE_URL_ENV = "MULTIMEDIA_AUDIO_BASE_URL";

function ctxWithProviderCredentials(apiKeys: Record<string, string>): MinimalExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => [],
      getApiKeyAndHeaders: async () => ({ ok: false }),
      getProviderAuthStatus: (p: string) => ({ configured: p in apiKeys }),
      getApiKeyForProvider: async (p: string) => apiKeys[p],
    },
  };
}

function ctxWithProviderCredential(provider: string, apiKey = "resolved-key"): MinimalExtensionContext {
  return ctxWithProviderCredentials({ [provider]: apiKey });
}

function ctxWithNoCredentials(): MinimalExtensionContext {
  return ctxWithProviderCredentials({});
}

describe("resolveAudioChain", () => {
  it("trusts an explicit env override and skips discovery entirely", async () => {
    const ctx = ctxWithProviderCredential("openai", "should-not-be-used");
    const env = { [TRANSCRIBE_MODEL_ENV]: "custom-transcribe", [AUDIO_API_KEY_ENV]: "env-key" };

    const chain = await resolveAudioChain(ctx, env, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({
      provider: "env",
      model: "custom-transcribe",
      apiKey: "env-key",
      source: "env-override",
      kind: "transcribe",
    });
  });

  it("builds the full fixed 7-candidate chain in the exact new order when every provider has a credential (issue #260, most error-prone case)", async () => {
    const ctx = ctxWithProviderCredentials({ openrouter: "openrouter-key", groq: "groq-key", openai: "openai-key" });

    const chain = await resolveAudioChain(ctx, {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    expect(chain.map((c) => ({ provider: c.provider, model: c.model, kind: c.kind }))).toEqual([
      { provider: "openrouter", model: "gpt-4o-mini-transcribe", kind: "transcribe" },
      { provider: "openrouter", model: "whisper-1", kind: "transcribe" },
      { provider: "groq", model: "whisper-large-v3", kind: "transcribe" },
      { provider: "openai", model: "gpt-4o-mini-transcribe", kind: "transcribe" },
      { provider: "openai", model: "whisper-1", kind: "transcribe" },
      { provider: "openrouter", model: "openai/gpt-audio", kind: "chat" },
      { provider: "openai", model: "openai/gpt-audio", kind: "chat" },
    ]);
    expect(chain.every((c) => c.apiKey && c.unresolvedReason === undefined)).toBe(true);
    // The native OpenAI gpt-audio candidate (position 7) is always forced to
    // api.openai.com, never a registry-overridden base URL.
    expect(chain[6].baseUrl).toBe("https://api.openai.com/v1");
  });

  it("builds resolved candidates only for the provider with an actual credential (issue #243 regression: OpenRouter-only)", async () => {
    const ctx = ctxWithProviderCredential("openrouter", "openrouter-key");

    const chain = await resolveAudioChain(ctx, {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    const openai = chain.filter((c) => c.provider === "openai");
    const openrouter = chain.filter((c) => c.provider === "openrouter");
    const groq = chain.filter((c) => c.provider === "groq");

    expect(openai.every((c) => c.unresolvedReason === "no-credential")).toBe(true);
    expect(groq.every((c) => c.unresolvedReason === "no-credential")).toBe(true);
    expect(openrouter.every((c) => c.apiKey === "openrouter-key" && c.unresolvedReason === undefined)).toBe(true);
    expect(openrouter.map((c) => c.model)).toEqual(["gpt-4o-mini-transcribe", "whisper-1", "openai/gpt-audio"]);
  });

  it("resolves Groq-only in the expected single position", async () => {
    const ctx = ctxWithProviderCredential("groq", "groq-key");

    const chain = await resolveAudioChain(ctx, {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    const resolved = chain.filter((c) => c.unresolvedReason === undefined);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ provider: "groq", model: "whisper-large-v3", kind: "transcribe", apiKey: "groq-key" });
  });

  it("resolves OpenAI-only across its three chain positions (2 transcribe, 1 chat)", async () => {
    const ctx = ctxWithProviderCredential("openai", "openai-key");

    const chain = await resolveAudioChain(ctx, {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    const resolved = chain.filter((c) => c.unresolvedReason === undefined);
    expect(resolved.map((c) => ({ model: c.model, kind: c.kind }))).toEqual([
      { model: "gpt-4o-mini-transcribe", kind: "transcribe" },
      { model: "whisper-1", kind: "transcribe" },
      { model: "openai/gpt-audio", kind: "chat" },
    ]);
  });

  it("marks every candidate unresolved with no-credential when nothing is configured", async () => {
    const chain = await resolveAudioChain(ctxWithNoCredentials(), {}, TRANSCRIBE_MODEL_ENV, AUDIO_API_KEY_ENV, AUDIO_BASE_URL_ENV);

    expect(chain.every((c) => c.unresolvedReason === "no-credential")).toBe(true);
    expect(chain.every((c) => c.apiKey === undefined)).toBe(true);
    expect(chain).toHaveLength(7);
  });
});

function okResult(text: string): AudioToolResult {
  return { isError: false, content: [{ type: "text", text }] };
}

function errorResult(status: number | undefined, text: string, failureKind?: "network" | "parse"): AudioToolResult {
  return { isError: true, status, failureKind, content: [{ type: "text", text }] };
}

describe("runChain", () => {
  it("stops at the first successful candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
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
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", unresolvedReason: "no-credential" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
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
      { provider: "openai", model: "bad-model", source: "registry-credential", kind: "transcribe", apiKey: "k1" },
      { provider: "openrouter", model: "whisper-1", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) => (c.model === "bad-model" ? errorResult(400, "model does not exist") : okResult("real result"));

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "success", result: okResult("real result") });
  });

  it("treats a 401 auth failure as skippable and tries the next candidate (issue #260: exhaustive retry, deliberate change from fail-fast)", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", apiKey: "bad-key" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(c.model);
      return c.model === "a" ? errorResult(401, "Unauthorized") : okResult("real result from b");
    };

    const outcome = await runChain("test", candidates, call);

    expect(calls).toEqual(["a", "b"]); // second candidate IS attempted
    expect(outcome).toEqual({ kind: "success", result: okResult("real result from b") });
  });

  it("treats a 429 rate-limit failure as skippable and tries the next candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) => (c.model === "a" ? errorResult(429, "Too Many Requests") : okResult("real result from b"));

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "success", result: okResult("real result from b") });
  });

  it("treats a network failure (no status, failureKind=network) as skippable and tries the next candidate", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const call = async (c: AudioCandidate) =>
      c.model === "a" ? errorResult(undefined, "network error", "network") : okResult("real result from b");

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "success", result: okResult("real result from b") });
  });

  it("surfaces a parse failure immediately instead of trying the next candidate (the one non-skippable failure)", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", apiKey: "k1" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(c.model);
      return c.model === "a" ? errorResult(undefined, "Failed to parse response", "parse") : okResult("should never be reached");
    };

    const outcome = await runChain("test", candidates, call);

    expect(calls).toEqual(["a"]); // second candidate never attempted
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.result.content[0].text).toContain("Failed to parse response");
      expect(outcome.result.content[0].text).toContain("openrouter/b"); // names the skipped remaining candidate
    }
  });

  it("an early 401 followed by a later success still returns the later success (issue #260 required regression test)", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openrouter", model: "gpt-4o-mini-transcribe", source: "registry-credential", kind: "transcribe", apiKey: "or-key" },
      { provider: "openrouter", model: "whisper-1", source: "registry-credential", kind: "transcribe", apiKey: "or-key" },
      { provider: "groq", model: "whisper-large-v3", source: "registry-credential", kind: "transcribe", apiKey: "groq-key" },
    ];
    const calls: string[] = [];
    const call = async (c: AudioCandidate) => {
      calls.push(`${c.provider}/${c.model}`);
      if (c.provider === "openrouter") return errorResult(401, "Unauthorized");
      return okResult("groq transcript");
    };

    const outcome = await runChain("test", candidates, call);

    expect(calls).toEqual(["openrouter/gpt-4o-mini-transcribe", "openrouter/whisper-1", "groq/whisper-large-v3"]);
    expect(outcome).toEqual({ kind: "success", result: okResult("groq transcript") });
  });

  it("returns kind:'exhausted' with every skip reason when every candidate is unresolved", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", unresolvedReason: "no-credential" },
      { provider: "groq", model: "b", source: "registry-credential", kind: "transcribe", unresolvedReason: "no-credential" },
    ];
    const call = async () => okResult("should never be reached");

    const outcome = await runChain("test", candidates, call);

    expect(outcome).toEqual({ kind: "exhausted", reasons: ["openai (no-credential)", "groq (no-credential)"] });
  });

  it("exhausts across all 7 candidates when every single one fails with a skippable reason (issue #260)", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openrouter", model: "gpt-4o-mini-transcribe", source: "registry-credential", kind: "transcribe", apiKey: "k" },
      { provider: "openrouter", model: "whisper-1", source: "registry-credential", kind: "transcribe", apiKey: "k" },
      { provider: "groq", model: "whisper-large-v3", source: "registry-credential", kind: "transcribe", unresolvedReason: "no-credential" },
      { provider: "openai", model: "gpt-4o-mini-transcribe", source: "registry-credential", kind: "transcribe", apiKey: "k" },
      { provider: "openai", model: "whisper-1", source: "registry-credential", kind: "transcribe", apiKey: "k" },
      { provider: "openrouter", model: "openai/gpt-audio", source: "registry-credential", kind: "chat", apiKey: "k" },
      { provider: "openai", model: "openai/gpt-audio", source: "registry-credential", kind: "chat", apiKey: "k" },
    ];
    const call = async (c: AudioCandidate) => errorResult(401, `${c.provider} unauthorized`);

    const outcome = await runChain("test", candidates, call);

    expect(outcome.kind).toBe("exhausted");
    if (outcome.kind === "exhausted") {
      expect(outcome.reasons).toEqual([
        "openrouter/gpt-4o-mini-transcribe (auth-failed)",
        "openrouter/whisper-1 (auth-failed)",
        "groq (no-credential)",
        "openai/gpt-4o-mini-transcribe (auth-failed)",
        "openai/whisper-1 (auth-failed)",
        "openrouter/openai/gpt-audio (auth-failed)",
        "openai/openai/gpt-audio (auth-failed)",
      ]);
    }
  });

  it("invokes the injected logger once per candidate with the specific reason, never calling console directly", async () => {
    const candidates: AudioCandidate[] = [
      { provider: "openai", model: "a", source: "registry-credential", kind: "transcribe", unresolvedReason: "no-credential" },
      { provider: "openrouter", model: "b", source: "registry-credential", kind: "transcribe", apiKey: "k2" },
    ];
    const lines: string[] = [];
    const call = async () => okResult("ok");

    await runChain("audio", candidates, call, (line) => lines.push(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("chain=audio candidate=1/2 provider=openai model=a result=skip reason=no-credential");
    expect(lines[1]).toContain("chain=audio candidate=2/2 provider=openrouter model=b result=success");
  });
});

describe("buildExhaustionError", () => {
  it("names each tried reason and gives clear configuration guidance", () => {
    const result = buildExhaustionError(["openai (no-credential)", "openrouter/whisper-1 (auth-failed)"]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("openai (no-credential)");
    expect(result.content[0].text).toContain("openrouter/whisper-1 (auth-failed)");
    expect(result.content[0].text).toContain("MULTIMEDIA_AUDIO_API_KEY");
  });
});
