import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteSuggestion, ExtensionUIRequest, ExtensionUIResponse } from "../../shared/events";

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
/**
 * A `ctx.ui.addAutocompleteProvider` factory. The real `AutocompleteProviderFactory`
 * type (`(current: AutocompleteProvider) => AutocompleteProvider`, from
 * `@earendil-works/pi-tui`) is not resolvable in this build (pi-tui ships no
 * standalone type declarations pi-desktop can import), so this is a
 * best-effort duck-typed stand-in: we invoke the factory with an empty
 * "current" provider and probe the returned value for either a
 * `getSuggestions(text)` or `suggest(text)` method (both plausible names for
 * the same concept), catching anything that throws. See issue #140's
 * handoff notes for the upstream-type limitation this works around.
 */
type DuckTypedAutocompleteProvider = {
  getSuggestions?: (text: string) => AutocompleteSuggestion[] | Promise<AutocompleteSuggestion[]>;
  suggest?: (text: string) => AutocompleteSuggestion[] | Promise<AutocompleteSuggestion[]>;
};
type DuckTypedAutocompleteFactory = (current: DuckTypedAutocompleteProvider) => DuckTypedAutocompleteProvider;

export class IpcUIContextBridge {
  private readonly pending = new Map<string, PendingDialog>();
  private toolsExpanded = false;
  private editorText = "";
  private readonly autocompleteFactories: DuckTypedAutocompleteFactory[] = [];

  constructor(private readonly pushToRenderer: (request: ExtensionUIRequest) => void) {}

  /** Renderer reports a user-driven tools-expanded toggle so `getToolsExpanded()` stays accurate (issue #139). */
  reportToolsExpanded(value: boolean): void {
    this.toolsExpanded = value;
  }

  /** Renderer reports the composer's current text so `getEditorText()` stays accurate (issue #141). */
  reportEditorText(text: string): void {
    this.editorText = text;
  }

  /** Runs every extension-registered autocomplete provider chain against the given text (issue #140). */
  async queryAutocomplete(text: string): Promise<AutocompleteSuggestion[]> {
    const empty: DuckTypedAutocompleteProvider = { getSuggestions: () => [] };
    const results: AutocompleteSuggestion[] = [];
    for (const factory of this.autocompleteFactories) {
      try {
        const provider = factory(empty);
        const suggestions = await (provider.getSuggestions ?? provider.suggest)?.(text);
        if (suggestions) results.push(...suggestions);
      } catch {
        // A misbehaving extension provider must never break the composer's
        // autocomplete for every other provider -- skip it silently.
      }
    }
    return results;
  }

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
    setStatus: (key, text) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-status", key, text });
    },
    setWorkingMessage: (message) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-working", message });
    },
    setWorkingVisible: (visible) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-working", visible });
    },
    // `frames`/`intervalMs` are real terminal-animation concepts with no React
    // equivalent; the only part of this primitive that's plain data is
    // visibility (an explicit empty `frames: []` means "hidden").
    setWorkingIndicator: (options) => {
      if (options?.frames?.length === 0) {
        this.pushToRenderer({ requestId: randomUUID(), kind: "set-working", visible: false });
      }
    },
    setHiddenThinkingLabel: (label) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-working", hiddenThinkingLabel: label });
    },
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-title", title });
    },
    custom: (async () => undefined) as unknown as ExtensionUIContext["custom"],
    pasteToEditor: (text) => {
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-editor-text", text, mode: "paste" });
    },
    setEditorText: (text) => {
      this.editorText = text;
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-editor-text", text, mode: "replace" });
    },
    getEditorText: () => this.editorText,
    // No multi-line terminal editor overlay exists in Electron mode; reuse
    // the single-line `input` dialog as the closest honest equivalent.
    editor: (title, prefill) =>
      this.dialog<string | undefined>({ kind: "input", title, placeholder: prefill }, (r) =>
        r.kind === "input" ? r.value : undefined,
      ),
    addAutocompleteProvider: (factory) => {
      this.autocompleteFactories.push(factory as unknown as DuckTypedAutocompleteFactory);
    },
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
    getToolsExpanded: () => this.toolsExpanded,
    setToolsExpanded: (expanded) => {
      this.toolsExpanded = expanded;
      this.pushToRenderer({ requestId: randomUUID(), kind: "set-tools-expanded", value: expanded });
    },
  };
}
