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
 * Regression test for issue #112: proves `AgentRuntime` (via
 * `SessionManager`'s default cwd-encoded session directory) and
 * `SessionService` (via a hand-built `JsonlSessionRepo` pointed at
 * `<agentDir>/sessions`, see `service.ts`'s own doc comment) independently
 * resolve to the *same* on-disk directory for a *given* cwd -- not just
 * that some directory happens to be readable by both.
 *
 * `service.test.ts` already proves a single cwd's session round-trips
 * through both real code paths. This file adds two things that go beyond
 * that:
 *
 * 1. A two-*different*-cwds check: sessions written for cwdA and cwdB via
 *    the real `AgentRuntime` must each be visible ONLY through a
 *    `SessionService` scoped to their own respective cwd -- proving the
 *    two classes agree on *which* directory a specific cwd encodes to, not
 *    merely that they happen to share one single directory in a
 *    single-cwd test.
 * 2. A real (uncommitted-break) demonstration that this test genuinely
 *    fails when the alignment is broken: a `JsonlSessionRepo` pointed at
 *    the pre-#90-fix, incorrect `sessionsRoot` (bare `cwd`, the historical
 *    bug `service.ts`'s own comment references) does NOT see the session
 *    `AgentRuntime` wrote -- confirming this test class would have caught
 *    that regression, without modifying `service.ts` itself.
 */
describe("AgentRuntime and SessionService agree on session-directory encoding (issue #112)", () => {
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-dir-alignment-agent-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  async function writeRealSession(cwd: string, conversationId: string, text: string): Promise<ChatEvent[]> {
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

  it("scopes sessions to their own cwd's directory -- a session written for cwdA is invisible to a SessionService scoped to cwdB and vice versa", async () => {
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-dir-alignment-cwd-a-"));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-dir-alignment-cwd-b-"));
    try {
      const eventsA = await writeRealSession(cwdA, "conv-in-a", "hello from cwd A");
      const eventsB = await writeRealSession(cwdB, "conv-in-b", "hello from cwd B");
      expect(eventsA.at(-1)).toEqual({ type: "completed", requestId: "req-1" });
      expect(eventsB.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

      const serviceA = new SessionService(() => cwdA, realAgentCoreLoaders, realCodingAgentLoaders);
      const serviceB = new SessionService(() => cwdB, realAgentCoreLoaders, realCodingAgentLoaders);

      const summariesA = await serviceA.list();
      const summariesB = await serviceB.list();

      // Each service must see exactly its own cwd's session, with the
      // correct id -- not the other cwd's, and not both (which would
      // indicate the encoding collapsed two distinct cwds together).
      expect(summariesA).toHaveLength(1);
      expect(summariesA[0].id).toBe("conv-in-a");
      expect(summariesB).toHaveLength(1);
      expect(summariesB[0].id).toBe("conv-in-b");

      expect(await serviceA.get("conv-in-b")).toBeNull();
      expect(await serviceB.get("conv-in-a")).toBeNull();
    } finally {
      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
    }
  });

  it("proves this alignment check actually catches a broken sessionsRoot -- a JsonlSessionRepo pointed at bare cwd (the pre-#90 bug) does not see a session written by the real AgentRuntime", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-dir-alignment-broken-"));
    try {
      const events = await writeRealSession(cwd, "conv-should-be-invisible", "hello");
      expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-1" });

      // Deliberately mirror the historical bug this issue is guarding
      // against: a `JsonlSessionRepo` rooted at bare `cwd` instead of
      // `<agentDir>/sessions` (i.e. `service.ts` before the #90 fix). This
      // does not modify `service.ts`; it's a standalone repo built inline
      // from the same real, unmocked `pi-agent-core` classes to prove the
      // alignment check has real discriminating power.
      const { JsonlSessionRepo } = await realAgentCoreLoaders.loadAgentCore!();
      const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
      const env = new NodeExecutionEnv({ cwd });
      const brokenRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
      const brokenList = await brokenRepo.list({ cwd });

      expect(brokenList).toHaveLength(0);

      // Meanwhile the real, correctly-aligned SessionService still finds it.
      const service = new SessionService(() => cwd, realAgentCoreLoaders, realCodingAgentLoaders);
      const summaries = await service.list();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe("conv-should-be-invisible");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
