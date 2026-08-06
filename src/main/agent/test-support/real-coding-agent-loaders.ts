import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CodingAgentLoaders } from "../coding-agent-loaders";

// Real @earendil-works/pi-coding-agent code, imported the normal static way
// so Vitest's own ESM-aware transform loads it directly -- unlike the
// production `nativeDynamicImport` trick in `coding-agent-loaders.ts`, which
// deliberately hides the import from static analysis and, as a side effect,
// cannot run under Vitest's vm-based test pool at all (see
// `real-agent-core-loaders.ts` for the identical, already-proven pattern).
export const realCodingAgentLoaders: CodingAgentLoaders = {
  loadCodingAgent: async () => ({
    createAgentSession,
    ModelRuntime,
    SessionManager,
    getAgentDir,
    DefaultResourceLoader,
    SettingsManager,
  }),
};
