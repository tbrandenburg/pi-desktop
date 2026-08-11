import fs from "node:fs/promises";
import type { AgentCoreLoaders } from "../agent/core";
import { loadCodingAgent, type CodingAgentLoaders } from "../agent/coding-agent-loaders";
import { projectSessionRecord, projectSessionSummary } from "./projection";
import type { SessionRecord, SessionSummary } from "../../shared/events";

/**
 * Thin, cwd-scoped facade over `SessionManager`, replacing the old
 * bespoke, global `SessionStore` (`electron-store`-backed). Sessions are
 * created implicitly by `AgentRuntime` during a chat turn -- this service
 * only ever lists/reads/deletes what's already on disk under the given
 * workspace directory. There is no `save()`: the harness's own session
 * writes are the persistence path.
 *
 * `AgentRuntime` (issue #90) persists via pi-coding-agent's `SessionManager`,
 * whose default location for a given `cwd` (when no `agentDir`/`sessionDir`
 * override is passed, which production code never does) is
 * `<agentDir>/sessions/<encoded-cwd>` -- *not* a directory nested inside
 * `cwd` itself. This service uses the same `SessionManager` implementation
 * and directory calculation, so it reads the v3 JSONL format that the runtime
 * actually writes.
 */
export class SessionService {
  constructor(
    private readonly getWorkspaceDir: () => string,
    _agentCoreLoaders: AgentCoreLoaders = {},
    private readonly codingAgentLoaders: CodingAgentLoaders = {},
  ) {}

  private async listSessions() {
    const { SessionManager } = await loadCodingAgent(this.codingAgentLoaders);
    const cwd = this.getWorkspaceDir();
    const sessions = await SessionManager.list(cwd);
    return { SessionManager, cwd, sessions };
  }

  async list(): Promise<SessionSummary[]> {
    const { SessionManager, cwd, sessions } = await this.listSessions();
    const summaries = await Promise.all(
      sessions.map(async (metadata) => {
        const session = SessionManager.open(metadata.path, undefined, cwd);
        return projectSessionSummary(session, metadata.path);
      }),
    );
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const { SessionManager, cwd, sessions } = await this.listSessions();
    const metadata = sessions.find((entry) => entry.id === id);
    if (!metadata) return null;
    const session = SessionManager.open(metadata.path, undefined, cwd);
    return projectSessionRecord(session, metadata.path);
  }

  async delete(id: string): Promise<void> {
    const { sessions } = await this.listSessions();
    const metadata = sessions.find((entry) => entry.id === id);
    if (!metadata) return;
    await fs.unlink(metadata.path);
  }
}
