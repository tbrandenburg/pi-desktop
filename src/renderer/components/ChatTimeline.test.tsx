// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { DisplayMessage } from "../state/chat-store";

const setToolsExpanded = vi.fn();

const baseChatState = {
  messages: [] as DisplayMessage[],
  status: "idle" as const,
  toolsExpanded: false,
  setToolsExpanded,
};

let currentChatState = { ...baseChatState };

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (state: typeof baseChatState) => unknown) => selector(currentChatState),
}));

const baseExtensionUiState = {
  dataPushes: {} as Record<string, unknown>,
};

let currentExtensionUiState = { ...baseExtensionUiState };

vi.mock("../state/extension-ui-store", () => ({
  useExtensionUIStore: (selector: (state: typeof baseExtensionUiState) => unknown) => selector(currentExtensionUiState),
}));

// Coverage for issue #151: activity is now rendered inline per-message via
// `MessageBubble`/`AgentActivity`, not as sibling `ToolCallBubble` entries,
// and there is no more global expand/collapse header button.
describe("ChatTimeline message rendering (issue #151)", () => {
  beforeEach(() => {
    setToolsExpanded.mockClear();
    currentChatState = { ...baseChatState };
    currentExtensionUiState = { ...baseExtensionUiState };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders every message via MessageBubble, including one with grouped activity", async () => {
    currentChatState = {
      ...baseChatState,
      messages: [
        { id: "1", role: "user", content: "hi" },
        {
          id: "2",
          role: "assistant",
          content: "done reading",
          activity: [
            {
              id: "call-1",
              toolName: "read",
              label: "Reading files…",
              args: { path: "x" },
              status: "done",
              durationMs: 12,
            },
          ],
        },
      ],
    };
    const { ChatTimeline } = await import("./ChatTimeline");
    render(<ChatTimeline />);

    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.getByText("done reading")).toBeTruthy();
    expect(screen.getByText("Reading files…")).toBeTruthy();
  });

  it("no longer renders a global expand/collapse tool-calls header button", async () => {
    currentChatState = {
      ...baseChatState,
      messages: [{ id: "1", role: "user", content: "hi" }],
    };
    const { ChatTimeline } = await import("./ChatTimeline");
    render(<ChatTimeline />);

    expect(screen.queryByText(/expand tool calls/i)).toBeNull();
    expect(screen.queryByText(/collapse tool calls/i)).toBeNull();
  });
});
