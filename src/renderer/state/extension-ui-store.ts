import { create } from "zustand";
import type { ExtensionUIRequest } from "../../shared/events";

export type PendingDialogRequest = Extract<ExtensionUIRequest, { kind: "select" | "confirm" | "input" }>;
type NotifyRequest = Extract<ExtensionUIRequest, { kind: "notify" }>;

interface ExtensionUIState {
  /** The active `select`/`confirm`/`input` dialog awaiting a user answer, if any. */
  pending: PendingDialogRequest | null;
  /** Most recent `notify` call, shown as a transient toast. */
  notification: NotifyRequest | null;
  handleRequest: (request: ExtensionUIRequest) => void;
  clearPending: () => void;
  dismissNotification: () => void;
}

/**
 * Holds the single in-flight extension `ctx.ui.*` request pushed from main
 * over `onExtensionUIRequest` (ADR 0001 §3.4 Phase 2, issue #91). Subscribed
 * once in `AppShell`; rendered by `SelectDialog`/`ConfirmDialog`/
 * `InputDialog`/`NotificationToast`.
 */
export const useExtensionUIStore = create<ExtensionUIState>((set) => ({
  pending: null,
  notification: null,
  handleRequest: (request) => {
    if (request.kind === "notify") {
      set({ notification: request });
      return;
    }
    set({ pending: request });
  },
  clearPending: () => set({ pending: null }),
  dismissNotification: () => set({ notification: null }),
}));
