import type {
  createAgentSession as createAgentSessionType,
  AgentSession as AgentSessionType,
  AgentSessionEvent as AgentSessionEventType,
  CreateAgentSessionOptions as CreateAgentSessionOptionsType,
  CreateAgentSessionResult as CreateAgentSessionResultType,
  ModelRuntime as ModelRuntimeType,
  CreateModelRuntimeOptions as CreateModelRuntimeOptionsType,
  SessionManager as SessionManagerType,
  ToolDefinition as ToolDefinitionType,
} from "@earendil-works/pi-coding-agent";

import { nativeDynamicImport } from "../native-import";

// @earendil-works/pi-coding-agent ships ESM-only, same packaging trap as
// @earendil-works/pi-ai and @earendil-works/pi-agent-core (see
// native-import.ts and core.ts for the full explanation). Its root export
// ("." only -- no subpaths are used here) resolves fine under
// tsconfig.main.json's classic "Node" module resolution via the package's
// top-level "main"/"types" fields, so no ambient subpath `.d.ts` shim is
// needed (contrast with pi-ai/pi-agent-core's `*-subpaths.d.ts` files,
// which exist only because *those* packages are imported via subpaths).

export interface CodingAgentModule {
  createAgentSession: typeof createAgentSessionType;
  ModelRuntime: typeof ModelRuntimeType;
  SessionManager: typeof SessionManagerType;
}

let codingAgentModule: CodingAgentModule | null = null;
async function defaultLoadCodingAgent(): Promise<CodingAgentModule> {
  if (!codingAgentModule) {
    codingAgentModule = (await nativeDynamicImport(
      "@earendil-works/pi-coding-agent",
    )) as unknown as CodingAgentModule;
  }
  return codingAgentModule;
}

/**
 * Injectable pi-coding-agent loaders, mirroring `AgentCoreLoaders` in
 * `core.ts`. Production code relies on the real dynamic-import default
 * above. That import is deliberately hidden from static analysis, so it is
 * also invisible to `vi.mock`'s module interception -- and Vitest's default
 * vm-based test pool has no `importModuleDynamically` callback wired for
 * `new Function(...)`-constructed code, so the real loader cannot run
 * inside unit tests at all. Tests inject a `realCodingAgentLoaders` fixture
 * instead (see `test-support/real-coding-agent-loaders.ts`).
 */
export interface CodingAgentLoaders {
  loadCodingAgent?: () => Promise<CodingAgentModule>;
}

export async function loadCodingAgent(
  loaders: CodingAgentLoaders = {},
): Promise<CodingAgentModule> {
  return (loaders.loadCodingAgent ?? defaultLoadCodingAgent)();
}

export type {
  AgentSessionType as AgentSession,
  AgentSessionEventType as AgentSessionEvent,
  CreateAgentSessionOptionsType as CreateAgentSessionOptions,
  CreateAgentSessionResultType as CreateAgentSessionResult,
  CreateModelRuntimeOptionsType as CreateModelRuntimeOptions,
  ModelRuntimeType as ModelRuntime,
  ToolDefinitionType as ToolDefinition,
};
