import { useState } from "react";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { desktopApi } from "../lib/desktop-api";

/**
 * React modal for an extension's `ctx.ui.input(title, placeholder)` call
 * (ADR 0001 §3.4 Phase 2, issue #91). Rendered only while
 * `useExtensionUIStore`'s pending request is an `"input"` kind.
 */
export function InputDialog() {
  const pending = useExtensionUIStore((state) => state.pending);
  const clearPending = useExtensionUIStore((state) => state.clearPending);
  const [value, setValue] = useState("");

  if (!pending || pending.kind !== "input") return null;

  const respond = (result: string | undefined) => {
    void desktopApi().respondExtensionUI(pending.requestId, { kind: "input", value: result });
    setValue("");
    clearPending();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-white">{pending.title}</h2>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") respond(value);
          }}
          placeholder={pending.placeholder}
          className="w-full rounded-lg border border-surface-border bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => respond(undefined)}
            className="rounded-lg px-4 py-2 text-sm text-white/50 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => respond(value)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
