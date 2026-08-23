/**
 * Provider-agnostic candidate-chain resolution for `understand_audio`
 * (issue #243). `resolveApiConfig`'s old approach only ever searched
 * `ctx.modelRegistry.getAvailable()` (chat models with usable auth) for a
 * name-hint match. Transcription models (`whisper-1`, `gpt-transcribe`,
 * etc.) are never listed there — they aren't selectable chat models — so
 * that lookup could never succeed for transcription against providers whose
 * catalog only lists chat models (e.g. OpenRouter), silently falling
 * through to an empty API key and a bare 401 from the default OpenAI base
 * URL, even when the user's OpenRouter credential is valid and works fine
 * for `whisper-1` on OpenRouter's own endpoint.
 *
 * This module builds an ordered list of candidates per chain
 * (transcription vs. understanding) by checking "is this provider
 * authenticated at all" (`getProviderAuthStatus`/`getApiKeyForProvider`)
 * rather than "is there a matching model in getAvailable()", then runs
 * them in order via `runChain`, which classifies HTTP failures as
 * "skip to next candidate" (no credential, or a 400 model-not-found-shaped
 * rejection) vs. "surface immediately" (401/429/network failures) so a
 * real auth/rate-limit error from an already-resolved candidate is never
 * silently swallowed.
 */
import type { AudioToolResult } from "./audio.js";
import type { MinimalExtensionContext, RegistryModel } from "./index.js";

// Minimal ambient declaration: the shared extension tsconfig deliberately has
// no Node/DOM type definitions, and this package must not add dependencies.
declare const console: { error(...args: unknown[]): void };

/** Where a candidate's model id and credential came from. */
export type CandidateSource = "env-override" | "registry-credential" | "registry-hint";

/** One resolvable (or explicitly unresolvable) attempt in a chain. */
export interface AudioCandidate {
  provider: string;
  model: string;
  source: CandidateSource;
  /** Present only when this candidate actually has a usable credential. */
  apiKey?: string;
  baseUrl?: string;
  /** Set instead of `apiKey` when this candidate could not be resolved at all (e.g. no credential for that provider). */
  unresolvedReason?: string;
}

export type ChainLogger = (line: string) => void;

/** No-op logger used when `PI_MULTIMEDIA_DEBUG` is not set. */
export const noopLogger: ChainLogger = () => {};

/** Real `console.error`-based logger, used only when `PI_MULTIMEDIA_DEBUG=1`. */
export function consoleLogger(line: string): void {
  // eslint-disable-next-line no-console -- intentional, env-gated debug output (issue #243)
  console.error(line);
}

/** Reads `PI_MULTIMEDIA_DEBUG` from env and returns the appropriate logger. Off by default. */
export function debugLoggerFor(env: Record<string, string | undefined>): ChainLogger {
  return env.PI_MULTIMEDIA_DEBUG === "1" || env.PI_MULTIMEDIA_DEBUG === "true" ? consoleLogger : noopLogger;
}

/** Well-known transcription-capable models per provider id, tried in order (issue #243). */
const TRANSCRIPTION_MODELS_BY_PROVIDER: Array<{ provider: string; models: string[] }> = [
  { provider: "openai", models: ["gpt-4o-mini-transcribe", "whisper-1"] },
  { provider: "openrouter", models: ["whisper-1"] },
  { provider: "groq", models: ["whisper-large-v3"] },
];

