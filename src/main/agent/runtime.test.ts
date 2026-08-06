import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime";
import { IpcUIContextBridge } from "./ui-context";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";
import { buildFakeModelRuntime, FAKE_PROVIDER_ID } from "./test-support/fake-model-runtime";
import { buildTestResourceLoader, type TestExtensionLog } from "./test-support/inline-test-extension";
import type { ChatEvent, ExtensionUIRequest, StartChatRequest } from "../../shared/events";

const REAL_PI_PACKAGES_DIR = path.resolve(__dirname, "../../../resources/pi-packages/read-only-tools");

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

describe("AgentRuntime bundled pi-package discovery (ADR 0001 §3.5, issue #97)", () => {
  let cwd: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pi-package-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pi-package-agent-dir-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("run() with a real piPackagesDir genuinely discovers read_file/list_files through additionalExtensionPaths and executes a real read against the session cwd", async () => {
    fs.writeFileSync(path.join(cwd, "discovered.txt"), "found via real pi-package pipeline");

    const runtime = new AgentRuntime(realCodingAgentLoaders, REAL_PI_PACKAGES_DIR);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);
    const request: StartChatRequest = {
      conversationId: "conv-pi-package",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "hello" }],
    };
    const events: ChatEvent[] = [];

    await runtime.run({
      requestId: "req-pi-package-1",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    // Real proof the chat turn itself still completes cleanly with the
    // bundled package wired in (no regression to the base chat flow).
    expect(events[0]).toEqual({ type: "started", requestId: "req-pi-package-1" });
    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-pi-package-1" });

    // Real proof of *discovery*: build the exact same kind of resource
    // loader `run()` builds internally (can't reach into `run()`'s private
    // loader directly), pointed at the real bundled package dir, and assert
    // the real extension-loading pipeline (`additionalExtensionPaths` +
    // `DefaultResourceLoader` + jiti) actually found and loaded it -- not
    // just that the directory exists on disk.
    const { DefaultResourceLoader, SettingsManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      additionalExtensionPaths: [REAL_PI_PACKAGES_DIR],
    });
    await loader.reload();
    const extensionsResult = loader.getExtensions();

    expect(extensionsResult.errors).toEqual([]);
    const toolNames = extensionsResult.extensions.flatMap((extension) => Array.from(extension.tools.keys()));
    expect(toolNames).toEqual(expect.arrayContaining(["read_file", "list_files"]));

    // Real proof the *discovered* tool definition (not a separately
    // constructed one) actually reads real files when executed.
    const readFileTool = extensionsResult.extensions
      .flatMap((extension) => Array.from(extension.tools.values()))
      .find((tool) => tool.definition.name === "read_file")!;
    const result = await readFileTool.definition.execute(
      "call-real",
      { path: "discovered.txt" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { cwd } as any,
    );
    expect(result.content).toEqual([{ type: "text", text: "found via real pi-package pipeline" }]);
    expect(result.details).toEqual({ path: "discovered.txt" });
  });

  it("run() without a piPackagesDir never registers read_file/list_files -- proves the bundled package is genuinely optional, not silently always-on", async () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const { modelRuntime, model } = await buildFakeModelRuntime(agentDir);
    const request: StartChatRequest = {
      conversationId: "conv-no-pi-package",
      model: "fake/fake-model",
      messages: [{ role: "user", content: "hello" }],
    };
    const events: ChatEvent[] = [];

    await runtime.run({
      requestId: "req-no-pi-package",
      request,
      cwd,
      providerId: FAKE_PROVIDER_ID,
      model,
      modelRuntime,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });

    expect(events.at(-1)).toEqual({ type: "completed", requestId: "req-no-pi-package" });

    const { DefaultResourceLoader, SettingsManager } = await realCodingAgentLoaders.loadCodingAgent!();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    });
    await loader.reload();
    const toolNames = loader
      .getExtensions()
      .extensions.flatMap((extension) => Array.from(extension.tools.keys()));
    expect(toolNames).not.toContain("read_file");
    expect(toolNames).not.toContain("list_files");
  });
});
