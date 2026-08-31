// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeApiSentinel = { kind: "fake" };
const webBridgeApiSentinel = { kind: "web-bridge" };

const createFakeDesktopApi = vi.fn(() => fakeApiSentinel);
const createWebBridgeDesktopApi = vi.fn((_url: string) => webBridgeApiSentinel);

vi.mock("./fake-desktop-api", () => ({
  createFakeDesktopApi: () => createFakeDesktopApi(),
}));
vi.mock("./ws-desktop-api", () => ({
  createWebBridgeDesktopApi: (url: string) => createWebBridgeDesktopApi(url),
}));

afterEach(() => {
  delete (window as unknown as { desktopApi?: unknown }).desktopApi;
  createFakeDesktopApi.mockClear();
  createWebBridgeDesktopApi.mockClear();
});

beforeEach(() => {
  vi.resetModules();
});

describe("desktopApi", () => {
  it("returns the existing window.desktopApi without creating a new one", async () => {
    const existing = { kind: "existing" };
    (window as unknown as { desktopApi?: unknown }).desktopApi = existing;

    const { desktopApi } = await import("./desktop-api");
    const result = desktopApi();

    expect(result).toBe(existing);
    expect(createFakeDesktopApi).not.toHaveBeenCalled();
    expect(createWebBridgeDesktopApi).not.toHaveBeenCalled();
  });

  // `VITE_WEB_BRIDGE_URL` is unset in this process, so this exercises the
  // "no web bridge configured" branch that reads `WEB_BRIDGE_URL` as falsy.
  it("creates and caches a fake desktop api when no web bridge url is configured", async () => {
    delete (window as unknown as { desktopApi?: unknown }).desktopApi;

    const { desktopApi } = await import("./desktop-api");
    const result = desktopApi();

    expect(result).toBe(fakeApiSentinel);
    expect(createFakeDesktopApi).toHaveBeenCalledTimes(1);
    expect(createWebBridgeDesktopApi).not.toHaveBeenCalled();
    expect((window as unknown as { desktopApi?: unknown }).desktopApi).toBe(fakeApiSentinel);
  });

  // NOTE: the "web bridge configured" branch (`WEB_BRIDGE_URL` truthy) is not
  // covered here. `desktop-api.ts` captures `import.meta.env.VITE_WEB_BRIDGE_URL`
  // in a top-level const at module transform time -- Vite statically inlines
  // this per-module at transform time, so neither `vi.stubEnv` nor directly
  // mutating `import.meta.env` after startup can make a freshly imported
  // sibling module see a different value (verified experimentally: both
  // techniques leave the re-imported module's constant unchanged). Exercising
  // that branch for real would require either a `.env.test`/vitest `env`
  // config change (process-wide, not per-test) or spawning a child process
  // with the env var pre-set, and the latter would need a `node:child_process`
  // import, which this repo's renderer lint rule (`no-restricted-imports`,
  // AGENTS.md rule #4: "Keep Node and Pi APIs out of the renderer") forbids
  // even in test files. See issue #227 follow-up notes.
  it("createWebBridgeDesktopApi is never called when no web bridge url is configured", async () => {
    delete (window as unknown as { desktopApi?: unknown }).desktopApi;

    const { desktopApi } = await import("./desktop-api");
    desktopApi();

    expect(createWebBridgeDesktopApi).not.toHaveBeenCalled();
    expect(webBridgeApiSentinel).not.toBe(fakeApiSentinel);
  });
});
