import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent } from "../../shared/events";

const startChat = vi.fn();
const onChatEvent = vi.fn((_handler: (event: ChatEvent) => void) => () => {});
const listModels = vi.fn();
const listSessions = vi.fn();
const getSession = vi.fn();
const deleteSession = vi.fn();
const cancelChat = vi.fn();
const getWorkspace = vi.fn().mockResolvedValue({ dir: "/home/test" });
const chooseWorkspace = vi.fn();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    startChat,
    onChatEvent,
    listModels,
    listSessions,
    getSession,
    deleteSession,
    cancelChat,
    getWorkspace,
    chooseWorkspace,
  }),
}));

// Regression coverage for https://github.com/tbrandenburg/pi-desktop/issues/3:
// sending a message with no model selected must never leave the UI stuck in
// "thinking" forever.
describe("chat-store sendMessage guard (issue #3)", () => {
  beforeEach(() => {
    vi.resetModules();
    startChat.mockReset();
    onChatEvent.mockReset().mockReturnValue(() => {});
    listModels.mockReset();
    listSessions.mockReset();
    getSession.mockReset();
    deleteSession.mockReset();
    cancelChat.mockReset();
    getWorkspace.mockReset().mockResolvedValue({ dir: "/home/test" });
    chooseWorkspace.mockReset();
  });

  it("never enters the thinking state and reports a visible error when no model is selected", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "" });

    await useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toMatch(/no model selected/i);
    expect(state.messages).toHaveLength(0);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("transitions to an error status instead of hanging in 'thinking' when startChat rejects", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "gpt-4o-mini" });
    startChat.mockRejectedValue(new Error("IPC channel disconnected"));

    await useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("IPC channel disconnected");
    expect(state.activeRequestId).toBeNull();
  });

  it("proceeds normally and stores the requestId when a model is selected and startChat resolves", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "gpt-4o-mini" });
    startChat.mockResolvedValue({ requestId: "req-1" });

    await useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(state.activeRequestId).toBe("req-1");
    expect(state.status).toBe("thinking");
    expect(startChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });
});

describe("chat-store.loadModels", () => {
  beforeEach(() => {
    vi.resetModules();
    listModels.mockReset();
  });

  it("selects the first returned model when no model was previously selected", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "" });
    listModels.mockResolvedValue([
      { id: "model-a", label: "Model A" },
      { id: "model-b", label: "Model B" },
    ]);

    await useChatStore.getState().loadModels();

    const state = useChatStore.getState();
    expect(state.models).toHaveLength(2);
    expect(state.selectedModel).toBe("model-a");
  });

  it("keeps an already-selected model instead of overwriting it with the first result", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "model-b" });
    listModels.mockResolvedValue([
      { id: "model-a", label: "Model A" },
      { id: "model-b", label: "Model B" },
    ]);

    await useChatStore.getState().loadModels();

    const state = useChatStore.getState();
    expect(state.selectedModel).toBe("model-b");
    expect(state.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);
  });

  it("falls back to an empty selectedModel when the model list is empty", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "" });
    listModels.mockResolvedValue([]);

    await useChatStore.getState().loadModels();

    const state = useChatStore.getState();
    expect(state.models).toEqual([]);
    expect(state.selectedModel).toBe("");
  });
});

describe("chat-store.selectModel", () => {
  it("sets selectedModel to the given id and nothing else", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "old-model" });

    useChatStore.getState().selectModel("new-model");

    const state = useChatStore.getState();
    expect(state.selectedModel).toBe("new-model");
    expect(state.selectedModel).not.toBe("old-model");
  });
});

describe("chat-store.resetConversation", () => {
  it("clears messages/status/error and issues a fresh conversationId", async () => {
    const { useChatStore } = await import("./chat-store");
    const previousId = useChatStore.getState().conversationId;
    useChatStore.setState({
      messages: [{ id: "1", role: "user", content: "hi" }],
      status: "error",
      errorMessage: "boom",
      activeRequestId: "req-x",
    });

    useChatStore.getState().resetConversation();

    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();
    expect(state.activeRequestId).toBeNull();
    expect(state.conversationId).not.toBe(previousId);
  });
});

