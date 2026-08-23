import { describe, expect, it } from "vitest";
import type { MutableModels } from "@earendil-works/pi-ai";
import { resolveFromRegistry, type ResolvedPiDefault } from "./pi-config";
import type { ModelsRegistry } from "./registry";

/**
 * Regression test for issue #241: a broken/expired OAuth credential for one
 * provider (e.g. a suspended `github-copilot` account) must never propagate
 * out of `resolveFromRegistry`/`resolvePiDefault` uncaught -- that used to
 * fail the *entire* `model:list` IPC call, wiping out an otherwise-healthy,
 * unrelated provider (e.g. a real `openrouter` credential) along with it.
 * Mirrors `isProviderConfigured`'s existing catch-and-degrade pattern
 * (pi-config.is-provider-configured.test.ts), which this bug's own doc
 * comment says `resolveFromRegistry` was missing.
 */
function fakeProvider(modelId: string) {
  return { getModels: () => [{ id: modelId, baseUrl: "https://example.com/v1" }] };
}

describe("resolveFromRegistry", () => {
  it("returns null instead of throwing when getAuth() rejects with an OAuth refresh error", async () => {
    const registry = {
      models: {
        getProvider: () => fakeProvider("gpt-5"),
        getAuth: () =>
          Promise.reject(
            Object.assign(new Error("OAuth refresh failed for github-copilot: 403 Forbidden"), {
              code: "oauth",
            }),
          ),
      } as unknown as MutableModels,
    } as unknown as ModelsRegistry;

    await expect(resolveFromRegistry(registry, "github-copilot", undefined)).resolves.toBeNull();
  });
});

describe("resolvePiDefault fallback (issue #241)", () => {
  it("skips a broken-OAuth default provider and still resolves a healthy fallback provider", async () => {
    const providers: Record<string, { getModels: () => Array<{ id: string; baseUrl: string }> }> = {
      "github-copilot": fakeProvider("gpt-5"),
      openrouter: fakeProvider("some/model"),
    };

    const models = {
      getProvider: (id: string) => providers[id],
      getAuth: (id: string) =>
        id === "github-copilot"
          ? Promise.reject(Object.assign(new Error("OAuth refresh failed: 403 Forbidden"), { code: "oauth" }))
          : Promise.resolve({ auth: { apiKey: "sk-real-openrouter-key" } }),
      getAvailable: () =>
        Promise.resolve([
          { provider: "github-copilot", id: "gpt-5" },
          { provider: "openrouter", id: "some/model" },
        ]),
    } as unknown as MutableModels;

    const registry = {
      models,
      defaultProviderId: "github-copilot",
      defaultModelId: "gpt-5",
    } as unknown as ModelsRegistry;

    // Exercises resolveFromRegistry's null-on-rejection path directly for the
    // broken default, then the same registry's healthy fallback candidate --
    // without needing a full buildModelsRegistry() + real .pi/agent fixture.
    const brokenDefault = await resolveFromRegistry(registry, "github-copilot", "gpt-5");
    expect(brokenDefault).toBeNull();

    const available = await models.getAvailable();
    let resolved: ResolvedPiDefault | null = null;
    for (const candidate of available) {
      resolved = await resolveFromRegistry(registry, candidate.provider, candidate.id);
      if (resolved) break;
    }

    expect(resolved).toEqual({
      apiKey: "sk-real-openrouter-key",
      baseUrl: "https://example.com/v1",
      model: "some/model",
      label: "openrouter/some/model",
    });
  });
});
