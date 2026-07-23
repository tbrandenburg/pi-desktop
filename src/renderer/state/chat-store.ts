import { create } from "zustand";
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

export const useChatStore = create<ChatState>((set, get) => ({
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

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      status: "thinking",
      errorMessage: null,
    }));

    unsubscribe?.();
    unsubscribe = desktopApi().onChatEvent((event) => {
      if (event.requestId !== get().activeRequestId) return;

      if (event.type === "text-delta") {
        set((state) => ({
          status: "streaming",
          messages: state.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: message.content + event.text }
              : message,
          ),
        }));
        return;
      }

      if (event.type === "completed") {
        set((state) => ({
          status: "idle",
          activeRequestId: null,
          messages: state.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, streaming: false }
              : message,
          ),
        }));
        void get().persistSession();
        return;
      }

      if (event.type === "error") {
        set((state) => ({
          status: "error",
          activeRequestId: null,
          errorMessage: event.message,
          messages: state.messages.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, streaming: false, error: event.message }
              : message,
          ),
        }));
        void get().persistSession();
      }
    });

    const history = [...get().messages.filter((m) => !m.streaming), userMessage].map(
      ({ role, content }) => ({ role, content }),
    );

    const { requestId } = await desktopApi().startChat({
      conversationId: get().conversationId,
      model: get().selectedModel,
      messages: history,
    });

    set({ activeRequestId: requestId });
  },

  stopGeneration: async () => {
    const requestId = get().activeRequestId;
    if (!requestId) return;
    await desktopApi().cancelChat(requestId);
    set((state) => ({
      status: "idle",
      activeRequestId: null,
      messages: state.messages.map((message) =>
        message.streaming ? { ...message, streaming: false } : message,
      ),
    }));
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
}));
