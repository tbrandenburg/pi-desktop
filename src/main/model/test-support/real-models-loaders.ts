import { createModels, createProvider } from "@earendil-works/pi-ai";
import * as openAICompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as anthropicMessages from "@earendil-works/pi-ai/api/anthropic-messages";
import * as googleGenerativeAi from "@earendil-works/pi-ai/api/google-generative-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelsLoaders } from "../registry";

// Real `@earendil-works/pi-ai` code (createModels/createProvider + every API
// implementation module), imported the normal static way so Vitest's own
// ESM-aware transform loads it directly -- unlike the production
// `nativeDynamicImport` trick in models.ts, which deliberately hides the
// import from static analysis (required to survive tsc's CommonJS
// downlevel-import-to-require transform) and, as a side effect, cannot run
// under Vitest's vm-based test pool at all (no `importModuleDynamically`
// callback wired for `new Function(...)`-constructed code). Passing these
// real loaders as an injected dependency exercises the actual pi-ai engine
// end-to-end in tests without needing the production import mechanism.
const API_STREAMS: Record<string, typeof openAICompletions> = {
  "openai-completions": openAICompletions,
  "anthropic-messages": anthropicMessages,
  "google-generative-ai": googleGenerativeAi,
};

export const realModelsLoaders: ModelsLoaders = {
  loadPiAi: async () => ({ createModels, createProvider }),
  loadApiModule: async (api: string) => {
    const module = API_STREAMS[api];
    if (!module) throw new Error(`Unsupported pi-ai API in test fixture: "${api}"`);
    return module;
  },
  loadBuiltinProviders: async () => ({ builtinProviders }),
};
