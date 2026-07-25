import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, createProvider, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentRuntime } from "./agent-runtime";
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
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...base, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Hi ", partial: { ...base, content: [] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "there", partial: { ...base, content: [] } });
    const finalMessage = { ...base, content: [{ type: "text" as const, text: "Hi there" }] };
    stream.push({ type: "text_end", contentIndex: 0, content: "Hi there", partial: finalMessage });
    stream.push({ type: "done", reason: "stop", message: finalMessage });
    stream.end(finalMessage);
  });
  return stream;
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
    const model = models.getProvider("fake")!.getModels()[0];

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
});