describe("chat-store.loadSessions / loadWorkspace", () => {
  beforeEach(() => {
    vi.resetModules();
    listSessions.mockReset();
    getWorkspace.mockReset();
  });

  it("loadSessions replaces sessions with whatever the desktop API returns", async () => {
    const { useChatStore } = await import("./chat-store");
    const sessions = [{ id: "s1", title: "Chat 1", model: "m", updatedAt: 1 }];
    listSessions.mockResolvedValue(sessions);

    await useChatStore.getState().loadSessions();

    const state = useChatStore.getState();
    expect(state.sessions).toEqual(sessions);
    expect(state.sessions).toHaveLength(1);
  });

  it("loadWorkspace sets workspaceDir and triggers a sessions reload", async () => {
    const { useChatStore } = await import("./chat-store");
    getWorkspace.mockResolvedValue({ dir: "/some/dir" });
    listSessions.mockResolvedValue([{ id: "a", title: "t", model: "m", updatedAt: 2 }]);

    await useChatStore.getState().loadWorkspace();

    const state = useChatStore.getState();
    expect(state.workspaceDir).toBe("/some/dir");
    expect(state.sessions).toHaveLength(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});

describe("chat-store.chooseWorkspace", () => {
  beforeEach(() => {
    vi.resetModules();
    chooseWorkspace.mockReset();
    listSessions.mockReset();
  });

  it("does nothing when the user cancels the workspace picker", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ workspaceDir: "/original" });
    chooseWorkspace.mockResolvedValue(null);

    await useChatStore.getState().chooseWorkspace();

    const state = useChatStore.getState();
    expect(state.workspaceDir).toBe("/original");
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("updates workspaceDir, resets the conversation, and reloads sessions when a new folder is chosen", async () => {
    const { useChatStore } = await import("./chat-store");
    const previousId = useChatStore.getState().conversationId;
    useChatStore.setState({
      workspaceDir: "/original",
      messages: [{ id: "1", role: "user", content: "hi" }],
    });
    chooseWorkspace.mockResolvedValue({ dir: "/new-folder" });
    listSessions.mockResolvedValue([]);

    await useChatStore.getState().chooseWorkspace();

    const state = useChatStore.getState();
    expect(state.workspaceDir).toBe("/new-folder");
    expect(state.conversationId).not.toBe(previousId);
    expect(state.messages).toEqual([]);
  });
});

describe("chat-store.loadConversation", () => {
  beforeEach(() => {
    vi.resetModules();
    getSession.mockReset();
  });

  it("does nothing when the session cannot be found", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ conversationId: "current" });
    getSession.mockResolvedValue(null);

    await useChatStore.getState().loadConversation("missing");

    const state = useChatStore.getState();
    expect(state.conversationId).toBe("current");
    expect(state.messages).toEqual([]);
  });

  it("restores the session's messages, model, and id, and clears error/active-request state", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({
      status: "error",
      errorMessage: "old error",
      activeRequestId: "req-old",
    });
    getSession.mockResolvedValue({
      id: "session-42",
      model: "model-restored",
      messages: [{ role: "user", content: "hello there" }],
    });

    await useChatStore.getState().loadConversation("session-42");

    const state = useChatStore.getState();
    expect(state.conversationId).toBe("session-42");
    expect(state.selectedModel).toBe("model-restored");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("hello there");
    expect(state.status).toBe("idle");
    expect(state.errorMessage).toBeNull();
    expect(state.activeRequestId).toBeNull();
  });

  it("keeps the current selectedModel when the restored session has no model recorded", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "kept-model" });
    getSession.mockResolvedValue({
      id: "session-no-model",
      model: "",
      messages: [],
    });

    await useChatStore.getState().loadConversation("session-no-model");

    const state = useChatStore.getState();
    expect(state.selectedModel).toBe("kept-model");
    expect(state.conversationId).toBe("session-no-model");
  });
});

