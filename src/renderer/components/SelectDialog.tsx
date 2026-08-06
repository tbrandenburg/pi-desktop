import { useExtensionUIStore } from "../state/extension-ui-store";
import { desktopApi } from "../lib/desktop-api";

/**
 * React modal for an extension's `ctx.ui.select(title, options)` call
 * (ADR 0001 §3.4 Phase 2, issue #91). Rendered only while
 * `useExtensionUIStore`'s pending request is a `"select"` kind.
 */
export function SelectDialog() {
  const pending = useExtensionUIStore((state) => state.pending);
  const clearPending = useExtensionUIStore((state) => state.clearPending);

  if (!pending || pending.kind !== "select") return null;

  const respond = (value: string | undefined) => {
    void desktopApi().respondExtensionUI(pending.requestId, { kind: "select", value });
    clearPending();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-white">{pending.title}</h2>
        <div className="flex flex-col gap-2">
          {pending.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => respond(option)}
              className="rounded-lg border border-surface-border px-4 py-2 text-left text-sm text-white transition hover:bg-surface-hover"
            >
              {option}
            </button>
          ))}
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => respond(undefined)}
            className="rounded-lg px-4 py-2 text-sm text-white/50 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
