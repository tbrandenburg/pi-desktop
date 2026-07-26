import { loadAgentCore, loadAgentCoreNode, type AgentCoreLoaders } from "../agent/core";
import { projectSessionRecord, projectSessionSummary } from "./projection";
import type { SessionRecord, SessionSummary } from "../../shared/events";

/**
 * Thin, cwd-scoped facade over `JsonlSessionRepo`, replacing the old
 * bespoke, global `SessionStore` (`electron-store`-backed). Sessions are
 * created implicitly by `AgentRuntime` during a chat turn -- this service
 * only ever lists/reads/deletes what's already on disk under the given
 * workspace directory. There is no `save()`: the harness's own session
 * writes are the persistence path.
 */
export class SessionService {
  constructor(
    private readonly getWorkspaceDir: () => string,
    private readonly loaders: AgentCoreLoaders = {},
  ) {}

  private async openRepo() {
    const { JsonlSessionRepo } = await loadAgentCore(this.loaders);
    const { NodeExecutionEnv } = await loadAgentCoreNode(this.loaders);
    const cwd = this.getWorkspaceDir();
    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
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
