import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime";
import { IpcUIContextBridge } from "./ui-context";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";
import { buildFakeModelRuntime, buildFakeFailingModelRuntime, FAKE_PROVIDER_ID } from "./test-support/fake-model-runtime";
import { buildTestResourceLoader, type TestExtensionLog } from "./test-support/inline-test-extension";
import { PackageService } from "../packages/service";
import type { ChatEvent, ExtensionUIRequest, StartChatRequest } from "../../shared/events";

/**
 * Writes a real, tiny local pi-package to disk: a `package.json` with a
 * `pi.extensions` manifest entry and a plain CommonJS extension module that
 * registers an observable, distinctively-named `pi.registerCommand` --
 * mirrors `service.test.ts`'s own `writeFixturePackage` helper (duplicated
 * here rather than imported/exported, per this issue's scope being limited
 * to `runtime.ts`/`runtime.test.ts`).
 */
function writeFixturePackage(dir: string, markerName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { extensions: ["extension.js"] } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "extension.js"),
    `module.exports = function (pi) {
      pi.registerCommand("${markerName}", { description: "marker command" }, async () => {});
    };`,
  );
  return dir;
}

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

  it("emits a 'error' ChatEvent (not 'completed') when session.prompt() resolves with a stopReason:'error' assistant message -- e.g. a real suspended-account 403 mid-call, found via production verification of #118/#119/#120", async () => {
    const request: StartChatRequest = {
      conversationId: "conv-provider-error",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "Hello, ping" }],
    };

    const events: ChatEvent[] = [];
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const providerErrorMessage =
      'OAuth refresh failed for github-copilot: 403 Forbidden: {\n  "message": "Sorry. Your account was suspended"\n}';
    const { modelRuntime, model } = await buildFakeFailingModelRuntime(agentDir, providerErrorMessage);

    await runtime.run({
      requestId: "req-provider-error",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events.some((e) => e.type === "completed")).toBe(false);
    expect(events.at(-1)).toEqual({
      type: "error",
      requestId: "req-provider-error",
      message: providerErrorMessage,
    });
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

  it("issue #120: forwards a real auto_retry_start AgentSessionEvent as a 'retrying' ChatEvent with the real attempt/maxAttempts fields", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];

    // `forward` is private; `AgentSessionEvent` is a third-party union this
    // app doesn't control (issue #111), so this exercises the exact shape
    // `agent-session.d.ts` documents for `auto_retry_start` rather than
    // going through a full simulated network retry.
    (runtime as unknown as { forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void }).forward(
      "req-retry",
      {
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: "429 rate limited",
      },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "retrying", requestId: "req-retry", attempt: 2, maxAttempts: 3 });
  });

  it("issue #120: does NOT emit any ChatEvent for auto_retry_end -- the renderer clears the indicator itself on the next event", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];

    (runtime as unknown as { forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void }).forward(
      "req-retry-end",
      { type: "auto_retry_end", success: true, attempt: 2 },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(0);
  });
});

