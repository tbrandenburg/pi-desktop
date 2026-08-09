import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream, Api, Model } from "@earendil-works/pi-ai";
import { realCodingAgentLoaders } from "./real-coding-agent-loaders";

/**
 * A minimal fake `ProviderStreams`-style stream (no network) registered
 * directly onto a real `ModelRuntime` via `registerProvider`'s
 * `streamSimple` override -- `provider-composer.js`'s `streamWith` routes
 * *both* `.stream()` and `.streamSimple()` calls through a registered
 * `streamSimple` override when present, so this single fake covers whatever
 * `AgentSession` calls internally. This exercises the real
 * `createAgentSession`/`AgentSession` tool loop and real `SessionManager`
 * disk persistence end-to-end -- only the network boundary is faked.
 *
 * Shared between `runtime.test.ts` and `session/service.test.ts` (both need
 * a real, network-free `AgentSession` run to prove real on-disk session
 * persistence -- the latter to prove `SessionService` can read back what
 * `AgentRuntime` wrote, see issue #90's session-format-alignment follow-up).
 */
export function fakeAssistantStream(): AssistantMessageEventStream {
  const base = {
    role: "assistant" as const,
    content: [] as { type: "text"; text: string }[],
    api: "openai-completions" as const,
    provider: "fake",
    model: "fake-model",
    usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...base, content: [] } });
    stream.push({ type: "thinking_start", contentIndex: 0, partial: { ...base, content: [] } });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "pondering...", partial: { ...base, content: [] } });
    stream.push({ type: "thinking_end", contentIndex: 0, content: "pondering...", partial: { ...base, content: [] } });
    stream.push({ type: "text_start", contentIndex: 1, partial: { ...base, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 1, delta: "Hi ", partial: { ...base, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 1, delta: "there", partial: { ...base, content: [] } });
    const finalMessage = { ...base, content: [{ type: "text" as const, text: "Hi there" }] };
    stream.push({ type: "text_end", contentIndex: 1, content: "Hi there", partial: finalMessage });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
    stream.end(finalMessage);
  });
  return stream;
}

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_MODEL_ID = "fake-model";

/**
 * A fake stream whose final assistant message resolves with `stopReason:
 * "error"` and a real `errorMessage` set, but is never thrown -- mirrors the
 * documented `StreamFn` contract ("failures must be encoded in the returned
 * stream via ... a final AssistantMessage with stopReason 'error' ... and
 * errorMessage", `pi-agent-core`'s `types.d.ts`) and the real shape observed
 * from a genuinely suspended `github-copilot` account mid-conversation
 * (`stopReason: "error"`, empty `content`, a real `errorMessage` string).
 * Used to prove `AgentRuntime.run` surfaces this as a `ChatEvent` of type
 * `"error"` instead of silently emitting `"completed"` for an empty,
 * failed turn.
 */
export function fakeFailedAssistantStream(errorMessage: string): AssistantMessageEventStream {
  const base = {
    role: "assistant" as const,
    content: [] as { type: "text"; text: string }[],
    api: "openai-completions" as const,
    provider: "fake",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error" as const,
    errorMessage,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...base } });
    stream.push({ type: "error", reason: "error", error: { ...base } });
    stream.end({ ...base });
  });
  return stream;
}

/**
 * Registers `fakeFailedAssistantStream` on a real `ModelRuntime` instead of
 * the default `fakeAssistantStream` -- see `buildFakeModelRuntime`'s own doc
 * comment for why a real, injected `ModelRuntime` is required here.
 */
export async function buildFakeFailingModelRuntime(agentDir: string, errorMessage: string) {
  const { ModelRuntime } = await realCodingAgentLoaders.loadCodingAgent!();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(FAKE_PROVIDER_ID, {
    baseUrl: "https://fake.local",
    api: "openai-completions",
    apiKey: "fake-key",
    streamSimple: () => fakeFailedAssistantStream(errorMessage),
    models: [
      {
        id: FAKE_MODEL_ID,
        name: FAKE_MODEL_ID,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });
  const model = modelRuntime.getModel(FAKE_PROVIDER_ID, FAKE_MODEL_ID);
  if (!model) throw new Error("fake model failed to register");
  return { modelRuntime, model: model as unknown as Model<Api> };
}

/**
 * Registers a `streamSimple` override that synchronously throws instead of
 * resolving/rejecting a stream -- mirrors a real OAuth/credential
 * resolution failure thrown before any request is even attempted (the
 * `catch` branch in `runtime.ts`'s `run()`, distinct from
 * `buildFakeFailingModelRuntime`'s non-throwing `stopReason: "error"`
 * case). Used to prove Tier 3 (issue #175) records `"error"` for this
 * thrown-exception path too.
 */
export async function buildFakeThrowingModelRuntime(agentDir: string, errorMessage: string) {
  const { ModelRuntime } = await realCodingAgentLoaders.loadCodingAgent!();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(FAKE_PROVIDER_ID, {
    baseUrl: "https://fake.local",
    api: "openai-completions",
    apiKey: "fake-key",
    streamSimple: () => {
      throw new Error(errorMessage);
    },
    models: [
      {
        id: FAKE_MODEL_ID,
        name: FAKE_MODEL_ID,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });
  const model = modelRuntime.getModel(FAKE_PROVIDER_ID, FAKE_MODEL_ID);
  if (!model) throw new Error("fake model failed to register");
  return { modelRuntime, model: model as unknown as Model<Api> };
}

/**
 * Builds a real `ModelRuntime` (isolated to `agentDir` via an explicit
 * `authPath`, no network refresh) with a single fake, network-free
 * provider/model registered on it. Tests inject this `modelRuntime`
 * directly into `AgentRuntime.run` (rather than letting `run` build its
 * own) -- `run` always constructs a *fresh* `ModelRuntime` internally
 * (honoring the `PI_CODING_AGENT_DIR` env var, see `runtime.ts`), which has no way
 * to see a fake `registerProvider` call made on a *different* instance,
 * since `registerProvider` is purely in-memory (never persisted to
 * `auth.json`/`models.json`).
 */
export async function buildFakeModelRuntime(agentDir: string) {
  const { ModelRuntime } = await realCodingAgentLoaders.loadCodingAgent!();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(FAKE_PROVIDER_ID, {
    baseUrl: "https://fake.local",
    api: "openai-completions",
    apiKey: "fake-key",
    streamSimple: fakeAssistantStream,
    models: [
      {
        id: FAKE_MODEL_ID,
        name: FAKE_MODEL_ID,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  });
  const model = modelRuntime.getModel(FAKE_PROVIDER_ID, FAKE_MODEL_ID);
  if (!model) throw new Error("fake model failed to register");
  return { modelRuntime, model: model as unknown as Model<Api> };
}
