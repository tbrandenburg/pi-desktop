// Ambient module declarations only, so `tsc -p tsconfig.main.json` (moduleResolution: "Node")
// can type-check `@earendil-works/pi-agent-core`'s subpaths, mirroring
// `pi-ai-subpaths.d.ts`. These subpaths are only exposed through the
// package's "import" condition, which classic "Node" module resolution
// cannot resolve -- production code loads them via `agent-core.ts`'s
// `nativeDynamicImport`. This file lets test code import them the normal
// static way; Vitest's own Vite-based resolver loads the real runtime module
// regardless of what tsc's module resolution mode supports.
declare module "@earendil-works/pi-agent-core" {
  export * from "@earendil-works/pi-agent-core/dist/index";
}

declare module "@earendil-works/pi-agent-core/node" {
  export * from "@earendil-works/pi-agent-core/dist/node";
}
