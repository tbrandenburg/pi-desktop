import { describe, expect, it } from "vitest";
import { normalizeShortcutEvent } from "./shortcut-key";

describe("normalizeShortcutEvent", () => {
  it("joins modifiers in ctrl/alt/shift/meta order followed by the key, lowercased", () => {
    const combo = normalizeShortcutEvent({
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
      key: "P",
    });
    expect(combo).toBe("ctrl+shift+p");
    expect(combo).not.toBe("shift+ctrl+p");
  });

  it("emits the bare key with no modifiers when none are held", () => {
    const combo = normalizeShortcutEvent({
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: "Enter",
    });
    expect(combo).toBe("enter");
    expect(combo.includes("+")).toBe(false);
  });

  it("does not duplicate the modifier key itself as the trailing key segment", () => {
    const combo = normalizeShortcutEvent({
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      key: "Control",
    });
    expect(combo).toBe("ctrl");
    expect(combo).not.toBe("ctrl+control");
  });

  it("normalizes the space key to the literal word 'space' and orders meta last", () => {
    const combo = normalizeShortcutEvent({
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: true,
      key: " ",
    });
    expect(combo).toBe("meta+space");
    expect(combo).not.toBe("meta+ ");
  });
});
