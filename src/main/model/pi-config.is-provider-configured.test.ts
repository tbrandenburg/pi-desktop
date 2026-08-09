import { describe, expect, it } from "vitest";
import type { MutableModels } from "@earendil-works/pi-ai";
import { isProviderConfigured, type CredentialState } from "./pi-config";

/**
 * Regression test for a real production incident: `models.getAuth(providerId)`
 * can *reject* (not just resolve to `undefined`) when a provider's stored
 * credential is present but no longer usable -- e.g. an OAuth refresh call
 * itself fails (observed live: a suspended GitHub account made
 * `github-copilot`'s token refresh return 403, which `pi-ai` surfaces as a
 * rejected `ModelsError`). Before this fix, that rejection propagated out of
 * `isProviderConfigured` uncaught, which failed the entire `Promise.all` in
 * `toModelInfos` -- wiping out every other, unrelated, perfectly healthy
 * provider (e.g. a real `openrouter` credential) along with it.
 *
 * Also covers issue #179's richer 5-state classification, replacing the old
 * single boolean: `"free"`/`"configured"`/`"oauth"`/`"missing"`/
 * `"auth-error"` -- each state is exercised via a distinctly-shaped
 * injected `getAuth` resolution/rejection, not by re-deriving the expected
 * value from the classification logic itself.
 *
 * `getAuth` is mocked here deliberately -- the mock itself (a rejecting or
 * differently-shaped resolved promise) is the exact subject under test, not
 * an unrelated dependency being stubbed out for convenience.
 */
describe("isProviderConfigured", () => {
  it("classifies a rejected getAuth() call with an auth error code as auth-error, not throwing", async () => {
    const models = {
      getAuth: () => Promise.reject(Object.assign(new Error("OAuth refresh failed: 403 Forbidden"), { code: "oauth" })),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    await expect(isProviderConfigured(models, "github-copilot", cache)).resolves.toBe("auth-error");
  });

  it("classifies a rejected getAuth() call with no recognizable auth/oauth code as missing", async () => {
    const models = {
      getAuth: () => Promise.reject(new Error("network timeout")),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const result = await isProviderConfigured(models, "flaky-provider", cache);
    expect(result).toBe("missing");
    expect(result).not.toBe("auth-error");
  });

  it("does not let one provider's rejected getAuth() affect a different provider's result", async () => {
    const models = {
      getAuth: (providerId: string) =>
        providerId === "github-copilot"
          ? Promise.reject(Object.assign(new Error("OAuth refresh failed: 403 Forbidden"), { code: "oauth" }))
          : Promise.resolve({ auth: { apiKey: "sk-real-openrouter-key" } }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const [broken, healthy] = await Promise.all([
      isProviderConfigured(models, "github-copilot", cache),
      isProviderConfigured(models, "openrouter", cache),
    ]);

    expect(broken).toBe("auth-error");
    expect(healthy).toBe("configured");
  });

  it("classifies a resolved auth with a real apiKey as configured", async () => {
    const models = {
      getAuth: () => Promise.resolve({ auth: { apiKey: "sk-real-key" } }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const result = await isProviderConfigured(models, "openrouter", cache);
    expect(result).toBe("configured");
    expect(result).not.toBe("free");
  });

  it("classifies a resolved auth with no apiKey and no OAuth source as free (no credential required)", async () => {
    const models = {
      getAuth: () => Promise.resolve({ auth: {}, source: "no-key-required" }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const result = await isProviderConfigured(models, "llm7", cache);
    expect(result).toBe("free");
    expect(result).not.toBe("missing");
  });

  it("classifies a resolved auth sourced via OAuth with no apiKey as oauth", async () => {
    const models = {
      getAuth: () => Promise.resolve({ auth: { headers: { Authorization: "Bearer xyz" } }, source: "OAuth" }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const result = await isProviderConfigured(models, "github-copilot", cache);
    expect(result).toBe("oauth");
    expect(result).not.toBe("free");
  });

  it("classifies an undefined auth result (nothing resolvable at all) as missing", async () => {
    const models = {
      getAuth: () => Promise.resolve(undefined),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<CredentialState>>();
    const result = await isProviderConfigured(models, "never-configured", cache);
    expect(result).toBe("missing");
    expect(result).not.toBe("auth-error");
  });
});
