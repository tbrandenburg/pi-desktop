// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("ChatTimeline tool-call rendering and expand toggle (issue #139)", () => {
  beforeEach(() => {
    setToolsExpanded.mockClear();
    currentChatState = { ...baseChatState };
    currentExtensionUiState = { ...baseExtensionUiState };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a tool-call entry as a ToolCallBubble alongside regular messages", async () => {
    currentChatState = {
      ...baseChatState,
      messages: [
        { id: "1", role: "user", content: "hi" },
        { id: "2", role: "assistant", content: "", toolCall: { toolName: "read_file", arguments: { path: "x" } } },
      ],
    };
    const { ChatTimeline } = await import("./ChatTimeline");
    render(<ChatTimeline />);

    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
  });

  it("calls setToolsExpanded with the toggled value when the expand button is clicked", async () => {
    currentChatState = {
      ...baseChatState,
      messages: [{ id: "1", role: "user", content: "hi" }],
      toolsExpanded: false,
    };
    const user = userEvent.setup();
    const { ChatTimeline } = await import("./ChatTimeline");
    render(<ChatTimeline />);

    await user.click(screen.getByText("Expand tool calls"));

    expect(setToolsExpanded).toHaveBeenCalledWith(true);
  });
});