describe("chat-store.deleteSession", () => {
  beforeEach(() => {
    vi.resetModules();
    deleteSession.mockReset();
    listSessions.mockReset();
  });

  it("removes the session and resets the conversation when deleting the active one", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({
      conversationId: "active-session",
      messages: [{ id: "1", role: "user", content: "hi" }],
    });
    deleteSession.mockResolvedValue(undefined);
    listSessions.mockResolvedValue([]);

    await useChatStore.getState().deleteSession("active-session");

    const state = useChatStore.getState();
    expect(deleteSession).toHaveBeenCalledWith("active-session");
    expect(state.conversationId).not.toBe("active-session");
    expect(state.messages).toEqual([]);
  });

  it("leaves the active conversation untouched when deleting a different, inactive session", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({
      conversationId: "active-session",
      messages: [{ id: "1", role: "user", content: "hi" }],
    });
    deleteSession.mockResolvedValue(undefined);
    listSessions.mockResolvedValue([]);

    await useChatStore.getState().deleteSession("other-session");

    const state = useChatStore.getState();
    expect(deleteSession).toHaveBeenCalledWith("other-session");
    expect(state.conversationId).toBe("active-session");
    expect(state.messages).toHaveLength(1);
  });
});

describe("chat-store.stopGeneration", () => {
  beforeEach(() => {
    vi.resetModules();
    cancelChat.mockReset();
    listSessions.mockReset();
  });

  it("does nothing when there is no active request", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ activeRequestId: null, status: "idle" });

    await useChatStore.getState().stopGeneration();

    expect(cancelChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("cancels the active request, clears streaming flags, and returns to idle", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({
      activeRequestId: "req-1",
      status: "streaming",
      messages: [
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "partial", streaming: true },
      ],
    });
    cancelChat.mockResolvedValue(undefined);
    listSessions.mockResolvedValue([]);

    await useChatStore.getState().stopGeneration();

    const state = useChatStore.getState();
    expect(cancelChat).toHaveBeenCalledWith("req-1");
    expect(state.status).toBe("idle");
    expect(state.activeRequestId).toBeNull();
    expect(state.messages.find((m) => m.id === "a1")?.streaming).toBe(false);
  });
});

