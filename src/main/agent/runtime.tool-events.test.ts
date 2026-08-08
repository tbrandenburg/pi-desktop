import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "./runtime";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";
import type { ChatEvent } from "../../shared/events";

describe("AgentRuntime tool-call/tool-result event forwarding (issue #151)", () => {
  let cwd: string;
  let agentDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-runtime-tool-events-"));
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-agent-dir-tool-events-"));
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

  it("issue #151: forwards a real tool_execution_start AgentSessionEvent as a 'tool-call' ChatEvent carrying the exact toolCallId", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const forward = (runtime as unknown as {
      forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void;
    }).forward;

    forward.call(
      runtime,
      "req-tool-1",
      { type: "tool_execution_start", toolCallId: "call-abc-123", toolName: "bash", args: { command: "ls" } },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool-call",
      requestId: "req-tool-1",
      toolCallId: "call-abc-123",
      toolName: "bash",
      arguments: { command: "ls" },
    });
  });

  it("issue #151: a matching tool_execution_end (isError: false) produces a 'tool-result' ChatEvent with isError:false and a durationMs >= 0", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const forward = (runtime as unknown as {
      forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void;
    }).forward;

    forward.call(
      runtime,
      "req-tool-2",
      { type: "tool_execution_start", toolCallId: "call-success-1", toolName: "read", args: { path: "a.txt" } },
      (event) => events.push(event),
    );
    forward.call(
      runtime,
      "req-tool-2",
      { type: "tool_execution_end", toolCallId: "call-success-1", toolName: "read", result: "contents", isError: false },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(2);
    const result = events[1];
    expect(result).toMatchObject({
      type: "tool-result",
      requestId: "req-tool-2",
      toolCallId: "call-success-1",
      isError: false,
    });
    expect(result.type === "tool-result" && typeof result.durationMs === "number" && result.durationMs >= 0).toBe(true);
  });

  it("issue #151: an isError:true tool_execution_end produces isError:true in the emitted tool-result event", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const forward = (runtime as unknown as {
      forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void;
    }).forward;

    forward.call(
      runtime,
      "req-tool-3",
      { type: "tool_execution_start", toolCallId: "call-fail-1", toolName: "bash", args: { command: "false" } },
      (event) => events.push(event),
    );
    forward.call(
      runtime,
      "req-tool-3",
      { type: "tool_execution_end", toolCallId: "call-fail-1", toolName: "bash", result: "exit 1", isError: true },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "tool-result",
      requestId: "req-tool-3",
      toolCallId: "call-fail-1",
      isError: true,
    });
    // Distinguishes this from the isError:false case above -- a broken
    // pass-through of `event.isError` would produce `false` here too.
    expect((events[1] as { isError: boolean }).isError).toBe(true);
  });

  it("issue #151: tool_execution_end for an unknown toolCallId (no matching start) still emits a tool-result with durationMs 0, not a crash", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const forward = (runtime as unknown as {
      forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void;
    }).forward;

    forward.call(
      runtime,
      "req-tool-4",
      { type: "tool_execution_end", toolCallId: "call-orphan", toolName: "bash", result: "ok", isError: false },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool-result",
      requestId: "req-tool-4",
      toolCallId: "call-orphan",
      isError: false,
      durationMs: 0,
    });
  });

  it("issue #157: forwards a real AgentToolResult's 'details' payload on the emitted 'tool-result' ChatEvent", () => {
    const runtime = new AgentRuntime(realCodingAgentLoaders);
    const events: ChatEvent[] = [];
    const forward = (runtime as unknown as {
      forward: (requestId: string, event: unknown, emit: (e: ChatEvent) => void) => void;
    }).forward;

    // Hand-computed expected payload -- not derived by calling the code
    // under test to build its own expectation.
    const expectedDetails = { results: [{ title: "Exa Weather", url: "https://example.com/weather" }] };

    forward.call(
      runtime,
      "req-tool-5",
      { type: "tool_execution_start", toolCallId: "call-search-1", toolName: "web_search", args: { query: "weather" } },
      (event) => events.push(event),
    );
    forward.call(
      runtime,
      "req-tool-5",
      {
        type: "tool_execution_end",
        toolCallId: "call-search-1",
        toolName: "web_search",
        result: { content: [], details: expectedDetails },
        isError: false,
      },
      (event) => events.push(event),
    );

    expect(events).toHaveLength(2);
    const toolResult = events[1] as { type: "tool-result"; result?: unknown };
    expect(toolResult.result).toEqual(expectedDetails);
    expect(toolResult.result).toBe(expectedDetails);
  });
});
