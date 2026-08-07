import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ChatMessage, CommandInfo, ModelInfo, SessionSummary } from "../../shared/events";
import { desktopApi } from "../lib/desktop-api";

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  error?: string;
  retrying?: { attempt: number; maxAttempts: number };
}

interface ChatState {
  conversationId: string;
  sessions: SessionSummary[];
  models: ModelInfo[];
  commands: CommandInfo[];
  selectedModel: string;
  messages: DisplayMessage[];
  activeRequestId: string | null;
  status: "idle" | "thinking" | "streaming" | "error";
  errorMessage: string | null;
  workspaceDir: string;
  loadModels: () => Promise<void>;
  loadCommands: () => Promise<void>;
  selectModel: (modelId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  resetConversation: () => void;
  loadSessions: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  loadWorkspace: () => Promise<void>;
  chooseWorkspace: () => Promise<void>;
}

let unsubscribe: (() => void) | null = null;

// Safety net for #119: if an assistant message never receives any event at
// all (text-delta/completed/error) — e.g. a dead IPC channel or a main
// process crash before responding — flip it to an error state after this
// timeout instead of leaving the bubble stuck "streaming" forever.
const STUCK_MESSAGE_TIMEOUT_MS = 18000;

export const useChatStore = create<ChatState>()(immer((set, get) => ({
  conversationId: crypto.randomUUID(),
  sessions: [],
  models: [],
  commands: [],
  selectedModel: "",
  messages: [],
  activeRequestId: null,
  status: "idle",
  errorMessage: null,
  workspaceDir: "",

  loadModels: async () => {
    const models = await desktopApi().listModels();
    set({ models, selectedModel: get().selectedModel || models[0]?.id || "" });
  },

  selectModel: (modelId: string) => set({ selectedModel: modelId }),

  loadCommands: async () => {
    const commands = await desktopApi().listCommands();
    set({ commands });
  },

  loadSessions: async () => {
    const sessions = await desktopApi().listSessions();
    set({ sessions });
  },

  loadWorkspace: async () => {
    const { dir } = await desktopApi().getWorkspace();
    set({ workspaceDir: dir });
    await get().loadSessions();
  },

  chooseWorkspace: async () => {
    const result = await desktopApi().chooseWorkspace();
    if (!result) return;
    set({ workspaceDir: result.dir });
    get().resetConversation();
    await get().loadSessions();
  },

  loadConversation: async (id: string) => {
    const session = await desktopApi().getSession(id);
    if (!session) return;
    unsubscribe?.();
    set({
      conversationId: session.id,
      selectedModel: session.model || get().selectedModel,
      messages: session.messages.map((message) => ({
        ...message,
        id: crypto.randomUUID(),
      })),
      status: "idle",
      activeRequestId: null,
      errorMessage: null,
    });
  },

  sendMessage: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!get().selectedModel) {
      set({
        status: "error",
        errorMessage: "No model selected. Choose a model before sending a message.",
      });
      return;
    }

    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
    };
    const assistantMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      streaming: true,
    };

    set((draft) => {
      draft.messages.push(userMessage, assistantMessage);
      draft.status = "thinking";
      draft.errorMessage = null;
    });

    let knownRequestId: string | null = null;
    const pendingEvents: Parameters<Parameters<ReturnType<typeof desktopApi>["onChatEvent"]>[0]>[0][] = [];

    let stuckTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      stuckTimeout = null;
      set((draft) => {
        const message = draft.messages.find((m) => m.id === assistantMessage.id);
        if (!message || !message.streaming) return;
        draft.status = "error";
        draft.activeRequestId = null;
        draft.errorMessage = "No response received";
        message.streaming = false;
        message.error = "No response received";
      });
    }, STUCK_MESSAGE_TIMEOUT_MS);
    const clearStuckTimeout = () => {
      if (stuckTimeout === null) return;
      clearTimeout(stuckTimeout);
      stuckTimeout = null;
    };

    const handleEvent = (event: (typeof pendingEvents)[number]) => {
      clearStuckTimeout();

      if (event.type === "retrying") {
        set((draft) => {
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) message.retrying = { attempt: event.attempt, maxAttempts: event.maxAttempts };
        });
        return;
      }

      if (event.type === "text-delta") {
        set((draft) => {
          draft.status = "streaming";
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) {
            message.content += event.text;
            message.retrying = undefined;
          }
        });
        return;
      }

      if (event.type === "completed") {
        set((draft) => {
          draft.status = "idle";
          draft.activeRequestId = null;
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) {
            message.streaming = false;
            message.retrying = undefined;
          }
        });
        void get().loadSessions();
        return;
      }

      if (event.type === "error") {
        set((draft) => {
          draft.status = "error";
          draft.activeRequestId = null;
          draft.errorMessage = event.message;
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) {
            message.streaming = false;
            message.error = event.message;
            message.retrying = undefined;
          }
        });
        void get().loadSessions();
      }
    };

    unsubscribe?.();
    unsubscribe = desktopApi().onChatEvent((event) => {
      if (knownRequestId === null) {
        pendingEvents.push(event);
        return;
      }
      if (event.requestId !== knownRequestId) return;
      handleEvent(event);
    });

    const history = [...get().messages.filter((m) => !m.streaming), userMessage].map(
      ({ role, content }) => ({ role, content }),
    );

    try {
      const { requestId } = await desktopApi().startChat({
        conversationId: get().conversationId,
        model: get().selectedModel,
        messages: history,
      });
      knownRequestId = requestId;
      set({ activeRequestId: requestId });
      const buffered = pendingEvents.splice(0, pendingEvents.length);
      for (const event of buffered) {
        if (event.requestId !== requestId) continue;
        handleEvent(event);
      }
    } catch (error) {
      clearStuckTimeout();
      unsubscribe?.();
      unsubscribe = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      set((draft) => {
        draft.status = "error";
        draft.activeRequestId = null;
        draft.errorMessage = errorMessage;
        const message = draft.messages.find((m) => m.id === assistantMessage.id);
        if (message) {
          message.streaming = false;
          message.error = errorMessage;
        }
      });
    }
  },

  stopGeneration: async () => {
    const requestId = get().activeRequestId;
    if (!requestId) return;
    await desktopApi().cancelChat(requestId);
    set((draft) => {
      draft.status = "idle";
      draft.activeRequestId = null;
      for (const message of draft.messages) {
        if (message.streaming) message.streaming = false;
      }
    });
    void get().loadSessions();
  },

  resetConversation: () =>
    set({
      conversationId: crypto.randomUUID(),
      messages: [],
      status: "idle",
      errorMessage: null,
      activeRequestId: null,
    }),

  deleteSession: async (id: string) => {
    await desktopApi().deleteSession(id);
    await get().loadSessions();
    if (get().conversationId === id) get().resetConversation();
  },
})));