describe("AgentRuntime UI bridge (ADR 0001 §3.4 Phase 2, issue #91)", () => {
  let cwd: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ui-bridge-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-ui-bridge-agent-dir-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("listCommands() discovers a real pi.registerCommand registration from an inline extension", async () => {
    const log: TestExtensionLog = { notified: [], invoked: false };
    const resourceLoader = await buildTestResourceLoader(cwd, log);
    const runtime = new AgentRuntime(realCodingAgentLoaders);

    const commands = await runtime.listCommands(cwd, resourceLoader);

    expect(commands).toEqual([{ name: "greet", description: "Greets after confirming with the user" }]);
    // Discovery alone must never invoke the command handler.
    expect(log.invoked).toBe(false);
  });

  it("listCommands() returns an empty list when no extension registers a command", async () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const commands = await runtime.listCommands(cwd);
    expect(commands).toEqual([]);
    expect(Array.isArray(commands)).toBe(true);
  });

  it("run() with a real IpcUIContextBridge round-trips ctx.ui.confirm/input/notify through a /greet command end-to-end", async () => {
    const log: TestExtensionLog = { notified: [], invoked: false };
    const resourceLoader = await buildTestResourceLoader(cwd, log);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => {
      pushed.push(request);
      // Answer synchronously and deterministically: confirm "yes", then
      // supply a name for the input dialog. A real renderer would instead
      // call `respondExtensionUI` from a click handler -- this proves the
      // main-process side of that contract (the promise genuinely awaits
      // an out-of-band `respond()` call, not an immediate resolution).
      if (request.kind === "confirm") {
        queueMicrotask(() => bridge.respond(request.requestId, { kind: "confirm", value: true }));
      } else if (request.kind === "input") {
        queueMicrotask(() => bridge.respond(request.requestId, { kind: "input", value: "Ada" }));
      }
    });

    const request: StartChatRequest = {
      conversationId: "conv-ui-bridge",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "/greet issue-91" }],
    };
    const events: ChatEvent[] = [];

    const runtime = new AgentRuntime(realCodingAgentLoaders);
    await runtime.run({
      requestId: "req-ui-1",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      uiContext: bridge.uiContext,
      resourceLoader,
    });

    // The extension handler actually ran and received the real resolved
    // answers from the bridge -- not defaults/no-ops.
    expect(log.invoked).toBe(true);
    expect(log.confirmResult).toBe(true);
    expect(log.inputResult).toBe("Ada");
    expect(log.notified).toEqual(["Hello Ada (issue-91)"]);

    // Both dialog-capable requests were genuinely pushed toward "the
    // renderer" (captured here instead) before being answered.
    expect(pushed.some((r) => r.kind === "confirm" && r.title === "Greet?")).toBe(true);
    expect(pushed.some((r) => r.kind === "input" && r.title === "Name?")).toBe(true);

    // A slash-command turn still completes the chat turn cleanly.
    expect(events[0]).toEqual({ type: "started", requestId: "req-ui-1" });
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-ui-1" });
  });

  it("run() without a uiContext leaves ctx.ui.confirm answered with the safe default (headless, matching Phase 1)", async () => {
    const log: TestExtensionLog = { notified: [], invoked: false };
    const resourceLoader = await buildTestResourceLoader(cwd, log);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);

    const request: StartChatRequest = {
      conversationId: "conv-headless",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "/greet" }],
    };
    const events: ChatEvent[] = [];

    const runtime = new AgentRuntime(realCodingAgentLoaders);
    await runtime.run({
      requestId: "req-headless-1",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      resourceLoader,
      // uiContext intentionally omitted.
    });

    expect(log.invoked).toBe(true);
    // Headless `ExtensionUIContext.confirm` (pi-coding-agent's own default
    // when no uiContext is bound) resolves to `false` -- the handler must
    // therefore take the "cancelled" branch, never the input/notify one.
    expect(log.confirmResult).toBe(false);
    expect(log.inputResult).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-headless-1" });
  });
});

describe("AgentRuntime.listCommands() library-default resolution (issue #109: no trust gate)", () => {
  let cwd: string;
  let agentDir: string;
  let fixtureDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-109-cwd-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-109-agentdir-"));
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-109-fixture-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("a package installed via PackageService (settings.json-configured, real production call shape, no explicit resourceLoader) DOES appear in listCommands() -- proves noExtensions removal restored library-default resolution", async () => {
    const markerName = "issue-109-restored-marker-cmd";
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-109"), markerName);

    // Real `PackageService` sharing the same `agentDir`/`settings.json`
    // AgentRuntime uses (per #104), with the single pre-install confirm
    // accepted.
    const service = new PackageService(async () => true, realCodingAgentLoaders);
    const installed = await service.install(source);
    expect(installed.source).toBe(source);

    // Real production call shape: `AgentRuntime` constructed exactly like
    // `ipc.ts` wires it in production, and `listCommands()` called with NO
    // explicit `resourceLoader` argument -- this is exactly how
    // `ChatService.listCommands()` and `ipc.ts`'s `chat:list-commands`
    // handler call it in production.
    const runtime = new AgentRuntime(realCodingAgentLoaders);

    const commands = await runtime.listCommands(cwd);
    const commandNames = commands.map((c) => c.name);

    // Before issue #109's fix, `buildAdditionalPathsResourceLoader` set
    // `noExtensions: true`, which suppressed ALL settings.json-derived
    // extension resolution regardless of trust -- a settings.json
    // configured package's command would never appear here. After
    // removing both the trust filter and `noExtensions: true` together,
    // library-default resolution is restored and the command must appear.
    expect(commandNames).toContain(markerName);
    expect(Array.isArray(commands)).toBe(true);
  });
});

