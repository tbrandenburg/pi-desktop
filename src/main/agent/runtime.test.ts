import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";
import { buildFakeModelRuntime, FAKE_PROVIDER_ID } from "./test-support/fake-model-runtime";
import type { ChatEvent, StartChatRequest } from "../../shared/events";

describe("AgentRuntime (real AgentSession + real SessionManager, fake network)", () => {
  let cwd: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-runtime-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-dir-"));
    // Isolates every default-resolved pi-coding-agent path (auth.json,
    // models.json, and -- crucially for these tests -- `SessionManager`'s
    // default cwd-encoded session directory) away from the real
    // developer's `~/.pi/agent`, exactly like `getAgentDir()` itself
    // documents (`config.js`: "if PI_CODING_AGENT_DIR is set, use it"). This is
    // also what `AgentRuntime.run` in production relies on implicitly
    // (it never passes an explicit `agentDir`/`sessionDir` override).
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
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
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events[0]).toEqual({ type: "started", requestId: "req-1" });
    expect(events.some((e) => e.type === "text-delta" && e.text === "Hi ")).toBe(true);
    expect(events.some((e) => e.type === "text-delta" && e.text === "there")).toBe(true);
    expect(events.some((e) => e.type === "reasoning-delta" && e.text === "pondering...")).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 3 && e.outputTokens === 5)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

    // Real on-disk proof: a fresh SessionManager.list() (default,
    // cwd-encoded resolution -- same as `AgentRuntime` itself uses) must
    // find the persisted session under the same conversationId.
    const { SessionManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const sessions = await SessionManager.list(cwd);
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
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-3" });

    const { SessionManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const sessions = await SessionManager.list(cwd);
    const sessionManager = SessionManager.open(sessions[0].path);
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
    // Exactly one session file on disk -- proves the second run() found and
    // reused the existing session, rather than creating a second one.
    const sessions = await SessionManager.list(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("conv-reused");

    const sessionManager = SessionManager.open(sessions[0].path);
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
    const allSessions = await SessionManager.list(cwd);
    expect(allSessions).toHaveLength(2);
    expect(allSessions.map((s) => s.id).sort()).toEqual(["conv-other", "conv-reused"]);
  });
});
