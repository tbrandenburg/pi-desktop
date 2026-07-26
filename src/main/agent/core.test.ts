import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `loadAgentCore`/`loadAgentCoreNode`'s default (uninjected) code path calls
 * the real `nativeDynamicImport` -- deliberately hidden from static analysis
 * (see native-import.ts), which means it cannot run inside Vitest's vm-based
 * test pool at all (throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). The only
 * way to exercise this module's own logic -- the "load once, then cache and
 * reuse the same module" memoization -- is to mock `nativeDynamicImport`
 * itself, since it *is* the explicit subject under test here (per the "no
 * mocking unless mocking is the subject" rule): we are testing the caching
 * behavior around it, not delegating real assertions to a mock.
 */
vi.mock("../native-import", () => ({
  nativeDynamicImport: vi.fn(async (specifier: string) => ({ specifier, loaded: true })),
}));

describe("loadAgentCore / loadAgentCoreNode default loaders", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("loads @earendil-works/pi-agent-core via nativeDynamicImport exactly once and caches the result across calls", async () => {
    const { nativeDynamicImport } = await import("../native-import");
    const { loadAgentCore } = await import("./core");

    const first = await loadAgentCore();
    const second = await loadAgentCore();

    expect(nativeDynamicImport).toHaveBeenCalledTimes(1);
    expect(nativeDynamicImport).toHaveBeenCalledWith("@earendil-works/pi-agent-core");
    // Cached module identity must be the exact same object both times --
    // proves the `if (!agentCoreModule)` guard actually short-circuits the
    // second call rather than re-importing.
    expect(second).toBe(first);
  });

  it("loads @earendil-works/pi-agent-core/node via nativeDynamicImport exactly once and caches the result across calls", async () => {
    const { nativeDynamicImport } = await import("../native-import");
    const { loadAgentCoreNode } = await import("./core");

    const first = await loadAgentCoreNode();
    const second = await loadAgentCoreNode();

    expect(nativeDynamicImport).toHaveBeenCalledTimes(1);
    expect(nativeDynamicImport).toHaveBeenCalledWith("@earendil-works/pi-agent-core/node");
    expect(second).toBe(first);
  });

  it("uses the injected loaders instead of the default nativeDynamicImport-based ones when provided", async () => {
    const { nativeDynamicImport } = await import("../native-import");
    const { loadAgentCore, loadAgentCoreNode } = await import("./core");

    const fakeCoreModule = { AgentHarness: class {}, JsonlSessionRepo: class {}, Session: class {} } as never;
    const fakeNodeModule = { NodeExecutionEnv: class {} } as never;

    const core = await loadAgentCore({ loadAgentCore: async () => fakeCoreModule });
    const node = await loadAgentCoreNode({ loadAgentCoreNode: async () => fakeNodeModule });

    expect(core).toBe(fakeCoreModule);
    expect(node).toBe(fakeNodeModule);
    // The injected loaders must fully bypass the real default -- proves the
    // `loaders.loadAgentCore ?? defaultLoadAgentCore` fallback picks the
    // injected function, not the default.
    expect(nativeDynamicImport).not.toHaveBeenCalled();
  });
});
