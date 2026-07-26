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
}
