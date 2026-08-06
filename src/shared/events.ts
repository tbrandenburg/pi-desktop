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
  | { requestId: string; kind: "notify"; message: string; level: "info" | "warning" | "error" };

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

/**
 * A configured runtime pi-package (ADR 0001 §3.6/§3.7, issue #92) --
 * local-path or git source only, installed under the desktop-owned
 * `userData` directory (never `~/.pi/agent`). `trusted` reflects the
 * binary `ProjectTrustStore` consent decision keyed by the package's own
 * source string: a package is never loaded into an active chat session
 * (its `additionalExtensionPaths` entry is simply omitted) until
 * `trusted === true`.
 */
export interface PackageInfo {
  source: string;
  trusted: boolean;
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
  | { type: "error"; requestId: string; message: string };

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
  /** Lists runtime-installed pi-packages (local-path/git only, ADR 0001 §3.6). */
  listPackages(): Promise<PackageInfo[]>;
  /**
   * Installs a local-path or git pi-package source. Blocks on a real,
   * mandatory trust prompt (routed through `onExtensionUIRequest`/
   * `respondExtensionUI`) before the returned `PackageInfo.trusted` is
   * `true` -- an `npm:` source is rejected with an error, client- and
   * server-side.
   */
  installPackage(source: string): Promise<PackageInfo>;
  removePackage(source: string): Promise<void>;
  updatePackage(source: string): Promise<void>;
}
