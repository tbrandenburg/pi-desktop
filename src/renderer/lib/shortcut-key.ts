/**
 * Normalizes a real `KeyboardEvent` into the same `"ctrl+shift+p"`-style
 * combo string used by `ShortcutInfo.keys` (issue #142). Modifiers are
 * always emitted lowercase and in a stable order (ctrl, alt, shift, meta),
 * followed by the non-modifier key itself, so two events for the same
 * physical combo always normalize to an identical string regardless of
 * platform key-order quirks.
 */
export function normalizeShortcutEvent(event: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  key: string;
}): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("meta");

  const key = event.key.toLowerCase();
  const isModifierKey = key === "control" || key === "alt" || key === "shift" || key === "meta";
  if (!isModifierKey) {
    parts.push(key === " " ? "space" : key);
  }

  return parts.join("+");
}
