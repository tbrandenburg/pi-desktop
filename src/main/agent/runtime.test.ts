import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream, Api, Model } from "@earendil-works/pi-ai";
import { AgentRuntime } from "./runtime";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";
import type { ChatEvent, StartChatRequest } from "../../shared/events";

/**
 * A minimal fake `ProviderStreams`-style stream (no network) registered
 * directly onto a real `ModelRuntime` via `registerProvider`'s
 * `streamSimple` override -- `provider-composer.js`'s `streamWith` routes
 * *both* `.stream()` and `.streamSimple()` calls through a registered
 * `streamSimple` override when present, so this single fake covers whatever
 * `AgentSession` calls internally. This exercises the real
 * `createAgentSession`/`AgentSession` tool loop and real `SessionManager`
 * disk persistence end-to-end -- only the network boundary is faked, per
 * the same test-pattern guidance the pre-Phase-1 `AgentHarness` tests used.
 */
function fakeAssistantStream(): AssistantMessageEventStream {
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

const FAKE_PROVIDER_ID = "fake";
const FAKE_MODEL_ID = "fake-model";

async function buildFakeModelRuntime(agentDir: string) {
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

describe("AgentRuntime (real AgentSession + real SessionManager, fake network)", () => {
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-runtime-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-dir-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("streams a real end-to-end reply and persists it to a real on-disk session", async () => {
    const request: StartChatRequest = {
      conversationId: "conv-real-1",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "hello there" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    await runtime.run({
      requestId: "req-1",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      agentDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: "started", requestId: "req-1" });
    expect(events.some((e) => e.type === "text-delta" && e.text === "Hi ")).toBe(true);
    expect(events.some((e) => e.type === "text-delta" && e.text === "there")).toBe(true);
    expect(events.some((e) => e.type === "reasoning-delta" && e.text === "pondering...")).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 3 && e.outputTokens === 5)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

    // Real on-disk proof: a fresh SessionManager.list() against the same
    // cwd must find the persisted session under the same conversationId.
    const { SessionManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const sessions = await SessionManager.list(cwd, path.join(agentDir, "sessions"));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-real-1");
  });

  it("emits an error and never starts the session when the request has no user message", async () => {
    const request: StartChatRequest = {
      conversationId: "conv-no-user-message",
      model: "fake/fake-model",
      messages: [{ role: "assistant", content: "I am not a user message" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    await runtime.run({
      requestId: "req-2",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      agentDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    // Exactly one error event, and no "started"/"completed" -- proves the
    // function returns immediately without ever creating a session.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", requestId: "req-2", message: "No user message to send." });
    expect(events.some((e) => e.type === "started")).toBe(false);
  });

  it("finds the last user message when the request has multiple, using the most recent one", async () => {
    const request: StartChatRequest = {
      conversationId: "conv-multi-user",
      model: "fake/fake-model",
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "an assistant reply" },
        { role: "user", content: "second message" },
      ],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    await runtime.run({
      requestId: "req-3",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      agentDir,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-3" });

    const { SessionManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const sessions = await SessionManager.list(cwd, path.join(agentDir, "sessions"));
    const sessionManager = SessionManager.open(sessions[0].path, path.join(agentDir, "sessions"));
    const entries = sessionManager.getEntries();
    const userMessages = entries
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    // Only the *last* user message ("second message") must have been sent
    // to the session -- kills the ".reverse()" removal and the
    // "find((m) => true)" mutants, which would instead pick the first one.
    expect(userMessages).toEqual([[{ type: "text", text: "second message" }]]);
  });

  it("reuses the same persisted session across two separate run() calls with the same conversationId", async () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    const runOnce = async (requestId: string, conversationId: string, text: string) => {
      const events: ChatEvent[] = [];
      await runtime.run({
        requestId,
        request: { conversationId, model: "fake/fake-model", messages: [{ role: "user", content: text }] },
        cwd,
        providerId: FAKE_PROVIDER_ID,
        model,
        modelRuntime,
        agentDir,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      });
      return events;
    };

    const firstEvents = await runOnce("req-a", "conv-reused", "turn one");
    const secondEvents = await runOnce("req-b", "conv-reused", "turn two");

    expect(firstEvents.at(-1)).toEqual({ type: "completed", requestId: "req-a" });
    expect(secondEvents.at(-1)).toEqual({ type: "completed", requestId: "req-b" });

    const { SessionManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const sessionDir = path.join(agentDir, "sessions");
    // Exactly one session file on disk -- proves the second run() found and
    // reused the existing session, rather than creating a second one.
    const sessions = await SessionManager.list(cwd, sessionDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-reused");

    const sessionManager = SessionManager.open(sessions[0].path, sessionDir);
    const userMessages = sessionManager
      .getEntries()
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    expect(userMessages).toEqual([
      [{ type: "text", text: "turn one" }],
      [{ type: "text", text: "turn two" }],
    ]);

    // A *second*, unrelated conversation in the same cwd must not be
    // confused with "conv-reused" -- proves the match is filtered by id
    // rather than picking the first/any session.
    await runOnce("req-c", "conv-other", "unrelated conversation");
    const allSessions = await SessionManager.list(cwd, sessionDir);
    expect(allSessions).toHaveLength(2);
    expect(allSessions.map((s) => s.id).sort()).toEqual(["conv-other", "conv-reused"]);
  });
});