describe("chat-store.sendMessage streaming events", () => {
  beforeEach(() => {
    vi.resetModules();
    startChat.mockReset();
    onChatEvent.mockReset();
    listSessions.mockReset().mockResolvedValue([]);
  });

  it("ignores empty/whitespace-only text and never calls startChat", async () => {
    const { useChatStore } = await import("./chat-store");
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("   ");

    const state = useChatStore.getState();
    expect(state.messages).toEqual([]);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("applies text-delta events only for the currently active request and appends to the assistant message", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockResolvedValue({ requestId: "req-active" });
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");
    // Event for a stale/different request id must be ignored.
    capturedHandler?.({ type: "text-delta", requestId: "req-stale", text: "ignored" });
    // Event for the active request id must be applied.
    capturedHandler?.({ type: "text-delta", requestId: "req-active", text: "world" });

    const state = useChatStore.getState();
    expect(state.status).toBe("streaming");
    const assistantMessage = state.messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.content).toBe("world");
  });

  it("marks the assistant message complete and idle status on a completed event, and reloads sessions", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockResolvedValue({ requestId: "req-1" });
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");
    capturedHandler?.({ type: "completed", requestId: "req-1" });

    const state = useChatStore.getState();
    expect(state.status).toBe("idle");
    expect(state.activeRequestId).toBeNull();
    const assistantMessage = state.messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.streaming).toBe(false);
  });

  it("records the error on the assistant message and sets error status on an error event", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockResolvedValue({ requestId: "req-err" });
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");
    capturedHandler?.({ type: "error", requestId: "req-err", message: "provider exploded" });

    const state = useChatStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("provider exploded");
    const assistantMessage = state.messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.error).toBe("provider exploded");
    expect(assistantMessage?.streaming).toBe(false);
  });

  it("sets message.retrying on a 'retrying' event and clears it once a text-delta arrives for the same request (issue #120)", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockResolvedValue({ requestId: "req-retry" });
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");
    capturedHandler?.({ type: "retrying", requestId: "req-retry", attempt: 1, maxAttempts: 3 });

    let assistantMessage = useChatStore.getState().messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.retrying).toEqual({ attempt: 1, maxAttempts: 3 });

    capturedHandler?.({ type: "text-delta", requestId: "req-retry", text: "back " });

    assistantMessage = useChatStore.getState().messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.retrying).toBeUndefined();
    expect(assistantMessage?.content).toBe("back ");
  });

  it("clears message.retrying on a completed event (issue #120)", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockResolvedValue({ requestId: "req-retry-done" });
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");
    capturedHandler?.({ type: "retrying", requestId: "req-retry-done", attempt: 2, maxAttempts: 3 });
    capturedHandler?.({ type: "completed", requestId: "req-retry-done" });

    const assistantMessage = useChatStore.getState().messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.retrying).toBeUndefined();
    expect(assistantMessage?.streaming).toBe(false);
  });

  // Regression coverage for https://github.com/tbrandenburg/pi-desktop/issues/118:
  // an event (e.g. a fast OAuth-refresh "error") that arrives before
  // startChat's promise resolves (and thus before activeRequestId is set)
  // must be buffered and replayed, not silently dropped.
  it("buffers and replays a chat:event that arrives before startChat resolves (issue #118)", async () => {
    const { useChatStore } = await import("./chat-store");
    let capturedHandler: ((event: ChatEvent) => void) | undefined;
    onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
      capturedHandler = handler;
      return () => {};
    });
    startChat.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Fire the error event synchronously, before startChat's own
          // promise resolves and activeRequestId gets set.
          capturedHandler?.({
            type: "error",
            requestId: "req-fast-fail",
            message: "OAuth refresh failed for github-copilot",
          });
          // Resolve on a later microtask so the race is exercised.
          queueMicrotask(() => resolve({ requestId: "req-fast-fail" }));
        }),
    );
    useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

    await useChatStore.getState().sendMessage("hello");

    const state = useChatStore.getState();
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("OAuth refresh failed for github-copilot");
    const assistantMessage = state.messages.find((m) => m.role === "assistant");
    expect(assistantMessage?.streaming).toBe(false);
    expect(assistantMessage?.error).toBe("OAuth refresh failed for github-copilot");
    expect(assistantMessage?.content).toBe("");
  });

  // Coverage for issue #119's stuck-bubble safety net: if no event at all
  // arrives for an assistant message (dead IPC channel, main process crash
  // before responding, etc.), it must flip to an error state after the
  // timeout instead of staying "streaming" forever.
  it("flips a stuck streaming message to error after the timeout with no events (issue #119)", async () => {
    vi.useFakeTimers();
    try {
      const { useChatStore } = await import("./chat-store");
      onChatEvent.mockImplementation(() => () => {});
      startChat.mockResolvedValue({ requestId: "req-stuck" });
      useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

      const sendPromise = useChatStore.getState().sendMessage("hello");
      await vi.advanceTimersByTimeAsync(0);
      await sendPromise;

      let state = useChatStore.getState();
      const assistantMessage = state.messages.find((m) => m.role === "assistant");
      expect(assistantMessage?.streaming).toBe(true);
      expect(assistantMessage?.error).toBeUndefined();

      await vi.advanceTimersByTimeAsync(20000);

      state = useChatStore.getState();
      expect(state.status).toBe("error");
      expect(state.errorMessage).toBe("No response received");
      const settled = state.messages.find((m) => m.role === "assistant");
      expect(settled?.streaming).toBe(false);
      expect(settled?.error).toBe("No response received");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the stuck-bubble timeout once a completed event has already resolved the message (issue #119)", async () => {
    vi.useFakeTimers();
    try {
      const { useChatStore } = await import("./chat-store");
      let capturedHandler: ((event: ChatEvent) => void) | undefined;
      onChatEvent.mockImplementation((handler: (event: ChatEvent) => void) => {
        capturedHandler = handler;
        return () => {};
      });
      startChat.mockResolvedValue({ requestId: "req-fast" });
      useChatStore.setState({ selectedModel: "gpt-4o-mini", messages: [] });

      const sendPromise = useChatStore.getState().sendMessage("hello");
      await vi.advanceTimersByTimeAsync(0);
      await sendPromise;
      capturedHandler?.({ type: "completed", requestId: "req-fast" });

      await vi.advanceTimersByTimeAsync(20000);

      const state = useChatStore.getState();
      expect(state.status).toBe("idle");
      const assistantMessage = state.messages.find((m) => m.role === "assistant");
      expect(assistantMessage?.streaming).toBe(false);
      expect(assistantMessage?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
