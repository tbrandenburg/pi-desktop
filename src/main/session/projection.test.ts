import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("titles a session from its first real user message, trimmed and truncated", async () => {
    const repo = await makeRepo();
    const session = await repo.create({ cwd, id: "s1" });
    await session.appendMessage({
      role: "user",
      content: `  ${"x".repeat(100)}  `,
      timestamp: Date.now(),
    });
    await session.appendModelChange("openai", "gpt-4o-mini");

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
    await session.appendSessionName("Custom Title");

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
    await session.appendCompaction("Summary of turn one", undefined, 100);
    await session.appendMessage({ role: "user", content: "turn two", timestamp: Date.now() });

    const metadata = await session.getMetadata();
    const record = await projectSessionRecord(session, (metadata as { path: string }).path);

    expect(record.messages).toEqual([
      { role: "system", content: "Summary of turn one" },
      { role: "user", content: "turn two" },
    ]);
  });
});
