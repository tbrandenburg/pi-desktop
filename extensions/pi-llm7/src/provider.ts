import { LLM7_BASE_URL, LLM7_MODELS, LLM7_PROVIDER_ID, type Llm7ModelConfig } from "./models.js";

/**
 * Placeholder key used when no real LLM7 credential is configured.
 *
 * llm7.io itself does not validate the key, but pi-ai's `openai-completions`
 * transport (`getClientApiKey()`) throws `No API key for provider: X` unless
 * `apiKey` is a NON-EMPTY string. pi-free's LLM7 provider resolves empty auth,
 * so its models appear in the picker but hard-fail at send time. A non-empty
 * placeholder is the whole fix.
 *
 * Note: `$LLM7_API_KEY` interpolation alone is NOT sufficient — it resolves to
 * an empty string when the env var is unset, which reproduces the exact bug.
 */
export const ANONYMOUS_API_KEY = "anonymous";

export const LLM7_API_KEY_ENV = "LLM7_API_KEY";

/**
 * Resolve the API key: a real configured key always wins; otherwise fall back
 * to the non-empty placeholder. Never returns an empty/undefined value.
 */
export function resolveApiKey(env: Record<string, string | undefined>): string {
  return env[LLM7_API_KEY_ENV]?.trim() || ANONYMOUS_API_KEY;
}

export interface Llm7ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: Llm7ModelConfig[];
}

/** Build the plain `registerProvider` config object for the LLM7 provider. */
export function buildLlm7ProviderConfig(
  env: Record<string, string | undefined>,
): Llm7ProviderConfig {
  return {
    baseUrl: LLM7_BASE_URL,
    apiKey: resolveApiKey(env),
    api: "openai-completions",
    models: LLM7_MODELS,
  };
}

export { LLM7_PROVIDER_ID };
