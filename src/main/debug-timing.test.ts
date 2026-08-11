import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `debug-timing.ts` reads `process.env.PI_DESKTOP_DEBUG_TIMING` exactly once,
 * at module load time (see its own doc comment on why: a single read into a
 * top-level `const`, not a re-check per call). Exercising both the
 * disabled-by-default and explicitly-enabled states therefore requires
 * `vi.resetModules()` + a dynamic `import()` per test, mirroring the same
 * pattern `agent/core.test.ts` already uses for a different module-load-time
 * memoization case -- not a new convention.
 */
describe("debug-timing", () => {
  const originalEnv = process.env.PI_DESKTOP_DEBUG_TIMING;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_DESKTOP_DEBUG_TIMING;
    else process.env.PI_DESKTOP_DEBUG_TIMING = originalEnv;
    vi.restoreAllMocks();
  });

  it("never logs and reports disabled when PI_DESKTOP_DEBUG_TIMING is unset", async () => {
    delete process.env.PI_DESKTOP_DEBUG_TIMING;
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { logTurnTiming, isTurnTimingEnabled } = await import("./debug-timing");
    logTurnTiming("req-1", "somePhase", 42);

    expect(isTurnTimingEnabled()).toBe(false);
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("logs a single structured, taggable line with the exact requestId/phase/durationMs when enabled", async () => {
    process.env.PI_DESKTOP_DEBUG_TIMING = "1";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { logTurnTiming, isTurnTimingEnabled } = await import("./debug-timing");
    logTurnTiming("req-2", "loadModelsRegistry", 271);

    expect(isTurnTimingEnabled()).toBe(true);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(debugSpy.mock.calls[0]![0] as string)).toEqual({
      tag: "chat-turn-timing",
      requestId: "req-2",
      phase: "loadModelsRegistry",
      durationMs: 271,
    });
  });

  it("never enables timing for any other env value than exactly \"1\"", async () => {
    process.env.PI_DESKTOP_DEBUG_TIMING = "true";
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const { logTurnTiming, isTurnTimingEnabled } = await import("./debug-timing");
    logTurnTiming("req-3", "somePhase", 1);

    expect(isTurnTimingEnabled()).toBe(false);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
