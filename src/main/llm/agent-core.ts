import type {
  AgentHarness as AgentHarnessType,
  JsonlSessionRepo as JsonlSessionRepoType,
  Session as SessionType,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv as NodeExecutionEnvType } from "@earendil-works/pi-agent-core/node";

// @earendil-works/pi-agent-core ships ESM-only and only exposes its "." and
// "./node" subpaths through an "import" condition (no "require" condition) --
// the identical packaging trap as @earendil-works/pi-ai (see models.ts:16-27
// for the original instance and full explanation). Reuse the exact same fix:
// hide the dynamic import from tsc's CommonJS downlevel transform via
// `new Function(...)` so it survives compilation as a genuine `import()`.
const nativeDynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;

export interface AgentCoreModule {
  AgentHarness: typeof AgentHarnessType;
  JsonlSessionRepo: typeof JsonlSessionRepoType;
  Session: typeof SessionType;
}

export interface AgentCoreNodeModule {
  NodeExecutionEnv: typeof NodeExecutionEnvType;
}

let agentCoreModule: AgentCoreModule | null = null;
async function defaultLoadAgentCore(): Promise<AgentCoreModule> {
  if (!agentCoreModule) {
    agentCoreModule = (await nativeDynamicImport(
      "@earendil-works/pi-agent-core",
    )) as unknown as AgentCoreModule;
  }
  return agentCoreModule;
}

let agentCoreNodeModule: AgentCoreNodeModule | null = null;
async function defaultLoadAgentCoreNode(): Promise<AgentCoreNodeModule> {
  if (!agentCoreNodeModule) {
    agentCoreNodeModule = (await nativeDynamicImport(
      "@earendil-works/pi-agent-core/node",
    )) as unknown as AgentCoreNodeModule;
  }
  return agentCoreNodeModule;
}

/**
 * Injectable pi-agent-core loaders, mirroring `ModelsLoaders` in `models.ts`.
 * Production code relies on the real dynamic-import defaults above. Because
 * that import is deliberately hidden from static analysis, it is also
 * invisible to `vi.mock`'s module interception -- and Vitest's default
 * vm-based test pool has no `importModuleDynamically` callback wired for
 * `new Function(...)`-constructed code, so the real loader cannot run inside
 * unit tests at all. Tests inject a `real*Loaders` fixture instead (see
 * `test-support/real-agent-core-loaders.ts`).
 */
export interface AgentCoreLoaders {
  loadAgentCore?: () => Promise<AgentCoreModule>;
  loadAgentCoreNode?: () => Promise<AgentCoreNodeModule>;
}

export async function loadAgentCore(loaders: AgentCoreLoaders = {}): Promise<AgentCoreModule> {
  return (loaders.loadAgentCore ?? defaultLoadAgentCore)();
}

export async function loadAgentCoreNode(
  loaders: AgentCoreLoaders = {},
): Promise<AgentCoreNodeModule> {
  return (loaders.loadAgentCoreNode ?? defaultLoadAgentCoreNode)();
}
