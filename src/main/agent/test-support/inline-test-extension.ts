import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Records every `ctx.ui.*` call an inline test extension makes, plus the
 * values it resolved to -- lets `runtime.test.ts` assert the real
 * `ExtensionUIContext` bridge (`ui-context.ts`) round-trips actual answers
 * from main to the "handler" and back, without any third-party npm package
 * (ADR 0001 §3.5's own Phase 1 finding: no real `pi-package` is a strict,
 * safe-to-bundle test fixture -- so Phase 2 validation uses a first-party
 * inline extension instead, exactly like `createReadOnlyTools` already does
 * for tools).
 */
export interface TestExtensionLog {
  confirmResult?: boolean;
  inputResult?: string | undefined;
  notified: string[];
  invoked: boolean;
}

/**
 * A minimal real `pi.registerCommand("greet", ...)` extension whose handler
 * calls `ctx.ui.confirm` then `ctx.ui.input` then `ctx.ui.notify` -- the
 * exact three dialog-capable methods Phase 2 bridges over IPC. Loaded via
 * `DefaultResourceLoader`'s real `extensionFactories` option (no mocking of
 * pi-coding-agent's own extension loader).
 */
export function createTestExtensionFactory(log: TestExtensionLog) {
  return (pi: ExtensionAPI): void => {
    pi.registerCommand("greet", {
      description: "Greets after confirming with the user",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        log.invoked = true;
        const confirmed = await ctx.ui.confirm("Greet?", "Say hello?");
        log.confirmResult = confirmed;
        if (!confirmed) {
          ctx.ui.notify("cancelled", "info");
          return;
        }
        const name = await ctx.ui.input("Name?", "your name");
        log.inputResult = name;
        ctx.ui.notify(`Hello ${name ?? "friend"}${args ? ` (${args})` : ""}`, "info");
        log.notified.push(`Hello ${name ?? "friend"}${args ? ` (${args})` : ""}`);
      },
    });
  };
}

/**
 * Builds a real `DefaultResourceLoader` with only the test extension above
 * registered (skills/prompts/themes/context-files disabled so it never
 * reads unrelated real project files) -- passed as `AgentRuntimeRunArgs`'
 * injectable `resourceLoader` seam, mirroring the `modelRuntime` injection
 * pattern already established for tests in `fake-model-runtime.ts`.
 */
export async function buildTestResourceLoader(cwd: string, log: TestExtensionLog): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [createTestExtensionFactory(log)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}
