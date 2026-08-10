// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sendMessage = vi.fn();

const baseState = {
  sendMessage,
};

let currentState = { ...baseState };

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (state: typeof baseState) => unknown) => selector(currentState),
}));

const suggestions = [
  "Explain this architecture in five steps",
  "Create an implementation plan",
  "Review a project folder",
];

describe("EmptyState", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    currentState = { ...baseState };
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the empty-state heading, description, and every suggestion", async () => {
    const { EmptyState } = await import("./EmptyState");
    render(<EmptyState />);

    expect(screen.getByRole("heading", { name: "What are we building today?" })).toBeTruthy();
    expect(screen.getByText("Ask a question, explore a codebase, or draft an idea.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    for (const suggestion of suggestions) {
      expect(screen.getByRole("button", { name: suggestion })).toBeTruthy();
    }
  });

  it("sends the displayed suggestion when each suggestion is clicked", async () => {
    const user = userEvent.setup();
    const { EmptyState } = await import("./EmptyState");
    render(<EmptyState />);

    for (const suggestion of suggestions) {
      await user.click(screen.getByRole("button", { name: suggestion }));
    }

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenNthCalledWith(1, suggestions[0]);
    expect(sendMessage).toHaveBeenNthCalledWith(2, suggestions[1]);
    expect(sendMessage).toHaveBeenNthCalledWith(3, suggestions[2]);
  });
});
