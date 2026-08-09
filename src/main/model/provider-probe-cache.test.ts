import { describe, expect, it } from "vitest";
import { clearProbeCache, isProbeFresh, markProbed } from "./provider-probe-cache";

describe("provider-probe-cache", () => {
  it("is not fresh before any probe has been recorded", () => {
    clearProbeCache();
    expect(isProbeFresh("openrouter")).toBe(false);
    expect(isProbeFresh("anthropic")).toBe(false);
  });

  it("round-trips freshness within the TTL window using an injected clock", () => {
    clearProbeCache();
    const start = 1_000_000;
    markProbed("openrouter", start);

    expect(isProbeFresh("openrouter", start, 90_000)).toBe(true);
    expect(isProbeFresh("openrouter", start + 89_000, 90_000)).toBe(true);
    // A different, never-probed provider must remain unaffected.
    expect(isProbeFresh("anthropic", start, 90_000)).toBe(false);
  });

  it("reports stale entries as not fresh once the TTL has elapsed", () => {
    clearProbeCache();
    const start = 1_000_000;
    markProbed("openrouter", start);

    expect(isProbeFresh("openrouter", start + 90_001, 90_000)).toBe(false);
    expect(isProbeFresh("openrouter", start + 500_000, 90_000)).toBe(false);
  });

  it("clearProbeCache resets every recorded entry", () => {
    const now = 2_000_000;
    markProbed("openrouter", now);
    markProbed("anthropic", now);
    expect(isProbeFresh("openrouter", now)).toBe(true);
    expect(isProbeFresh("anthropic", now)).toBe(true);

    clearProbeCache();

    expect(isProbeFresh("openrouter", now)).toBe(false);
    expect(isProbeFresh("anthropic", now)).toBe(false);
  });
});
