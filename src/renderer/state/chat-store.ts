import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ChatMessage, ModelInfo, SessionSummary } from "../../shared/events";
import { desktopApi } from "../lib/desktop-api";

export interface DisplayMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
  error?: string;
}

function makeTitle(messages: DisplayMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "New chat";
  return firstUserMessage.content.slice(0, 60) || "New chat";
}

interface ChatState {
  conversationId: string;
  sessions: SessionSummary[];
  models: ModelInfo[];
  selectedModel: string;
  messages: DisplayMessage[];
  activeRequestId: string | null;
  status: "idle" | "thinking" | "streaming" | "error";
  errorMessage: string | null;
  loadModels: () => Promise<void>;
  selectModel: (modelId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  resetConversation: () => void;
  loadSessions: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
  persistSession: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

let unsubscribe: (() => void) | null = null;

export const useChatStore = create<ChatState>()(immer((set, get) => ({
  conversationId: crypto.randomUUID(),
  sessions: [],
  models: [],
  selectedModel: "",
  messages: [],
  activeRequestId: null,
  status: "idle",
  errorMessage: null,

  loadModels: async () => {
    const models = await desktopApi().listModels();
    set({ models, selectedModel: get().selectedModel || models[0]?.id || "" });
  },

  selectModel: (modelId: string) => set({ selectedModel: modelId }),

  loadSessions: async () => {
    const sessions = await desktopApi().listSessions();
    set({ sessions });
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

  persistSession: async () => {
    const { conversationId, messages, selectedModel } = get();
    if (messages.length === 0) return;
    await desktopApi().saveSession({
      id: conversationId,
      title: makeTitle(messages),
      model: selectedModel,
      updatedAt: Date.now(),
      messages: messages.map(({ role, content }) => ({ role, content })),
    });
    await get().loadSessions();
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

    unsubscribe?.();
    unsubscribe = desktopApi().onChatEvent((event) => {
      if (event.requestId !== get().activeRequestId) return;

      if (event.type === "text-delta") {
        set((draft) => {
          draft.status = "streaming";
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) message.content += event.text;
        });
        return;
      }

      if (event.type === "completed") {
        set((draft) => {
          draft.status = "idle";
          draft.activeRequestId = null;
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) message.streaming = false;
        });
        void get().persistSession();
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
          }
        });
        void get().persistSession();
      }
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
      set({ activeRequestId: requestId });
    } catch (error) {
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
    void get().persistSession();
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
