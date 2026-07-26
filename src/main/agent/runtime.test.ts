import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentRuntime } from "./runtime";
import { realAgentCoreLoaders } from "./test-support/real-agent-core-loaders";
import type { ChatEvent, StartChatRequest } from "../../shared/events";

/**
 * A minimal fake `ProviderStreams` implementation (no network) plugged into
 * a real `createProvider`/`createModels` registry, so this test exercises
 * the real `AgentHarness` tool loop and real `JsonlSessionRepo` disk
 * persistence end-to-end -- only the network boundary itself is faked, per
 * the issue #41 investigation's Milestone 3 test-pattern guidance ("feed
 * scripted harness events, assert emitted ChatEvent[] order").
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

function buildFakeModel(models: ReturnType<typeof createModels>) {
  models.setProvider(
    createProvider({
      id: "fake",
      baseUrl: "https://fake.local",
      auth: { apiKey: { name: "fake", resolve: async () => ({ auth: { apiKey: "fake-key" } }) } },
      models: [
        {
          id: "fake-model",
          name: "fake-model",
          api: "openai-completions",
          provider: "fake",
          baseUrl: "https://fake.local",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        },
      ],
      api: { stream: fakeAssistantStream, streamSimple: fakeAssistantStream },
    }),
  );
  return models.getProvider("fake")!.getModels()[0];
}

describe("AgentRuntime (real AgentHarness + real JsonlSessionRepo, fake network)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("streams a real end-to-end reply and persists it to a real on-disk session", async () => {
    const models = createModels({});
    const model = buildFakeModel(models);

    const request: StartChatRequest = {
      conversationId: "conv-real-1",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "hello there" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realAgentCoreLoaders);

    await runtime.run({
      requestId: "req-1",
      request,
      cwd,
      models,
      model,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: "started", requestId: "req-1" });
    expect(events.some((e) => e.type === "text-delta" && e.text === "Hi ")).toBe(true);
    expect(events.some((e) => e.type === "text-delta" && e.text === "there")).toBe(true);
    // Real thinking_delta events from the harness must be forwarded as
    // reasoning-delta ChatEvents (kills the else-if branch mutants on the
    // "thinking_delta" comparison in AgentRuntime.forward).
    expect(events.some((e) => e.type === "reasoning-delta" && e.text === "pondering...")).toBe(true);
    // The final agent_end event's assistant usage must be forwarded as a
    // real "usage" ChatEvent with the exact token counts from the fake
    // stream's usage object (kills the agent_end/usage ObjectLiteral and
    // conditional mutants).
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 3 && e.outputTokens === 5)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

    // Real on-disk proof: a fresh AgentRuntime run against the same
    // conversationId/cwd must resolve the *same* persisted session file
    // (not create a second one), proving JsonlSessionRepo round-trips
    // through real disk rather than an in-memory fake.
    const { JsonlSessionRepo } = await realAgentCoreLoaders.loadAgentCore!();
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
    const sessions = await repo.list({ cwd });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-real-1");

    const session = await repo.open(sessions[0]);
    const entries = await session.getEntries();
    const userMessages = entries.filter((e) => e.type === "message" && e.message.role === "user");
    expect(userMessages).toHaveLength(1);
  });

  it("emits an error and never starts the harness when the request has no user message", async () => {
    const models = createModels({});
    const model = buildFakeModel(models);

    const request: StartChatRequest = {
      conversationId: "conv-no-user-message",
      model: "fake/fake-model",
      messages: [{ role: "assistant", content: "I am not a user message" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realAgentCoreLoaders);

    await runtime.run({
      requestId: "req-2",
      request,
      cwd,
      models,
      model,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    // Exactly one error event, and no "started"/"completed" -- proves the
    // function returns immediately without ever constructing a harness.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", requestId: "req-2", message: "No user message to send." });
    expect(events.some((e) => e.type === "started")).toBe(false);
  });

  it("finds the last user message when the request has multiple, using the most recent one", async () => {
    const models = createModels({});
    const model = buildFakeModel(models);

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
    const runtime = new AgentRuntime(realAgentCoreLoaders);

    await runtime.run({
      requestId: "req-3",
      request,
      cwd,
      models,
      model,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-3" });

    const { JsonlSessionRepo } = await realAgentCoreLoaders.loadAgentCore!();
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
    const sessions = await repo.list({ cwd });
    const session = await repo.open(sessions[0]);
    const entries = await session.getEntries();
    const userMessages = entries
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    // Only the *last* user message ("second message") must have been sent to
    // the harness -- kills the ".reverse()" removal and the
    // "find((m) => true)" mutants, which would instead pick the first one.
    expect(userMessages).toEqual([[{ type: "text", text: "second message" }]]);
  });

  it("reuses the same persisted session across two separate run() calls with the same conversationId", async () => {
    const models = createModels({});
    const model = buildFakeModel(models);
    const runtime = new AgentRuntime(realAgentCoreLoaders);

    const runOnce = async (requestId: string, text: string) => {
      const events: ChatEvent[] = [];
      await runtime.run({
        requestId,
        request: {
          conversationId: "conv-reused",
          model: "fake/fake-model",
          messages: [{ role: "user", content: text }],
        },
        cwd,
        models,
        model,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      });
      return events;
    };

    const runOnceWith = async (conversationId: string, requestId: string, text: string) => {
      const events: ChatEvent[] = [];
      await runtime.run({
        requestId,
        request: { conversationId, model: "fake/fake-model", messages: [{ role: "user", content: text }] },
        cwd,
        models,
        model,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
      });
      return events;
    };

    const firstEvents = await runOnce("req-a", "turn one");
    const secondEvents = await runOnce("req-b", "turn two");

    expect(firstEvents.at(-1)).toEqual({ type: "completed", requestId: "req-a" });
    expect(secondEvents.at(-1)).toEqual({ type: "completed", requestId: "req-b" });

    const { JsonlSessionRepo } = await realAgentCoreLoaders.loadAgentCore!();
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
    const sessions = await repo.list({ cwd });
    // Exactly one session file on disk -- proves the second run() found and
    // reused the existing session (openOrCreateSession's match branch),
    // rather than creating a second session file (kills the
    // ".find(() => undefined)" and "if (false) return repo.open(match)"
    // mutants).
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-reused");

    const session = await repo.open(sessions[0]);
    const entries = await session.getEntries();
    const userMessages = entries
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    expect(userMessages).toEqual([
      [{ type: "text", text: "turn one" }],
      [{ type: "text", text: "turn two" }],
    ]);

    // Create a *second*, more-recently-created session ("conv-other") in the
    // same cwd, then go back to "conv-reused" a third time. `repo.list()`
    // sorts newest-first, so "conv-other" would be found *first* if the
    // match were not filtered by id -- proves openOrCreateSession's
    // `.find((metadata) => metadata.id === conversationId)` genuinely
    // matches by id rather than picking the first/any session (kills the
    // "find((metadata) => true)" mutant).
    await runOnceWith("conv-other", "req-c", "unrelated conversation");
    const thirdEvents = await runOnce("req-d", "turn three");
    expect(thirdEvents.at(-1)).toEqual({ type: "completed", requestId: "req-d" });

    const allSessions = await repo.list({ cwd });
    expect(allSessions).toHaveLength(2);

    const reusedSession = await repo.open(allSessions.find((s) => s.id === "conv-reused")!);
    const reusedUserMessages = (await reusedSession.getEntries())
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    expect(reusedUserMessages).toEqual([
      [{ type: "text", text: "turn one" }],
      [{ type: "text", text: "turn two" }],
      [{ type: "text", text: "turn three" }],
    ]);

    const otherSession = await repo.open(allSessions.find((s) => s.id === "conv-other")!);
    const otherUserMessages = (await otherSession.getEntries())
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => (e.type === "message" && e.message.role === "user" ? e.message.content : null));
    expect(otherUserMessages).toEqual([[{ type: "text", text: "unrelated conversation" }]]);
  });
});

/**
 * A stateful fake stream that emits a real tool call on its first
 * invocation (routed through the real `list_files` read-only tool against a
 * real temp directory) and a plain text reply on its second invocation --
 * exercises the real `AgentHarness` tool-execution loop end-to-end, so
 * `AgentRuntime.forward`'s "tool_execution_start" branch is exercised with a
 * real toolName/args pair instead of being permanently uncovered.
 */
