/**
 * Provider-agnostic candidate-chain resolution for `understand_audio`
 * (issue #243, reduced to a single transcription-only chain by issue #260).
 *
 * `understand_audio` transcribes every call -- there is no prompt-driven
 * branch. The chain below is a single, fixed, ordered list of candidates:
 * an optional env override, then five dedicated transcription-endpoint
 * candidates across three providers, then two chat-completions-shaped
 * `gpt-audio` fallback candidates (issue #260). Credentials are resolved via
 * "is this provider authenticated at all"
 * (`getProviderAuthStatus`/`getApiKeyForProvider`), never via
 * `getAvailable()`, which never lists transcription-only models.
 *
 * The chain is exhaustive (issue #260): every HTTP failure except a parse
 * failure is skippable and advances to the next candidate. A parse failure
 * (malformed response body) is the one exception that still surfaces
 * immediately -- it is a real code/contract bug, not something the next
 * candidate could route around.
 */
import type { AudioToolResult } from "./audio.js";
import type { MinimalExtensionContext } from "./index.js";

// Minimal ambient declaration: the shared extension tsconfig deliberately has
// no Node/DOM type definitions, and this package must not add dependencies.
declare const console: { error(...args: unknown[]): void };

/** Where a candidate's model id and credential came from. */
export type CandidateSource = "env-override" | "registry-credential";

/** Which HTTP call shape a candidate needs (issue #260): the multipart transcription endpoint, or a chat-completions request. */
export type CandidateKind = "transcribe" | "chat";

/**
 * Shared, typed vocabulary for both a pre-call unresolved skip
 * (`no-credential`) and a post-call skippable failure classification. Used
 * as the single source of truth for both the retry logic (`runChain`) and
 * `PI_MULTIMEDIA_DEBUG` log lines (issue #260), so they can never disagree.
 */
export type CandidateReason = "no-credential" | "model-not-found" | "auth-failed" | "rate-limited" | "network-error";

/** One resolvable (or explicitly unresolvable) attempt in the chain. */
export interface AudioCandidate {
  provider: string;
  model: string;
  source: CandidateSource;
  kind: CandidateKind;
  /** Present only when this candidate actually has a usable credential. */
  apiKey?: string;
  baseUrl?: string;
  /** Set instead of `apiKey` when this candidate could not be resolved at all (e.g. no credential for that provider). */
  unresolvedReason?: CandidateReason;
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

/** One entry in the fixed chain spec below, before credential resolution. */
interface CandidateSpec {
  provider: string;
  model: string;
  kind: CandidateKind;
  /** Overrides the registry/default base URL for this specific candidate (e.g. forcing native `api.openai.com` regardless of a registry override). */
  baseUrlOverride?: string;
}

/**
 * The fixed candidate chain, in the exact order required by issue #260:
 * 1-2. OpenRouter transcription models.
 * 3. Groq transcription model.
 * 4-5. OpenAI transcription models.
 * 6. OpenRouter `openai/gpt-audio` (chat-completions shape).
 * 7. OpenAI native `openai/gpt-audio` (chat-completions shape, forced to
 *    `api.openai.com`, never a registry-overridden base URL).
 *
 * This deliberately reorders the pre-#260 chain (which tried OpenAI first,
 * then OpenRouter, then Groq) -- OpenAI moves from position 1 to position 3.
 */
const FIXED_CANDIDATE_CHAIN: CandidateSpec[] = [
  { provider: "openrouter", model: "gpt-4o-mini-transcribe", kind: "transcribe" },
  { provider: "openrouter", model: "whisper-1", kind: "transcribe" },
  { provider: "groq", model: "whisper-large-v3", kind: "transcribe" },
  { provider: "openai", model: "gpt-4o-mini-transcribe", kind: "transcribe" },
  { provider: "openai", model: "whisper-1", kind: "transcribe" },
  { provider: "openrouter", model: "openai/gpt-audio", kind: "chat" },
  { provider: "openai", model: "openai/gpt-audio", kind: "chat", baseUrlOverride: "https://api.openai.com/v1" },
];

/** Fallback base URLs used only when the registry doesn't expose one for a provider (e.g. in tests / standalone use). */
const DEFAULT_PROVIDER_BASE_URLS: Record<string, string | undefined> = {
  openai: undefined, // audio.ts already defaults to https://api.openai.com/v1
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
};

/** Minimal shape of registry auth-status lookups this module needs, mirroring `MinimalModelRegistry` in `index.ts`. */
export interface ProviderAuthAware {
  getProviderAuthStatus?(provider: string): { configured: boolean } | undefined;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  getProvider?(provider: string): { baseUrl?: string } | undefined;
}

/**
 * Builds the ordered, fixed audio candidate chain. Pure resolution: no
 * network calls. `env` override skips discovery entirely when set (single
 * candidate, `kind: "transcribe"`, matching today's env-override request
 * shape); otherwise every candidate in `FIXED_CANDIDATE_CHAIN` is resolved
 * against a provider credential via `getProviderAuthStatus`/
 * `getApiKeyForProvider` (never via `getAvailable()`, which never lists
 * transcription-only models). Each provider's credential is resolved at
 * most once even though a provider (e.g. `openrouter`/`openai`) appears at
 * multiple chain positions.
 */
export async function resolveAudioChain(
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
    return [
      { provider: "env", model: envModel, kind: "transcribe", source: "env-override", apiKey: envApiKey ?? "", baseUrl: envBaseUrl },
    ];
  }

