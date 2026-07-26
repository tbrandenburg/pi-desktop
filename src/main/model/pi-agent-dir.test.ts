import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthJsonCredentialStore,
  placeholderModel,
  readJson,
  readProvidersFromAgentDir,
} from "./pi-agent-dir";

describe("readJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-readjson-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses a valid JSON file into the given shape", () => {
    const file = path.join(dir, "data.json");
    fs.writeFileSync(file, JSON.stringify({ foo: "bar", n: 42 }));
    const result = readJson<{ foo: string; n: number }>(file);
    expect(result?.foo).toBe("bar");
    expect(result?.n).toBe(42);
  });

  it("returns null when the file does not exist", () => {
    const result = readJson(path.join(dir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns null when the file contains invalid JSON", () => {
    const file = path.join(dir, "broken.json");
    fs.writeFileSync(file, "{ not valid json");
    const result = readJson(file);
    expect(result).toBeNull();
  });
});

describe("AuthJsonCredentialStore.read", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-global-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-project-"));
  });

  afterEach(() => {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns undefined when neither global nor project auth.json defines the provider", async () => {
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential).toBeUndefined();
  });

  it("reads an api_key credential from the global auth.json", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-global" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential?.type).toBe("api_key");
    expect((credential as { type: "api_key"; key: string }).key).toBe("sk-global");
  });

  it("prefers the project-local credential over the global one for the same provider id", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-global" } }),
    );
    fs.writeFileSync(
      path.join(projectDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-project" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential?.type).toBe("api_key");
    expect((credential as { type: "api_key"; key: string }).key).toBe("sk-project");
  });

  it("falls back to the global credential when the project auth.json exists but lacks this provider", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-global" } }),
    );
    fs.writeFileSync(
      path.join(projectDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "sk-other" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential?.type).toBe("api_key");
    expect((credential as { type: "api_key"; key: string }).key).toBe("sk-global");
  });

  it("reads a valid oauth credential", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "oauth", refresh: "r-token", access: "a-token", expires: 12345 },
      }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("anthropic");
    expect(credential?.type).toBe("oauth");
    expect((credential as { type: "oauth"; refresh: string; access: string; expires: number }).refresh).toBe(
      "r-token",
    );
    expect((credential as { type: "oauth"; expires: number }).expires).toBe(12345);
  });

  it("ignores an oauth entry missing the expires field (not a number)", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", refresh: "r-token", access: "a-token" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("anthropic");
    expect(credential).toBeUndefined();
  });

  it("ignores an entry whose type is not literally 'oauth', even if it has all oauth-shaped fields", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({
        anthropic: { type: "not-oauth", refresh: "r-token", access: "a-token", expires: 12345 },
      }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("anthropic");
    expect(credential).toBeUndefined();
  });

  it("ignores an oauth entry missing the refresh field", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth", access: "a-token", expires: 12345 } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("anthropic");
    expect(credential).toBeUndefined();
  });

  it("ignores an api_key entry missing the key field", async () => {
    fs.writeFileSync(path.join(globalDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key" } }));
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential).toBeUndefined();
  });

  it("ignores an entry with an unrecognized type", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "bearer-token", key: "sk-x" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const credential = await store.read("openrouter");
    expect(credential).toBeUndefined();
  });

  it("returns an in-memory override instead of reading disk once set via modify()", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-disk" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    await store.modify("openrouter", async () => ({ type: "api_key", key: "sk-refreshed" }));
    const credential = await store.read("openrouter");
    expect(credential?.type).toBe("api_key");
    expect((credential as { type: "api_key"; key: string }).key).toBe("sk-refreshed");
  });

  it("returns undefined for a provider explicitly deleted via delete(), even if disk still has it", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-disk" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    await store.delete("openrouter");
    const credential = await store.read("openrouter");
    expect(credential).toBeUndefined();
  });
});

describe("AuthJsonCredentialStore.list", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-list-global-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-list-project-"));
  });

  afterEach(() => {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns an empty list when no auth.json files exist", async () => {
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("merges global and project provider ids, with project overriding the same id's type", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({
        openrouter: { type: "api_key", key: "sk-global" },
        anthropic: { type: "oauth", refresh: "r", access: "a", expires: 1 },
      }),
    );
    fs.writeFileSync(path.join(projectDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-project" } }));

    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        { providerId: "openrouter", type: "api_key" },
        { providerId: "anthropic", type: "oauth" },
      ]),
    );
  });

  it("includes an in-memory override provider not present on disk at all", async () => {
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    await store.modify("brandnew", async () => ({ type: "api_key", key: "sk-new" }));
    const list = await store.list();
    expect(list).toEqual([{ providerId: "brandnew", type: "api_key" }]);
  });

  it("excludes a provider from the list once deleted via an override, even though disk still has it", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-global" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    await store.delete("openrouter");
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it("skips disk entries that fail toCredential validation", async () => {
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({
        good: { type: "api_key", key: "sk-good" },
        bad: { type: "api_key" },
      }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);
    const list = await store.list();
    expect(list).toEqual([{ providerId: "good", type: "api_key" }]);
  });
});