/** Fallback base URLs used only when the registry doesn't expose one for a provider (e.g. in tests / standalone use). */
const DEFAULT_PROVIDER_BASE_URLS: Record<string, string | undefined> = {
  openai: undefined, // audio.ts already defaults to https://api.openai.com/v1
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

/** Well-known audio-input-capable chat models, tried in order against the registry's hint-match (issue #243, generalizes the old single hardcoded hint). */
export const KNOWN_UNDERSTANDING_MODEL_HINTS = ["gpt-audio-1.5", "gpt-audio", "gpt-audio-mini", "gpt-4o-audio-preview"];

/** Minimal shape of registry auth-status lookups this module needs, mirroring `MinimalModelRegistry` in `index.ts`. */
export interface ProviderAuthAware {
  getProviderAuthStatus?(provider: string): { configured: boolean } | undefined;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getProvider?(provider: string): { baseUrl?: string } | undefined;
}

/**
 * Builds the ordered transcription candidate chain. Pure resolution: no
 * network calls. `env` overrides skip discovery entirely when set; otherwise
 * each known transcription-capable provider is checked for a credential via
 * `getProviderAuthStatus`/`getApiKeyForProvider` (never via `getAvailable()`,
 * which never lists transcription-only models).
 */
export async function resolveTranscriptionChain(
  ctx: MinimalExtensionContext,
  env: Record<string, string | undefined>,
  envModelKey: string,
  envApiKeyKey: string,
  envBaseUrlKey: string,
): Promise<AudioCandidate[]> {
  const envModel = env[envModelKey];
  const envApiKey = env[envApiKeyKey];
  const envBaseUrl = env[envBaseUrlKey];
  if (envModel && (envApiKey || envBaseUrl)) {
    return [{ provider: "env", model: envModel, source: "env-override", apiKey: envApiKey ?? "", baseUrl: envBaseUrl }];
  }

  const registry = ctx.modelRegistry as (typeof ctx.modelRegistry & ProviderAuthAware) | undefined;
  const candidates: AudioCandidate[] = [];
  for (const { provider, models } of TRANSCRIPTION_MODELS_BY_PROVIDER) {
    const apiKey = await resolveProviderApiKey(registry, provider);
    if (!apiKey) {
      candidates.push({ provider, model: models[0], source: "registry-credential", unresolvedReason: "no-credential" });
      continue;
    }
    const baseUrl = registry?.getProvider?.(provider)?.baseUrl ?? DEFAULT_PROVIDER_BASE_URLS[provider];
    for (const model of models) {
      candidates.push({ provider, model, source: "registry-credential", apiKey, baseUrl });
    }
  }
  return candidates;
}

async function resolveProviderApiKey(
  registry: (MinimalExtensionContext["modelRegistry"] & ProviderAuthAware) | undefined,
  provider: string,
): Promise<string | undefined> {
  if (!registry) return undefined;
  try {
    const status = registry.getProviderAuthStatus?.(provider);
    if (status && !status.configured) return undefined;
    return await registry.getApiKeyForProvider?.(provider);
  } catch {
    return undefined;
  }
}

/**
 * Builds the ordered understanding-chain candidate list. `env` override
 * skips discovery entirely when set; otherwise falls back to today's
 * existing registry hint-match logic (`findModelByNameHint`), generalized
 * to try each of `KNOWN_UNDERSTANDING_MODEL_HINTS` in order.
 */
export async function resolveUnderstandingChain(
  ctx: MinimalExtensionContext,
  env: Record<string, string | undefined>,
  envModelKey: string,
  envApiKeyKey: string,
  envBaseUrlKey: string,
  findModelByNameHint: (models: RegistryModel[], hint: string) => RegistryModel | undefined,
): Promise<AudioCandidate[]> {
  const envModel = env[envModelKey];
  const envApiKey = env[envApiKeyKey];
  const envBaseUrl = env[envBaseUrlKey];
  if (envModel && (envApiKey || envBaseUrl)) {
    return [{ provider: "env", model: envModel, source: "env-override", apiKey: envApiKey ?? "", baseUrl: envBaseUrl }];
  }

  const registry = ctx.modelRegistry;
  if (!registry) {
    return [{ provider: "unknown", model: KNOWN_UNDERSTANDING_MODEL_HINTS[0], source: "registry-hint", unresolvedReason: "no-registry" }];
  }

  try {
    const available = registry.getAvailable();
    for (const hint of KNOWN_UNDERSTANDING_MODEL_HINTS) {
      const match = findModelByNameHint(available, hint);
      if (!match) continue;
      const auth = await registry.getApiKeyAndHeaders(match);
      if (auth.ok && auth.apiKey) {
        return [
          {
            provider: (match as { provider?: string }).provider ?? "unknown",
            model: match.id,
            source: "registry-hint",
            apiKey: auth.apiKey,
            baseUrl: auth.baseUrl ?? match.baseUrl,
          },
        ];
      }
    }
  } catch {
    // Best-effort convenience only -- fall through to the exhausted result below.
  }
  return [{ provider: "unknown", model: KNOWN_UNDERSTANDING_MODEL_HINTS[0], source: "registry-hint", unresolvedReason: "no-model-match" }];
}

/** Classifies a failed `AudioToolResult` as "try the next candidate" or "surface immediately". Only a 400 (model-not-found-shaped) is skippable; everything else (401/429/network/parse) is surfaced. */
function isSkippableFailure(result: AudioToolResult): boolean {
  return result.status === 400;
}

/** Outcome of running a chain: a real success, a real failure to surface as-is, or full exhaustion (no viable candidates at all — not a failure, a handoff signal). */
export type ChainResult =
  | { kind: "success"; result: AudioToolResult }
  | { kind: "failure"; result: AudioToolResult }
  | { kind: "exhausted"; reasons: string[] };

/**
 * Runs an ordered candidate chain: calls `call(candidate)` for each resolved
 * candidate in order, stopping at the first success. Unresolved candidates
 * (no credential) are skipped without a network call. A skippable failure
 * (400, model-not-found-shaped) moves to the next candidate. Any other
 * failure (401/429/network/parse) is surfaced immediately as `kind:
 * "failure"` (never silently retried), tagged with which candidate produced
 * it and which remaining candidates were skipped as a result. On full
 * exhaustion (every candidate skipped, none succeeded or failed), returns
 * `kind: "exhausted"` with every skip reason — a handoff signal, not a
 * failure, so callers can fall back to a different chain.
 */
export async function runChain(
  chainName: string,
  candidates: AudioCandidate[],
  call: (candidate: AudioCandidate) => Promise<AudioToolResult>,
  logger: ChainLogger = noopLogger,
): Promise<ChainResult> {
  const total = candidates.length;
  const skipped: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const position = `${i + 1}/${total}`;

    if (candidate.unresolvedReason) {
      logger(
        `[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=skip reason=${candidate.unresolvedReason}`,
      );
      skipped.push(`${candidate.provider} (${candidate.unresolvedReason})`);
      continue;
    }

    const result = await call(candidate);
    if (!result.isError) {
      logger(`[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=success`);
      return { kind: "success", result };
    }

    if (isSkippableFailure(result)) {
      logger(
        `[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=skip reason=model-not-found`,
      );
      skipped.push(`${candidate.provider}/${candidate.model} (model not found)`);
      continue;
    }

    const remaining = candidates.slice(i + 1).map((c) => `${c.provider}/${c.model}`);
    logger(
      `[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=fail status=${result.status ?? "network"}${remaining.length ? ` skipped-remaining=${remaining.join(",")}` : ""}`,
    );
    return {
      kind: "failure",
      result: {
        isError: true,
        status: result.status,
        content: [
          {
            type: "text",
            text: `${result.content[0]?.text ?? "Request failed."} (candidate: ${candidate.provider}/${candidate.model}${remaining.length ? `; not tried: ${remaining.join(", ")}` : ""})`,
          },
        ],
      },
    };
  }

  logger(`[pi-multimedia] chain=${chainName} exhausted candidates=${total} skipped=[${skipped.join("; ")}]`);
  return { kind: "exhausted", reasons: skipped };
}

/** Builds the final "fully exhausted, zero viable candidates" error message across both chains. */
export function buildExhaustionError(reasons: string[]): AudioToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `No audio transcription or understanding path available. Tried: ${reasons.join(", ")}. ` +
          "Configure MULTIMEDIA_AUDIO_API_KEY, or add an audio-capable model via Settings.",
      },
    ],
  };
}
