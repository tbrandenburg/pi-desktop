import { describe, expect, it } from "vitest";
import { formatContextWindow } from "./ModelPicker";

/**
 * Unit test for issue #178's compact context-window formatter used inline
 * in native `<option>` labels (which can't render rich markup). Expected
 * values are hand-computed, not derived from calling the function itself.
 */
describe("formatContextWindow", () => {
  it("formats an exact-million value as a bare 'M' suffix", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(2_000_000)).toBe("2M");
  });

  it("formats a whole-thousand value as a bare 'K' suffix", () => {
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(8_000)).toBe("8K");
  });

  it("formats a non-whole-thousand value with one decimal place", () => {
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(200_500)).toBe("200.5K");
  });

  it("formats a value under 1000 as the raw number", () => {
    expect(formatContextWindow(512)).toBe("512");
    expect(formatContextWindow(0)).toBe("0");
  });
});
