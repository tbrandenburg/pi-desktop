import { describe, expect, it } from "vitest";
import { modelStatus } from "./ModelPicker";
import type { ModelInfo } from "../../shared/events";

/**
 * Regression tests for issue #179's new Tier 1 `credentialState` glyphs.
 * Each glyph/tooltip pair is checked directly against `modelStatus()`'s
 * real return value, not re-derived from the function under test.
 */
function baseModel(overrides: Partial<ModelInfo>): ModelInfo {
  return { id: "test/model", label: "test/model", providerId: "test", configured: true, ...overrides };
}

describe("modelStatus credential-state glyphs (issue #179)", () => {
  it("shows the dotted-circle glyph and 'no credentials required' tooltip for a free provider", () => {
    const status = modelStatus(baseModel({ credentialState: "free" }));
    expect(status.symbol).toBe("\u25cc");
    expect(status.title).toBe("No credentials required \u2014 ready to use");
  });

  it("shows the half-circle glyph and 'authenticated via OAuth' tooltip for a resolved OAuth session", () => {
    const status = modelStatus(baseModel({ credentialState: "oauth" }));
    expect(status.symbol).toBe("\u25d0");
    expect(status.title).toBe("Authenticated via OAuth");
  });

  it("shows the re-authentication glyph and distinct tooltip for an auth-error state, unlike a plain missing state", () => {
    const authError = modelStatus(baseModel({ credentialState: "auth-error" }));
    const missing = modelStatus(baseModel({ credentialState: "missing" }));

    expect(authError.symbol).toBe("\u26bf");
    expect(authError.title).toBe("OAuth session expired \u2014 re-authenticate");
    expect(authError.symbol).not.toBe(missing.symbol);
  });

  it("still shows the original not-configured glyph and tooltip for a genuinely missing credential", () => {
    const status = modelStatus(baseModel({ credentialState: "missing", configured: false }));
    expect(status.symbol).toBe("\u25cb");
    expect(status.title).toBe("Provider not configured \u2014 add credentials in Settings");
  });

  it("falls back to the legacy !configured glyph when credentialState is entirely absent", () => {
    const status = modelStatus(baseModel({ credentialState: undefined, configured: false }));
    expect(status.symbol).toBe("\u25cb");
    expect(status.title).toBe("Provider not configured \u2014 add credentials in Settings");
  });

  it("lets Tier 2 reachability still take precedence over any Tier 1 credentialState", () => {
    const status = modelStatus(baseModel({ credentialState: "free", reachability: "unreachable" }));
    expect(status.symbol).toBe("\u2715");
    expect(status.title).toBe("Provider unreachable");
  });
});