  const registry = ctx.modelRegistry as (typeof ctx.modelRegistry & ProviderAuthAware) | undefined;
  const apiKeyCache = new Map<string, string | undefined>();
  const resolveKeyCached = async (provider: string): Promise<string | undefined> => {
    if (!apiKeyCache.has(provider)) {
      apiKeyCache.set(provider, await resolveProviderApiKey(registry, provider));
    }
    return apiKeyCache.get(provider);
  };

  const candidates: AudioCandidate[] = [];
  for (const spec of FIXED_CANDIDATE_CHAIN) {
    const apiKey = await resolveKeyCached(spec.provider);
    if (!apiKey) {
      candidates.push({ provider: spec.provider, model: spec.model, kind: spec.kind, source: "registry-credential", unresolvedReason: "no-credential" });
      continue;
    }
    const baseUrl = spec.baseUrlOverride ?? registry?.getProvider?.(spec.provider)?.baseUrl ?? DEFAULT_PROVIDER_BASE_URLS[spec.provider];
    candidates.push({ provider: spec.provider, model: spec.model, kind: spec.kind, source: "registry-credential", apiKey, baseUrl });
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
 * Classifies a failed `AudioToolResult` into the shared reason vocabulary,
 * or `undefined` when the failure must surface immediately (a parse
 * failure: a real code/contract bug, not something the next candidate could
 * route around). All four HTTP-classified reasons here (400/401/429/no-status
 * network failure) are skippable (issue #260's exhaustive-retry policy --
 * a deliberate change from the pre-#260 fail-fast-on-401/429/network
 * behavior).
 */
function classifyFailure(result: AudioToolResult): CandidateReason | undefined {
  if (result.status === 400) return "model-not-found";
  if (result.status === 401) return "auth-failed";
  if (result.status === 429) return "rate-limited";
  if (result.failureKind === "network") return "network-error";
  return undefined;
}

/** Outcome of running the chain: a real success, a real (parse) failure to surface as-is, or full exhaustion (no viable candidates at all — not a failure, but every candidate was skipped). */
export type ChainResult =
  | { kind: "success"; result: AudioToolResult }
  | { kind: "failure"; result: AudioToolResult }
  | { kind: "exhausted"; reasons: string[] };

/**
 * Runs the ordered candidate chain: calls `call(candidate)` for each
 * resolved candidate in order, stopping at the first success. Unresolved
 * candidates (no credential) are skipped without a network call. Every
 * classified HTTP failure (400 model-not-found, 401 auth-failed, 429
 * rate-limited, network-error) is skippable and moves to the next candidate
 * -- issue #260's exhaustive-retry policy: authentication/rate-limit/network
 * failures never stop the chain early. Only a parse failure (malformed
 * response body) is surfaced immediately as `kind: "failure"`, since that is
 * a real code/contract bug the next candidate can't route around. On full
 * exhaustion (every candidate skipped, none succeeded or hit a parse
 * failure), returns `kind: "exhausted"` with every skip reason.
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

    const reason = classifyFailure(result);
    if (reason) {
      logger(
        `[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=skip reason=${reason}`,
      );
      skipped.push(`${candidate.provider}/${candidate.model} (${reason})`);
      continue;
    }

    const remaining = candidates.slice(i + 1).map((c) => `${c.provider}/${c.model}`);
    logger(
      `[pi-multimedia] chain=${chainName} candidate=${position} provider=${candidate.provider} model=${candidate.model} result=fail reason=parse-error${remaining.length ? ` skipped-remaining=${remaining.join(",")}` : ""}`,
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

/** Builds the final "fully exhausted, zero viable candidates" error message. */
export function buildExhaustionError(reasons: string[]): AudioToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `No audio transcription path available. Tried: ${reasons.join(", ")}. ` +
          "Configure MULTIMEDIA_AUDIO_API_KEY, or add an OpenRouter/Groq/OpenAI credential via Settings.",
      },
    ],
  };
}
