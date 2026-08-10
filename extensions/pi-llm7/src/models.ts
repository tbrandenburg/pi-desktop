/**
 * Static LLM7 model catalog.
 *
 * LLM7.io routes requests across several upstream providers behind one
 * OpenAI-compatible endpoint, so its "models" are routing selectors rather
 * than concrete model ids:
 *
 *   - "default" — first available free model
 *   - "fast"    — lowest-latency free option
 *
 * The paid "pro" selector is deliberately NOT exposed here: this extension is
 * the keyless/free provider (issue #193).
 *
 * The catalog is static — the selectors never change, so no network fetch is
 * needed and the catalog stays visible even when no credential is configured.
 *
 * Context window: pi-free advertises 32K, but that value was verified to BREAK
 * real turns under the `pi` CLI — pi's own system prompt is ~28K tokens, so a
 * 32K window leaves ~1 output token and every reply comes back truncated
 * (`stopReason: "length"`, empty stdout for `pi -p`). 128K is used instead; the
 * real upstream models LLM7 routes to (e.g. codestral-latest) are far larger.
 */

export const LLM7_BASE_URL = "https://api.llm7.io/v1";

/** Provider id — deliberately not `llm7`, to avoid colliding with pi-free's own. */
export const LLM7_PROVIDER_ID = "llm7-free";

export interface Llm7ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

export const LLM7_MODELS: Llm7ModelConfig[] = [
  {
    id: "default",
    name: "LLM7 Default",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
  {
    id: "fast",
    name: "LLM7 Fast",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  },
];
