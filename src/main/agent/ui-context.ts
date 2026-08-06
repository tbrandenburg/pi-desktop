import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../shared/events";

interface PendingDialog {
  resolve: (response: ExtensionUIResponse) => void;
}

/** Distributes `Omit` over `ExtensionUIRequest`'s union so each variant keeps only its own fields minus `requestId`. */
type UIRequestWithoutId = ExtensionUIRequest extends infer R ? (R extends { requestId: string } ? Omit<R, "requestId"> : never) : never;

/**
 * Real `ExtensionUIContext` adapter bridging pi-coding-agent's dialog-capable
 * UI methods (`select`/`confirm`/`input`/`notify`) over Electron IPC to React
 * modals in the renderer -- ADR 0001 §3.4 Phase 2.
 *
 * Modeled directly on pi-coding-agent's own `"rpc"` mode implementation
 * (`dist/modes/rpc/rpc-mode.js`'s `createExtensionUIContext`), the closest
 * real reference for a non-TUI `ExtensionUIContext`: dialog methods push a
 * request and await an out-of-band response keyed by a generated request id;
 * every other method (`setWidget`/`setFooter`/`setEditorComponent`/`custom`/
 * theme access/...) is a documented no-op there too -- those are TUI-only
 * per the ADR and are never implemented here, matching pi's own "rpc"/
 * "json"/"print" mode split (pi-desktop is effectively a new "electron"
 * mode of that same contract).
 */
export class IpcUIContextBridge {
  private readonly pending = new Map<string, PendingDialog>();

  constructor(private readonly pushToRenderer: (request: ExtensionUIRequest) => void) {}

  /** Resolves a pending `select`/`confirm`/`input` dialog with the renderer's answer. */
  respond(requestId: string, response: ExtensionUIResponse): void {
    const dialog = this.pending.get(requestId);
    if (!dialog) return;
    this.pending.delete(requestId);
    dialog.resolve(response);
  }

  private dialog<T>(
    request: UIRequestWithoutId,
    parse: (response: ExtensionUIResponse) => T,
  ): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve) => {
      this.pending.set(requestId, { resolve: (response) => resolve(parse(response)) });
      this.pushToRenderer({ ...request, requestId } as ExtensionUIRequest);
    });
  }

  readonly uiContext: ExtensionUIContext = {
    select: (title, options) =>
      this.dialog<string | undefined>({ kind: "select", title, options }, (r) =>
        r.kind === "select" ? r.value : undefined,
      ),
    confirm: (title, message) =>
      this.dialog<boolean>({ kind: "confirm", title, message }, (r) => (r.kind === "confirm" ? r.value : false)),
    input: (title, placeholder) =>
      this.dialog<string | undefined>({ kind: "input", title, placeholder }, (r) =>
        r.kind === "input" ? r.value : undefined,
      ),
    notify: (message, type = "info") => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "notify", message, level: type });
    },

    // TUI-only from here down -- no terminal exists in Electron mode, so
    // these are silent no-ops (never throw), mirroring pi's own "rpc" mode.
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: (async () => undefined) as unknown as ExtensionUIContext["custom"],
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    // Never read: pi-desktop has no terminal to theme. Cast avoids
    // hand-building a full ansi-color `Theme` instance for a value no
    // Electron-mode caller can meaningfully use.
    get theme(): ExtensionUIContext["theme"] {
      return {} as ExtensionUIContext["theme"];
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-desktop" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}
