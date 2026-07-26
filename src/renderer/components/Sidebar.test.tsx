// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const loadWorkspace = vi.fn().mockResolvedValue(undefined);
const chooseWorkspace = vi.fn().mockResolvedValue(undefined);
const loadConversation = vi.fn().mockResolvedValue(undefined);
const resetConversation = vi.fn();
const deleteSession = vi.fn().mockResolvedValue(undefined);
const getVersion = vi.fn().mockResolvedValue("1.2.3");

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    getVersion,
  }),
}));

const sessions = [
  { id: "session-active", title: "Active session" },
  { id: "session-other", title: "Other session" },
];

const baseState = {
  conversationId: "session-active",
  sessions,
  workspaceDir: "/home/test/workspace",
  loadWorkspace,
  chooseWorkspace,
  loadConversation,
  resetConversation,
  deleteSession,
};

let currentState = { ...baseState };

vi.mock("../state/chat-store", () => {
  return {
    useChatStore: (selector: (state: typeof baseState) => unknown) => selector(currentState),
  };
});

async function renderExpandedSidebar() {
  const user = userEvent.setup();
  const { Sidebar } = await import("./Sidebar");
  render(<Sidebar />);
  await user.click(screen.getByTitle("Expand sidebar"));
  return user;
}

describe("Sidebar", () => {
  beforeEach(() => {
    loadWorkspace.mockClear();
    chooseWorkspace.mockClear();
    loadConversation.mockClear();
    resetConversation.mockClear();
    deleteSession.mockClear();
    getVersion.mockClear().mockResolvedValue("1.2.3");
    currentState = { ...baseState, sessions: [...sessions] };
  });

  afterEach(() => {
    cleanup();
  });

  it("deletes the active session when its delete button is clicked", async () => {
    const user = await renderExpandedSidebar();

    await user.click(screen.getByRole("button", { name: "Delete Active session" }));

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("session-active");
  });

  it("deletes an inactive session when its delete button is clicked", async () => {
    const user = await renderExpandedSidebar();

    await user.click(screen.getByRole("button", { name: "Delete Other session" }));

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("session-other");
  });

  it("loads the conversation when clicking a session title", async () => {
    const user = await renderExpandedSidebar();

    await user.click(screen.getByTitle("Other session"));

    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(loadConversation).toHaveBeenCalledWith("session-other");
  });
});
