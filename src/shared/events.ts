export interface ModelInfo {
  id: string;
  label: string;
}

export interface StartChatRequest {
  conversationId: string;
  model: string;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ProviderSettings {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

export interface ProviderSettingsSummary {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
}

export interface SessionRecord extends SessionSummary {
  messages: ChatMessage[];
}

export interface WorkspaceInfo {
  /** Absolute path to the currently active, cwd-scoped session workspace. */
  dir: string;
}

/**
 * A `ctx.ui.*` dialog/notify call made by an extension's `registerCommand`
 * handler or hook, pushed from the main process to the renderer so a real
 * React modal can collect the user's answer -- ADR 0001 §3.4 Phase 2. Modeled
 * on pi-coding-agent's own "rpc" mode `extension_ui_request` protocol
 * (`modes/rpc/rpc-mode.js`), scoped to only the dialog-capable methods
 * (`select`/`confirm`/`input`/`notify`) -- every other `ExtensionUIContext`
 * method is TUI-only and stays a no-op (see `src/main/agent/ui-context.ts`).
 */
export type ExtensionUIRequest =
  | { requestId: string; kind: "select"; title: string; options: string[] }
  | { requestId: string; kind: "confirm"; title: string; message: string }
  | { requestId: string; kind: "input"; title: string; placeholder?: string }
  | { requestId: string; kind: "notify"; message: string; level: "info" | "warning" | "error" }
  | { requestId: string; kind: "set-title"; title: string }
  | { requestId: string; kind: "set-status"; key: string; text: string | undefined }
  | {
      requestId: string;
      kind: "set-working";
      message?: string;
      visible?: boolean;
      hiddenThinkingLabel?: string;
    }
  | { requestId: string; kind: "set-tools-expanded"; value: boolean }
  | { requestId: string; kind: "set-editor-text"; text: string; mode: "replace" | "paste" };

/** The renderer's answer to a `select`/`confirm`/`input` `ExtensionUIRequest`, sent back via `respondExtensionUI`. */
export type ExtensionUIResponse =
  | { kind: "select"; value: string | undefined }
  | { kind: "confirm"; value: boolean }
  | { kind: "input"; value: string | undefined };

/** A `pi.registerCommand`-registered slash-command, surfaced in the composer's autocomplete list. */
export interface CommandInfo {
  name: string;
  description?: string;
}

/** A suggestion returned by an extension-registered `addAutocompleteProvider` for the current composer text. */
export interface AutocompleteSuggestion {
  value: string;
  description?: string;
}

/** A `ctx.ui.registerShortcut`-registered keyboard shortcut, surfaced to the renderer so it can intercept the matching keydown. */
export interface ShortcutInfo {
  id: string;
  /** Normalized lowercase, `+`-joined combo, e.g. `"ctrl+shift+p"`. */
  keys: string;
}

/**
 * A configured runtime pi-package (ADR 0001 §3.6/§3.7, issue #92) --
 * local-path, git, or `npm:` source, installed under the real, shared
 * `~/.pi/agent` directory. There is no persistent trust/enabled state
 * (issue #109): a package is installed after a single informed consent
 * prompt, and every configured package always loads -- this list is
 * exactly the set of packages that run, with no hidden state.
 */
export interface PackageInfo {
  source: string;
}

export type ChatEvent =
  | { type: "started"; requestId: string }
  | { type: "text-delta"; requestId: string; text: string }
  | { type: "reasoning-delta"; requestId: string; text: string }
  | {
      type: "tool-call";
      requestId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: "usage";
      requestId: string;
      inputTokens?: number;
      outputTokens?: number;
    }
  | { type: "completed"; requestId: string }
  | { type: "error"; requestId: string; message: string }
  | { type: "retrying"; requestId: string; attempt: number; maxAttempts: number };

export interface DesktopAgentApi {
  listModels(): Promise<ModelInfo[]>;
  startChat(request: StartChatRequest): Promise<{ requestId: string }>;
  cancelChat(requestId: string): Promise<void>;
  saveProviderSettings(settings: ProviderSettings): Promise<void>;
  getProviderSettings(): Promise<ProviderSettingsSummary>;
  onChatEvent(listener: (event: ChatEvent) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;
  getWorkspace(): Promise<WorkspaceInfo>;
  chooseWorkspace(): Promise<WorkspaceInfo | null>;
  getVersion(): Promise<string>;
  /** Registered `pi.registerCommand` slash-commands available in the current workspace. */
  listCommands(): Promise<CommandInfo[]>;
  /** Subscribes to `ctx.ui.*` dialog/notify requests pushed from an active agent session. */
  onExtensionUIRequest(listener: (request: ExtensionUIRequest) => void): () => void;
  /** Sends the user's answer for a pending `select`/`confirm`/`input` `ExtensionUIRequest`. */
  respondExtensionUI(requestId: string, response: ExtensionUIResponse): Promise<void>;
  /** Lists runtime-installed pi-packages (local-path, git, or npm: source, ADR 0001 §3.6). */
  listPackages(): Promise<PackageInfo[]>;
  /**
   * Installs a local-path, git, or `npm:` pi-package source. Blocks on a
   * real, single pre-install consent prompt (routed through
   * `onExtensionUIRequest`/`respondExtensionUI`) -- declining it rejects
   * this call and installs nothing (issue #109).
   */
  installPackage(source: string): Promise<PackageInfo>;
  removePackage(source: string): Promise<void>;
  updatePackage(source: string): Promise<void>;

  /** Current tools-expanded state, cached in main and kept in sync via `reportToolsExpanded`. */
  getToolsExpanded(): Promise<boolean>;
  /** Renderer reports a user-driven tools-expanded toggle back to main so `ExtensionUIContext.getToolsExpanded()` stays accurate. */
  reportToolsExpanded(value: boolean): Promise<void>;
  /** Current composer editor text, cached in main and kept in sync via `reportEditorText`. */
  getEditorText(): Promise<string>;
  /** Renderer reports the composer's current text back to main so `ExtensionUIContext.getEditorText()` stays accurate. */
  reportEditorText(text: string): Promise<void>;
  /** Asks main to run every extension-registered autocomplete provider against the current composer text. */
  queryAutocomplete(text: string): Promise<AutocompleteSuggestion[]>;
  /** Lists extension-registered keyboard shortcuts so the renderer can intercept matching keydowns. */
  listShortcuts(): Promise<ShortcutInfo[]>;
  /** Invokes the extension callback registered for the given shortcut id. */
  triggerShortcut(id: string): Promise<void>;
}
