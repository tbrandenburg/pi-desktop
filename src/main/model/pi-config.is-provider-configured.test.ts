import { describe, expect, it } from "vitest";
import type { MutableModels } from "@earendil-works/pi-ai";
import { isProviderConfigured } from "./pi-config";

/**
 * Regression test for a real production incident: `models.getAuth(providerId)`
 * can *reject* (not just resolve to `undefined`) when a provider's stored
 * credential is present but no longer usable -- e.g. an OAuth refresh call
 * itself fails (observed live: a suspended GitHub account made
 * `github-copilot`'s token refresh return 403, which `pi-ai` surfaces as a
 * rejected `ModelsError`). Before this fix, that rejection propagated out of
 * `isProviderConfigured` uncaught, which failed the entire `Promise.all` in
 * `toModelInfos` -- wiping out every other, unrelated, perfectly healthy
 * provider's models (e.g. a real `openrouter` credential) along with it.
 *
 * `getAuth` is mocked here deliberately -- the mock itself (a rejecting
 * promise) is the exact subject under test, not an unrelated dependency
 * being stubbed out for convenience.
 */
describe("isProviderConfigured", () => {
  it("treats a rejected getAuth() call as not-configured instead of throwing", async () => {
    const models = {
      getAuth: () => Promise.reject(new Error("OAuth refresh failed: 403 Forbidden")),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<boolean>>();
    await expect(isProviderConfigured(models, "github-copilot", cache)).resolves.toBe(false);
  });

  it("does not let one provider's rejected getAuth() affect a different provider's result", async () => {
    const models = {
      getAuth: (providerId: string) =>
        providerId === "github-copilot"
          ? Promise.reject(new Error("OAuth refresh failed: 403 Forbidden"))
          : Promise.resolve({ auth: { apiKey: "sk-real-openrouter-key" } }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<boolean>>();
    const [broken, healthy] = await Promise.all([
      isProviderConfigured(models, "github-copilot", cache),
      isProviderConfigured(models, "openrouter", cache),
    ]);

    expect(broken).toBe(false);
    expect(healthy).toBe(true);
  });

  it("still resolves true for a genuinely configured provider (no rejection at all)", async () => {
    const models = {
      getAuth: () => Promise.resolve({ auth: { apiKey: "sk-real-key" } }),
    } as unknown as MutableModels;

    const cache = new Map<string, Promise<boolean>>();
    await expect(isProviderConfigured(models, "openrouter", cache)).resolves.toBe(true);
  });
});
