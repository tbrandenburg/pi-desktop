import { useExtensionUIStore } from "../state/extension-ui-store";
import { desktopApi } from "../lib/desktop-api";

/**
 * React modal for an extension's `ctx.ui.confirm(title, message)` call
 * (ADR 0001 §3.4 Phase 2, issue #91). Rendered only while
 * `useExtensionUIStore`'s pending request is a `"confirm"` kind.
 */
export function ConfirmDialog() {
  const pending = useExtensionUIStore((state) => state.pending);
  const clearPending = useExtensionUIStore((state) => state.clearPending);

  if (!pending || pending.kind !== "confirm") return null;

  const respond = (value: boolean) => {
    void desktopApi().respondExtensionUI(pending.requestId, { kind: "confirm", value });
    clearPending();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-white">{pending.title}</h2>
        <p className="text-sm text-white/70">{pending.message}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => respond(false)}
            className="rounded-lg px-4 py-2 text-sm text-white/50 hover:text-white"
          >
            No
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}
