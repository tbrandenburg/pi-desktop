import { describe, it, expect, vi, beforeEach } from "vitest";

const startChat = vi.fn();
const onChatEvent = vi.fn(() => () => {});
const listModels = vi.fn();
const listSessions = vi.fn();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    startChat,
    onChatEvent,
    listModels,
    listSessions,
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    cancelChat: vi.fn(),
    getWorkspace: vi.fn().mockResolvedValue({ dir: "/home/test" }),
    chooseWorkspace: vi.fn(),
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
