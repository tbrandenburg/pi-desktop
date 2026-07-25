import { AgentHarness, JsonlSessionRepo, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentCoreLoaders } from "../agent-core";

// Real @earendil-works/pi-agent-core code, imported the normal static way so
// Vitest's own ESM-aware transform loads it directly -- unlike the
// production `nativeDynamicImport` trick in `agent-core.ts`, which
// deliberately hides the import from static analysis and, as a side effect,
// cannot run under Vitest's vm-based test pool at all (see
// `real-models-loaders.ts` for the identical, already-proven pattern).
export const realAgentCoreLoaders: AgentCoreLoaders = {
  loadAgentCore: async () => ({ AgentHarness, JsonlSessionRepo, Session }),
  loadAgentCoreNode: async () => ({ NodeExecutionEnv }),
};
