// Ambient module declarations only, so `tsc -p tsconfig.main.json` (moduleResolution: "Node")
// can type-check `@earendil-works/pi-ai`'s per-API subpath modules. These subpaths are only
// exposed through pi-ai's package.json "exports" "import" condition, which classic "Node"
// module resolution cannot resolve (see the `nativeDynamicImport` comment in models.ts for
// why production code loads them via a genuine dynamic import instead). This file lets test
// code import these subpaths the normal static way -- Vitest's own Vite-based resolver loads
// the real runtime module regardless of what tsc's module resolution mode supports.
declare module "@earendil-works/pi-ai/api/openai-completions" {
  import type { ProviderStreams } from "@earendil-works/pi-ai";
  export const stream: ProviderStreams["stream"];
  export const streamSimple: ProviderStreams["streamSimple"];
}

declare module "@earendil-works/pi-ai/api/anthropic-messages" {
  import type { ProviderStreams } from "@earendil-works/pi-ai";
  export const stream: ProviderStreams["stream"];
  export const streamSimple: ProviderStreams["streamSimple"];
}

declare module "@earendil-works/pi-ai/api/google-generative-ai" {
  import type { ProviderStreams } from "@earendil-works/pi-ai";
  export const stream: ProviderStreams["stream"];
  export const streamSimple: ProviderStreams["streamSimple"];
}

declare module "@earendil-works/pi-ai/providers/all" {
  import type { Provider } from "@earendil-works/pi-ai";
  export function builtinProviders(): Provider[];
}

