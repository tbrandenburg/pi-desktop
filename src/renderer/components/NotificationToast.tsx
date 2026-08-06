import { useExtensionUIStore } from "../state/extension-ui-store";

/**
 * Transient toast for an extension's fire-and-forget `ctx.ui.notify(message,
 * type)` call (ADR 0001 §3.4 Phase 2, issue #91). Unlike the dialog
 * components, `notify` needs no response -- just dismissal.
 */
export function NotificationToast() {
  const notification = useExtensionUIStore((state) => state.notification);
  const dismiss = useExtensionUIStore((state) => state.dismissNotification);

  if (!notification) return null;

  const toneClass =
    notification.level === "error"
      ? "border-red-500/40 text-red-200"
      : notification.level === "warning"
        ? "border-yellow-500/40 text-yellow-200"
        : "border-surface-border text-white/80";

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <div className={`flex items-center gap-3 rounded-xl border bg-surface-panel px-4 py-3 text-sm shadow-xl ${toneClass}`}>
        <span>{notification.message}</span>
        <button type="button" onClick={dismiss} className="text-white/50 hover:text-white">
          ×
        </button>
      </div>
    </div>
  );
}