describe("AuthJsonCredentialStore.modify", () => {
  it("passes the currently-resolved credential (from disk) into the modify function", async () => {
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-modify-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-modify-proj-"));
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-old" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);

    let seenCurrent: unknown;
    const result = await store.modify("openrouter", async (current) => {
      seenCurrent = current;
      return { type: "api_key", key: "sk-new" };
    });

    expect(seenCurrent).toEqual({ type: "api_key", key: "sk-old" });
    expect(result).toEqual({ type: "api_key", key: "sk-new" });

    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("stores an override of undefined (deletion via modify) so subsequent read() returns undefined", async () => {
    const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-modify-del-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-auth-modify-del-proj-"));
    fs.writeFileSync(
      path.join(globalDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "sk-old" } }),
    );
    const store = new AuthJsonCredentialStore(globalDir, projectDir);

    const result = await store.modify("openrouter", async () => undefined);
    expect(result).toBeUndefined();
    const credential = await store.read("openrouter");
    expect(credential).toBeUndefined();

    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});

describe("placeholderModel", () => {
  it("builds a placeholder model with zero-value cost/context defaults", () => {
    const model = placeholderModel("my-model", "custom-provider", "openai-completions", "https://x.example/v1");
    expect(model.id).toBe("my-model");
    expect(model.provider).toBe("custom-provider");
    expect(model.baseUrl).toBe("https://x.example/v1");
    expect(model.contextWindow).toBe(128_000);
    expect(model.maxTokens).toBe(16384);
    expect(model.reasoning).toBe(false);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.input).toEqual(["text"]);
  });
});

describe("readProvidersFromAgentDir", () => {
  let dir: string;
  const loadApiModule = async () =>
    ({ stream: async function* () {}, streamSimple: async (..._args: unknown[]) => "" }) as never;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-providers-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_DESKTOP_TEST_KEY;
  });

  it("returns an empty array when there is no models.json", async () => {
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("builds provider options for a fully-specified custom provider", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "sk-literal",
            models: [{ id: "model-a" }, { id: "model-b" }],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe("myprovider");
    expect(options[0].models).toHaveLength(2);
    const auth = await options[0].auth.apiKey?.resolve({ ctx: {} as never });
    expect(auth?.auth.apiKey).toBe("sk-literal");
  });

  it("resolves an env-var-referenced apiKey (leading '$')", async () => {
    process.env.PI_DESKTOP_TEST_KEY = "sk-from-env";
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "$PI_DESKTOP_TEST_KEY",
            models: [{ id: "model-a" }],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toHaveLength(1);
    const auth = await options[0].auth.apiKey?.resolve({ ctx: {} as never });
    expect(auth?.auth.apiKey).toBe("sk-from-env");
  });

  it("resolves an env-var-referenced apiKey to empty string when the env var is unset, causing the provider to be dropped", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "$PI_DESKTOP_UNSET_VAR",
            models: [{ id: "model-a" }],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("drops a provider missing 'api'", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: { baseUrl: "https://x.example/v1", apiKey: "sk-x", models: [{ id: "m" }] },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("drops a provider missing 'baseUrl'", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: { api: "openai-completions", apiKey: "sk-x", models: [{ id: "m" }] },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("drops a provider with an empty models array", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "sk-x",
            models: [],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("drops a provider whose models array has entries without an id", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKey: "sk-x",
            models: [{}],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("drops a provider missing apiKey entirely", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          myprovider: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            models: [{ id: "m" }],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options).toEqual([]);
  });

  it("builds options for multiple valid providers while dropping invalid ones, preserving each id", async () => {
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          valid1: {
            api: "openai-completions",
            baseUrl: "https://a.example/v1",
            apiKey: "sk-a",
            models: [{ id: "m1" }],
          },
          invalid: { api: "openai-completions", baseUrl: "https://b.example/v1", models: [{ id: "m2" }] },
          valid2: {
            api: "anthropic-messages",
            baseUrl: "https://c.example/v1",
            apiKey: "sk-c",
            models: [{ id: "m3" }],
          },
        },
      }),
    );
    const options = await readProvidersFromAgentDir(dir, loadApiModule);
    expect(options.map((o) => o.id).sort()).toEqual(["valid1", "valid2"]);
  });
});
