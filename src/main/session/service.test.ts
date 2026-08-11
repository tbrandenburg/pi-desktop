import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionService } from "./service";
import { AgentRuntime } from "../agent/runtime";
import { realCodingAgentLoaders } from "../agent/test-support/real-coding-agent-loaders";
import { realAgentCoreLoaders } from "../agent/test-support/real-agent-core-loaders";
import { buildFakeModelRuntime, FAKE_PROVIDER_ID } from "../agent/test-support/fake-model-runtime";
import type { ChatEvent, StartChatRequest } from "../../shared/events";

/**
 * Proves the issue #90 follow-up fix end-to-end: a session written by the
 * real `AgentRuntime`/`SessionManager` path (pi-coding-agent) is genuinely
 * visible via `SessionService.list()`/`.get()`, which reads through that
 * same `SessionManager` class (issue #208 follow-up -- not
 * `@earendil-works/pi-agent-core`'s `JsonlSessionRepo`, which expects a
 * different on-disk session format), against a real throwaway disk
 * directory -- not a mock of either session API. Before the #90 fix,
 * `SessionService` pointed its session lookup at bare `cwd` while
 * `AgentRuntime` wrote to `<agentDir>/sessions/<encoded-cwd>`, so `list()`
 * always returned `[]` for a session `AgentRuntime` had just created.
 *
 * Isolation from the real developer's `~/.pi/agent` uses the same
 * `PI_CODING_AGENT_DIR` env var trick `runtime.test.ts` uses: both `AgentRuntime`
 * (via `SessionManager`'s default resolution) and `SessionService` (via
 * `SessionManager.list`'s own default resolution) independently honor it,
 * so they land on the exact same real default
 * `<agentDir>/sessions/<encoded-cwd>` directory with zero extra plumbing.
 */
describe("SessionService sees sessions written by the real AgentRuntime (issue #90 follow-up)", () => {
  let cwd: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-session-service-cwd-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-session-service-agent-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function makeSessionService(): SessionService {
    return new SessionService(() => cwd, realAgentCoreLoaders, realCodingAgentLoaders);
  }

  async function runRealChatTurn(conversationId: string, text: string): Promise<ChatEvent[]> {
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const request: StartChatRequest = {
      conversationId,
      model: "fake/fake-model",
      messages: [{ role: "user", content: text }],
    };
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
    return events;
  }

  it("lists a session created by a real AgentRuntime chat turn", async () => {
    const events = await runRealChatTurn("conv-visible-1", "hello from the real runtime");
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

    const sessionService = makeSessionService();
    const summaries = await sessionService.list();

    // Two real, independent behavioral assertions: the session the runtime
    // just wrote is actually found (not an empty list), and it's found by
    // its real conversationId, not some unrelated/default entry.
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe("conv-visible-1");
  });

  it("reads back the exact real message content via .get(id)", async () => {
    await runRealChatTurn("conv-visible-2", "what is the real message content");

    const sessionService = makeSessionService();
    const record = await sessionService.get("conv-visible-2");

    expect(record).not.toBeNull();
    expect(record?.messages).toEqual([
      { role: "user", content: "what is the real message content" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  it("deletes a session created by a real AgentRuntime chat turn", async () => {
    await runRealChatTurn("conv-visible-3", "please delete me afterward");

    const sessionService = makeSessionService();
    expect(await sessionService.list()).toHaveLength(1);

    await sessionService.delete("conv-visible-3");

    expect(await sessionService.list()).toHaveLength(0);
  });

  it("returns an empty list when no session has been created for this cwd yet", async () => {
    const sessionService = makeSessionService();
    const summaries = await sessionService.list();
    expect(summaries).toEqual([]);
    expect(await sessionService.get("nonexistent")).toBeNull();
  });
});
