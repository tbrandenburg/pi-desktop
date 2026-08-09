import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ChatMessage, CommandInfo, ModelInfo, SessionSummary } from "../../shared/events";
import { desktopApi } from "../lib/desktop-api";

/** A single tool-call/tool-result pair grouped onto its assistant message (issue #151). */
export interface Activity {
  /** = the tool-call's `toolCallId`. */
  id: string;
  toolName: string;
  /** Short, humanized label from `toolStepLabel`/`activityLabel`. */
  label: string;
  args: unknown;
  status: "running" | "done" | "error";
  durationMs?: number;
  /**
   * Best-effort, conservatively-extracted "sources" list (issue #157), see
   * `ActivityRecord.sources` in `src/shared/events.ts` for the full contract.
   * Populated from `extractSources` on `tool-result`/live sessions, or
   * carried through as-is from a restored `ActivityRecord`.
   */
  sources?: { title: string; url: string }[];
}

/**
 * Conservative, best-effort extraction of a "sources" list (title + url
 * pairs) from an opaque tool-result payload (issue #157). Deliberately never
 * fabricates: returns `undefined` unless it finds a recognizable list of
 * items each carrying both a title-like and a url-like string field.
 *
 * Recognized shapes:
 * - a top-level array of candidate items
 * - an object with a `results`/`sources`/`items` array property of candidate items
 *
 * A candidate item qualifies only if it has both a url-like field
 * (`url`/`link`, case-insensitive) and a title-like field (`title`/`name`,
 * case-insensitive) that are both non-empty strings. Non-qualifying items in
 * an otherwise-array are skipped (not treated as an all-or-nothing failure);
 * if zero items across the whole payload qualify, returns `undefined`, never
 * an empty array.
 */
export function extractSources(result: unknown): { title: string; url: string }[] | undefined {
  const candidates = candidateArray(result);
  if (!candidates) return undefined;

  const sources: { title: string; url: string }[] = [];
  for (const item of candidates) {
    const source = asSource(item);
    if (source) sources.push(source);
  }
  return sources.length > 0 ? sources : undefined;
}

function candidateArray(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (result === null || typeof result !== "object") return undefined;

  for (const key of ["results", "sources", "items"]) {
    const value = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function asSource(item: unknown): { title: string; url: string } | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;

  const url = firstStringField(record, ["url", "link"]);
  const title = firstStringField(record, ["title", "name"]);
  if (!url || !title) return undefined;
  return { title, url };
}

function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key.toLowerCase()) && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export interface DisplayMessage extends Omit<ChatMessage, "activity"> {
  id: string;
  streaming?: boolean;
  error?: string;
  retrying?: { attempt: number; maxAttempts: number };
  /** Grouped tool-call activity for this message (issue #151), replacing the old sibling-pseudo-message model. */
  activity?: Activity[];
  /**
   * Ephemeral, short, humanized status caption shown at the streaming cursor
   * while this assistant message has no real content yet (issue #145) — e.g.
   * "Thinking…" or "Running a command…". Cleared the instant the first
   * `text-delta` arrives; never persisted as part of the message record.
   */
  stepLabel?: string;
}

/**
 * Maps a tool name to a short, generic, humanized in-progress caption, used
 * for the live typewriter caption (issue #145) and for a `running`
 * `Activity.label` (issue #151). Deliberately never shows the raw tool name
 * or arguments — just enough to convey "the agent is working".
 */
function toolCaptionLabel(toolName: string): string {
  switch (toolName) {
    case "read":
      return "Reading files…";
    case "write":
      return "Writing files…";
    case "edit":
      return "Editing files…";
    case "bash":
      return "Running a command…";
    case "list":
      return "Browsing files…";
    case "web_search":
      return "Searching the web…";
  }
  const name = toolName.toLowerCase();
  if (name.includes("fetch") || name.includes("browser")) return "Reading sources…";
  if (name.includes("calendar")) return "Checking your calendar…";
  if (name.includes("sql") || name.includes("query")) return "Checking the data…";
  if (name.includes("python") || name.includes("exec") || name.includes("code")) return "Calculating results…";
  return "Working…";
}

/**
 * Maps a tool name to a short, generic, finished-state label, used for a
 * `done`/`error` `Activity.label` (issue #152) — distinct past-tense
 * phrasing with no ellipsis, so completed activity rows don't read as still
 * in progress.
 */
function toolCompletedLabel(toolName: string): string {
  switch (toolName) {
    case "read":
      return "Read files";
    case "write":
      return "Wrote files";
    case "edit":
      return "Edited files";
    case "bash":
      return "Ran a command";
    case "list":
      return "Browsed files";
    case "web_search":
      return "Searched the web";
  }
  const name = toolName.toLowerCase();
  if (name.includes("fetch") || name.includes("browser")) return "Read sources";
  if (name.includes("calendar")) return "Checked your calendar";
  if (name.includes("sql") || name.includes("query")) return "Checked the data";
  if (name.includes("python") || name.includes("exec") || name.includes("code")) return "Calculated results";
  return "Worked";
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
  toolsExpanded: boolean;
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
  setToolsExpanded: (value: boolean) => void;
}

