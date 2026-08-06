import path from "node:path";
import { loadAgentCore, loadAgentCoreNode, type AgentCoreLoaders } from "../agent/core";
import { loadCodingAgent, type CodingAgentLoaders } from "../agent/coding-agent-loaders";
import { projectSessionRecord, projectSessionSummary } from "./projection";
import type { SessionRecord, SessionSummary } from "../../shared/events";

/**
 * Thin, cwd-scoped facade over `JsonlSessionRepo`, replacing the old
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
 * `cwd` itself. `JsonlSessionRepo`'s own `sessionsRoot` + internal
 * `encodeCwd()` step (`--<cwd-with-slashes-as-dashes>--`) is byte-for-byte
 * the same encoding pi-coding-agent's `getDefaultSessionDirPath()` uses
 * (verified directly against both packages' real `0.83.0` `dist/*.js`), and
 * both write the identical JSONL header/entry shape (`{type:"session",
 * version:3,...}`, `AgentMessage` entries -- pi-coding-agent's own
 * `SessionMessageEntry.message` field is literally pi-agent-core's
 * `AgentMessage` type). So pointing `JsonlSessionRepo`'s `sessionsRoot` at
 * pi-coding-agent's own `<agentDir>/sessions` (instead of bare `cwd`) makes
 * both classes read/write the exact same on-disk files with zero format
 * translation needed.
 */
export class SessionService {
  constructor(
    private readonly getWorkspaceDir: () => string,
    private readonly loaders: AgentCoreLoaders = {},
    private readonly codingAgentLoaders: CodingAgentLoaders = {},
  ) {}

  private async openRepo() {
    const { JsonlSessionRepo } = await loadAgentCore(this.loaders);
    const { NodeExecutionEnv } = await loadAgentCoreNode(this.loaders);
    const { getAgentDir } = await loadCodingAgent(this.codingAgentLoaders);
    const cwd = this.getWorkspaceDir();
    const sessionsRoot = path.join(getAgentDir(), "sessions");
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    return { repo, cwd };
  }

  async list(): Promise<SessionSummary[]> {
    const { repo, cwd } = await this.openRepo();
    const metadataList = await repo.list({ cwd });
    const summaries = await Promise.all(
      metadataList.map(async (metadata) => {
        const session = await repo.open(metadata);
        return projectSessionSummary(session, metadata.path);
      }),
    );
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<SessionRecord | null> {
    const { repo, cwd } = await this.openRepo();
    const metadataList = await repo.list({ cwd });
    const metadata = metadataList.find((entry) => entry.id === id);
    if (!metadata) return null;
    const session = await repo.open(metadata);
    return projectSessionRecord(session, metadata.path);
  }

  async delete(id: string): Promise<void> {
    const { repo, cwd } = await this.openRepo();
    const metadataList = await repo.list({ cwd });
    const metadata = metadataList.find((entry) => entry.id === id);
    if (!metadata) return;
    await repo.delete(metadata);
  }
}