function fakeToolCallingStream(): () => AssistantMessageEventStream {
  let call = 0;
  return () => {
    call += 1;
    const stream = createAssistantMessageEventStream();
    const isFirstCall = call === 1;
    queueMicrotask(() => {
      if (isFirstCall) {
        const toolCall = { type: "toolCall" as const, id: "call-1", name: "list_files", arguments: { path: "." } };
        const base = {
          role: "assistant" as const,
          api: "openai-completions" as const,
          provider: "fake",
          model: "fake-model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse" as const,
          timestamp: Date.now(),
        };
        const finalMessage = { ...base, content: [toolCall] };
        stream.push({ type: "start", partial: { ...base, content: [] } });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...base, content: [] } });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: finalMessage });
        stream.push({ type: "done", reason: "toolUse", message: finalMessage });
        stream.end(finalMessage);
      } else {
        const base = {
          role: "assistant" as const,
          content: [] as { type: "text"; text: string }[],
          api: "openai-completions" as const,
          provider: "fake",
          model: "fake-model",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        const finalMessage = { ...base, content: [{ type: "text" as const, text: "done listing" }] };
        stream.push({ type: "start", partial: { ...base, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...base, content: [] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "done listing", partial: { ...base, content: [] } });
        stream.push({ type: "text_end", contentIndex: 0, content: "done listing", partial: finalMessage });
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      }
    });
    return stream;
  };
}

describe("AgentRuntime tool-call forwarding (real AgentHarness + real list_files tool)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-runtime-tools-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("forwards a real tool_execution_start event as a tool-call ChatEvent with the exact toolName and arguments", async () => {
    const models = createModels({});
    const stream = fakeToolCallingStream();
    models.setProvider(
      createProvider({
        id: "fake",
        baseUrl: "https://fake.local",
        auth: { apiKey: { name: "fake", resolve: async () => ({ auth: { apiKey: "fake-key" } }) } },
        models: [
          {
            id: "fake-model",
            name: "fake-model",
            api: "openai-completions",
            provider: "fake",
            baseUrl: "https://fake.local",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4096,
          },
        ],
        api: { stream, streamSimple: stream },
      }),
    );
    const model = models.getProvider("fake")!.getModels()[0];

    const request: StartChatRequest = {
      conversationId: "conv-tool-call",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "list the files" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realAgentCoreLoaders);

    await runtime.run({
      requestId: "req-tool",
      request,
      cwd,
      models,
      model,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    const toolCallEvent = events.find((e) => e.type === "tool-call");
    expect(toolCallEvent).toEqual({
      type: "tool-call",
      requestId: "req-tool",
      toolName: "list_files",
      arguments: { path: "." },
    });
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-tool" });
    expect(events.some((e) => e.type === "text-delta" && e.text === "done listing")).toBe(true);
  });
});