let unsubscribe: (() => void) | null = null;

// Issue #167 part C: subscription to progressive, partial model-list
// snapshots pushed from main during a slow, cold `listModels()` call.
// Module-level (mirrors `unsubscribe` above) so re-calling `loadModels()`
// (e.g. a remount) doesn't leak a duplicate listener.
let modelListUnsubscribe: (() => void) | null = null;

/**
 * Merges an incoming (possibly partial) model snapshot into the existing
 * `models` array, deduping by `id` -- last write for a given id wins.
 * `incoming` is itself already the full accumulated snapshot as of when it
 * was pushed (see `buildModelsRegistry`'s `onPartialResult`), so this is
 * mostly a safety net against out-of-order delivery rather than a delta
 * merge.
 */
function mergeModelsById(existing: ModelInfo[], incoming: ModelInfo[]): ModelInfo[] {
  const byId = new Map(existing.map((model) => [model.id, model] as const));
  for (const model of incoming) byId.set(model.id, model);
  return [...byId.values()];
}

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
  toolsExpanded: false,

  setToolsExpanded: (value: boolean) => {
    set({ toolsExpanded: value });
    void desktopApi().reportToolsExpanded(value);
  },

  loadModels: async () => {
    // Issue #167 part C: subscribe to progressive partial updates before
    // kicking off the (possibly slow, cold) `listModels()` call, so any
    // partial pushes that arrive while it's in flight populate the picker
    // early. `listModels()`'s own resolution below remains the final,
    // authoritative write (last write wins), same as before this change.
    modelListUnsubscribe?.();
    modelListUnsubscribe = desktopApi().onModelListUpdated((partial) => {
      const merged = mergeModelsById(get().models, partial);
      set({ models: merged, selectedModel: get().selectedModel || merged[0]?.id || "" });
    });
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
        // A restored session's activity is by definition already finished
        // (issue #151); the persistence package may not have populated it
        // for old sessions, so this is defensive.
        activity: message.activity?.map((record) => ({
          id: record.id,
          toolName: record.toolName,
          label: toolCompletedLabel(record.toolName),
          args: record.args,
          status: record.isError ? ("error" as const) : ("done" as const),
          durationMs: record.durationMs,
          sources: record.sources,
        })),
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
      stepLabel: "Thinking…",
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
        message.streaming = false;
        message.error = "No response received";
        message.stepLabel = undefined;
      });
    }, STUCK_MESSAGE_TIMEOUT_MS);
    const clearStuckTimeout = () => {
      if (stuckTimeout === null) return;
      clearTimeout(stuckTimeout);
      stuckTimeout = null;
    };

    const handleEvent = (event: (typeof pendingEvents)[number]) => {
      clearStuckTimeout();

      if (event.type === "tool-call") {
        set((draft) => {
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (!message) return;
          message.activity ??= [];
          message.activity.push({
            id: event.toolCallId,
            toolName: event.toolName,
            label: toolCaptionLabel(event.toolName),
            args: event.arguments,
            status: "running",
          });
          message.stepLabel = toolCaptionLabel(event.toolName);
        });
        return;
      }

      if (event.type === "tool-result") {
        set((draft) => {
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          const activity = message?.activity?.find((a) => a.id === event.toolCallId);
          if (!activity) return;
          activity.status = event.isError ? "error" : "done";
          activity.label = toolCompletedLabel(activity.toolName);
          activity.durationMs = event.durationMs;
          activity.sources = extractSources(event.result);
        });
        return;
      }

      if (event.type === "reasoning-delta") {
        set((draft) => {
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          // Deliberately ignore the actual reasoning text (issue #145): a
          // synthesized summary risks being misleading, so the caption
          // always stays the same simple "Thinking…" label.
          if (message && !message.content) message.stepLabel = "Thinking…";
        });
        return;
      }

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
            message.stepLabel = undefined;
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
            message.stepLabel = undefined;
            for (const activity of message.activity ?? []) {
              if (activity.status === "running") {
                activity.status = "done";
                activity.label = toolCompletedLabel(activity.toolName);
              }
            }
          }
        });
        void get().loadSessions();
        return;
      }

      if (event.type === "error") {
        set((draft) => {
          draft.status = "error";
          draft.activeRequestId = null;
          const message = draft.messages.find((m) => m.id === assistantMessage.id);
          if (message) {
            message.streaming = false;
            message.error = event.message;
            message.retrying = undefined;
            message.stepLabel = undefined;
            for (const activity of message.activity ?? []) {
              if (activity.status === "running") {
                activity.status = "error";
                activity.label = toolCompletedLabel(activity.toolName);
              }
            }
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
        if (message.streaming) {
          message.streaming = false;
          message.stepLabel = undefined;
          for (const activity of message.activity ?? []) {
            if (activity.status === "running") {
              activity.status = "done";
              activity.label = toolCompletedLabel(activity.toolName);
            }
          }
        }
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
