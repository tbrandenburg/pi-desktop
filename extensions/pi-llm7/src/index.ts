/**
 * Minimal first-party extension entry point for the pi-llm7 pi-package.
 *
 * Scope note: this deliberately registers only a single trivial command.
 * It exists so issue #192's bundling + runtime-discovery wiring can be
 * proven end-to-end (a bundled `extensions/*` package's registrations must
 * become visible in dev AND in the packaged app). The real LLM7 provider
 * registration is issue #193's job, not this file's.
 */
interface MinimalExtensionApi {
  registerCommand(
    name: string,
    command: { description: string; handler: (args: string, ctx: unknown) => void | Promise<void> },
  ): void;
}

export default function piLlm7(pi: MinimalExtensionApi): void {
  pi.registerCommand("llm7-status", {
    description: "Reports that pi-desktop's bundled pi-llm7 extension is loaded.",
    handler: () => {
      // Intentionally a no-op: presence of this command in the command
      // list is the whole signal (#192). Real behavior lands in #193.
    },
  });
}
