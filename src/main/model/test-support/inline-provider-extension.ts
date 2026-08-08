import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ResourceLoader } from "@earendil-works/pi-coding-agent";

// Mirrors `src/main/agent/test-support/inline-test-extension.ts`'s pattern
// (a real `pi.registerCommand` extension loaded via a real
// `DefaultResourceLoader`) for the `pi.registerProvider` case instead --
// issue #147's extension-registered-model source needs a real inline
// extension too, not a mock of pi-coding-agent's own extension loader.

/**
 * A minimal real `pi.registerProvider("pi-free-fixture", ...)` extension --
 * stands in for a real npm extension like `pi-free` calling
 * `pi.registerProvider(...)` at activation time.
 */
export function createProviderExtensionFactory() {
  return (pi: ExtensionAPI): void => {
    pi.registerProvider("pi-free-fixture", {
      baseUrl: "https://fixture.example/v1",
      api: "openai-completions",
      models: [
        {
          id: "fixture-model",
          name: "Fixture Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    });
  };
}

/**
 * Builds a real `DefaultResourceLoader` with only the provider test
 * extension above registered (skills/prompts/themes/context-files disabled
 * so it never reads unrelated real project files) -- passed as
 * `ModelsLoaders.extensionResourceLoader`, mirroring
 * `src/main/agent/test-support/inline-test-extension.ts`'s
 * `buildTestResourceLoader`.
 */
export async function buildProviderTestResourceLoader(cwd: string): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [createProviderExtensionFactory()],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}
