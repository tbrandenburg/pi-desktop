import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session } from "@earendil-works/pi-agent-core";
import { projectSessionRecord, projectSessionSummary } from "./projection";
import { realAgentCoreLoaders } from "../agent/test-support/real-agent-core-loaders";

describe("session-projection (real JsonlSessionRepo, real disk)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-projection-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function makeRepo() {
    const { JsonlSessionRepo } = await realAgentCoreLoaders.loadAgentCore!();
    const { NodeExecutionEnv } = await realAgentCoreLoaders.loadAgentCoreNode!();
    const env = new NodeExecutionEnv({ cwd });
    return new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
  }

  async function appendModelChange(session: Session, provider: string, modelId: string) {
    await session.appendEntry(
      { type: "model_change", id: session.idGenerator.next(), provider, modelId },
      "main",
    );
  }

  it("titles a session from its first real user message, trimmed and truncated", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s1" });
    await session.appendMessage({
      role: "user",
      content: `  ${"x".repeat(100)}  `,
      timestamp: Date.now(),
    });
    await appendModelChange(session, "openai", "gpt-4o-mini");

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe(`${"x".repeat(80)}...`);
    expect(summary.model).toBe("openai/gpt-4o-mini");
    expect(summary.id).toBe("s1");
  });

  it("prefers an explicit session_info name over the first user message", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s2" });
    await session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    await session.setName("Custom Title");

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("Custom Title");
  });

  it("falls back to '(untitled)' when there is no user message or session name", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s3" });

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("(untitled)");
  });

  it("projects a compaction entry as a single summary bubble, omitting summarized turns", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s4" });
    await session.appendMessage({ role: "user", content: "turn one", timestamp: Date.now() });
    await session.appendEntry(
      {
        type: "compaction",
        id: session.idGenerator.next(),
        summary: "Summary of turn one",
        retainedTail: [],
        tokensBefore: 100,
      },
      "main",
    );
    await session.appendMessage({ role: "user", content: "turn two", timestamp: Date.now() });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    expect(record.messages).toEqual([
      { role: "system", content: "Summary of turn one" },
      { role: "user", content: "turn two" },
    ]);
  });

  it("projects a branch_summary entry as a system bubble", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s4b" });
    const entryId = await session.appendMessage({ role: "user", content: "turn one", timestamp: Date.now() });
    await session.appendEntry(
      {
        type: "branch_summary",
        id: session.idGenerator.next(),
        fromId: entryId,
        summary: "Branch summary text",
      },
      "main",
    );

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    expect(record.messages).toEqual([
      { role: "user", content: "turn one" },
      { role: "system", content: "Branch summary text" },
    ]);
  });

  it("prefers the most recently appended session_info entry when multiple exist", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s5" });
    await session.setName("First Title");
    await session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    await session.setName("Second Title");

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("Second Title");
    expect(summary.title).not.toBe("First Title");
  });

  it("prefers the most recently appended model_change entry when multiple exist", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s6" });
    await appendModelChange(session, "openai", "gpt-4o-mini");
    await session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    await appendModelChange(session, "anthropic", "claude-3");

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.model).toBe("anthropic/claude-3");
    expect(summary.model).not.toBe("openai/gpt-4o-mini");
  });

  it("skips a leading assistant message and titles from the first real user message", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s7" });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "assistant said this first" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await session.appendMessage({ role: "user", content: "the real user message", timestamp: Date.now() });

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("the real user message");
    expect(summary.title).not.toContain("assistant said this first");
  });

  it("derives the title from a user message whose content is content blocks, not a plain string", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s8" });
    await session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "block one" },
        { type: "text", text: "block two" },
      ],
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("block one block two");
  });

  it("falls back to '(untitled)' when the only user message trims to an empty string", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s9" });
    await session.appendMessage({ role: "user", content: "   ", timestamp: Date.now() });

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe("(untitled)");
  });

  it("does not truncate or add ellipsis to a title exactly at the max length boundary", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s10" });
    const exact = "y".repeat(80);
    await session.appendMessage({ role: "user", content: exact, timestamp: Date.now() });

    const metadata = await session.getMetadata();
    const summary = await projectSessionSummary(session, (metadata as { path: string }).path);

    expect(summary.title).toBe(exact);
    expect(summary.title.endsWith("...")).toBe(false);
  });

  it("projects an assistant message's text content blocks joined into a single message", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s11" });
    await session.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    expect(record.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "part onepart two" },
    ]);
  });

  it("projects a matched toolCall/toolResult pair into the following assistant message's activity", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s13" });
    await session.appendMessage({ role: "user", content: "list files", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "file1.txt" }],
      isError: false,
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Found one file." }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    const finalAssistant = record.messages.find(
      (message) => message.role === "assistant" && message.content === "Found one file.",
    );
    expect(finalAssistant?.activity).toHaveLength(1);
    expect(finalAssistant?.activity?.[0]?.toolName).toBe("bash");
  });

  it("projects a toolResult with a source-shaped 'details' payload into ActivityRecord.sources (issue #157)", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s13b" });
    await session.appendMessage({ role: "user", content: "search the web", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-search-1", name: "web_search", arguments: { query: "weather" } }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "toolResult",
      toolCallId: "call-search-1",
      toolName: "web_search",
      content: [{ type: "text", text: "1 result" }],
      details: { results: [{ title: "Exa Weather", url: "https://example.com/weather" }] },
      isError: false,
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "It's sunny." }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    const finalAssistant = record.messages.find(
      (message) => message.role === "assistant" && message.content === "It's sunny.",
    );
    expect(finalAssistant?.activity?.[0]?.sources).toEqual([
      { title: "Exa Weather", url: "https://example.com/weather" },
    ]);
    expect(finalAssistant?.activity?.[0]?.sources).toHaveLength(1);
  });

  it("leaves ActivityRecord.sources absent (not an empty array) when the toolResult's 'details' payload has no recognizable source shape", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s13c" });
    await session.appendMessage({ role: "user", content: "list files", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-bash-1", name: "bash", arguments: { command: "ls" } }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "toolResult",
      toolCallId: "call-bash-1",
      toolName: "bash",
      content: [{ type: "text", text: "file1.txt" }],
      details: "file1.txt",
      isError: false,
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Found one file." }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    const finalAssistant = record.messages.find(
      (message) => message.role === "assistant" && message.content === "Found one file.",
    );
    expect(finalAssistant?.activity?.[0]?.sources).toBeUndefined();
    expect(finalAssistant?.activity?.[0]?.toolName).toBe("bash");
  });

  it("does not add an activity field to a plain-text assistant message with no tool calls", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s14" });
    await session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    const assistantMessage = record.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toBe("hi there");
    expect(assistantMessage?.activity).toBeUndefined();
  });

  it("does not throw on an unmatched toolCall with no corresponding toolResult", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s15" });
    await session.appendMessage({ role: "user", content: "do something", timestamp: Date.now() });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-orphan", name: "bash", arguments: { command: "ls" } }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    const assistantMessage = record.messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toBe("");
    expect(assistantMessage?.activity).toBeUndefined();
  });

  it("projects a user message whose content is content blocks (not a string) into joined text", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s12" });
    await session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
      timestamp: Date.now(),
    });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    expect(record.messages).toEqual([{ role: "user", content: "hello world" }]);
  });
});
