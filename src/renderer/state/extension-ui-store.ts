import { create } from "zustand";
import type { ExtensionUIRequest } from "../../shared/events";

export type PendingDialogRequest = Extract<ExtensionUIRequest, { kind: "select" | "confirm" | "input" }>;
type NotifyRequest = Extract<ExtensionUIRequest, { kind: "notify" }>;
/** Data-only pushes (issues #137/#138/#139/#141): no renderer response is ever sent back for these. */
type DataPushRequest = Extract<
  ExtensionUIRequest,
  { kind: "set-title" | "set-status" | "set-working" | "set-tools-expanded" | "set-editor-text" }
>;

interface ExtensionUIState {
  /** The active `select`/`confirm`/`input` dialog awaiting a user answer, if any. */
  pending: PendingDialogRequest | null;
  /** Most recent `notify` call, shown as a transient toast. */
  notification: NotifyRequest | null;
  /** Most recent data-only push of each kind, keyed by `kind` (issues #137/#138/#139/#141). Consumed by feature-specific components/hooks. */
  dataPushes: Partial<Record<DataPushRequest["kind"], DataPushRequest>>;
  handleRequest: (request: ExtensionUIRequest) => void;
  clearPending: () => void;
  dismissNotification: () => void;
}

const DATA_PUSH_KINDS = new Set<DataPushRequest["kind"]>([
  "set-title",
  "set-status",
  "set-working",
  "set-tools-expanded",
  "set-editor-text",
]);

/**
 * Holds the single in-flight extension `ctx.ui.*` request pushed from main
 * over `onExtensionUIRequest` (ADR 0001 §3.4 Phase 2, issue #91). Subscribed
 * once in `AppShell`; rendered by `SelectDialog`/`ConfirmDialog`/
 * `InputDialog`/`NotificationToast`. Data-only pushes (title/status/working
 * indicator/tools-expanded/editor-text, issue #136) are stored in
 * `dataPushes` for feature-specific components to select from directly.
 */
export const useExtensionUIStore = create<ExtensionUIState>((set) => ({
  pending: null,
  notification: null,
  dataPushes: {},
  handleRequest: (request) => {
    if (request.kind === "notify") {
      set({ notification: request });
      return;
    }
    if (DATA_PUSH_KINDS.has(request.kind as DataPushRequest["kind"])) {
      set((state) => ({
        dataPushes: { ...state.dataPushes, [request.kind]: request as DataPushRequest },
      }));
      return;
    }
    set({ pending: request as PendingDialogRequest });
  },
  clearPending: () => set({ pending: null }),
  dismissNotification: () => set({ notification: null }),
}));
