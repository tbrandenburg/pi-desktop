/**
 * pi-llm7 — first-party pi extension registering an optional-key LLM7 provider.
 *
 * Registers provider id `llm7-free` (NOT `llm7`, to avoid colliding with
 * pi-free's own provider id) with the free `default` / `fast` selectors.
 *
 * The `llm7-status` command from #192 is retained as the cheap "is the bundled
 * extension loaded?" signal used by the packaged-app verification.
 */
import { buildLlm7ProviderConfig, LLM7_PROVIDER_ID, type Llm7ProviderConfig } from "./provider.js";

// Minimal ambient declaration: the shared extension tsconfig deliberately has
// no Node type definitions, and this package must not add dependencies.
declare const process: { env: Record<string, string | undefined> };

interface MinimalExtensionApi {
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: unknown) => void | Promise<void> },
  ): void;
  registerProvider(id: string, config: Llm7ProviderConfig): void;
}

export default function piLlm7(pi: MinimalExtensionApi): void {
  pi.registerProvider(LLM7_PROVIDER_ID, buildLlm7ProviderConfig(process.env));

  pi.registerCommand("llm7-status", {
    description: "Reports that pi-desktop's bundled pi-llm7 extension is loaded.",
    handler: () => {
      // Intentionally a no-op: presence of this command in the command list is
      // the whole signal (#192).
    },
  });
}

export { LLM7_PROVIDER_ID, buildLlm7ProviderConfig };
