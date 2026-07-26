// @earendil-works/pi-ai and @earendil-works/pi-agent-core both ship ESM-only
// and only expose their subpaths through an "import" condition (no "require"
// condition). Under tsconfig.main.json's "module": "CommonJS", tsc silently
// downlevels a literal `await import(x)` into `require(x)`, which throws only
// once the app is packaged (never in plain-TS unit tests or `npm run dev`).
// Hiding the call from tsc's static downlevel transform via `new Function(...)`
// forces a genuine native `import()` at runtime, which survives compilation
// as a literal string.
//
// Because this import is deliberately hidden from static analysis, it is also
// invisible to `vi.mock`'s module interception -- and Vitest's default
// vm-based test pool has no `importModuleDynamically` callback wired for
// `new Function(...)`-constructed code, so the real loader cannot run inside
// unit tests at all (throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). Callers
// must keep their loaders as injectable dependencies and have tests inject a
// fixture that imports the real package the normal (static) way instead of
// calling this function directly. See `models.ts`'s `ModelsLoaders` and
// `agent-core.ts`'s `AgentCoreLoaders` for the established pattern.
export const nativeDynamicImport: (specifier: string) => Promise<unknown> = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;
