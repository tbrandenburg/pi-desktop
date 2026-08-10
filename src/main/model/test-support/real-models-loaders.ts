import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { registerBuiltInApiProviders, getApiProvider } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelsLoaders } from "../registry";

// Real `@earendil-works/pi-ai` code (createModels/createProvider + the real
// compat api-registry), imported the normal static way so Vitest's own
// ESM-aware transform loads it directly -- unlike the production
// `nativeDynamicImport` trick in registry.ts, which deliberately hides the
// import from static analysis (required to survive tsc's CommonJS
// downlevel-import-to-require transform) and, as a side effect, cannot run
// under Vitest's vm-based test pool at all (no `importModuleDynamically`
// callback wired for `new Function(...)`-constructed code). Passing these
// real loaders as an injected dependency exercises the actual pi-ai engine
// end-to-end in tests without needing the production import mechanism.
//
// Mirrors `registry.ts`'s `defaultLoadApiModule` (issue #183): delegates to
// pi-ai's own `compat` api-registry rather than a hand-maintained per-api
// module map, so this fixture stays in sync with every real api pi-ai ships
// (including previously-unsupported ones like `openai-responses`).
export const realModelsLoaders: ModelsLoaders = {
  loadPiAi: async () => ({ createModels, createProvider }),
  loadApiModule: async (api: string): Promise<ProviderStreams> => {
    registerBuiltInApiProviders();
    const provider = getApiProvider(api);
    if (!provider) throw new Error(`Unsupported pi-ai API in test fixture: "${api}"`);
    return provider;
  },
  loadBuiltinProviders: async () => ({ builtinProviders }),
};
