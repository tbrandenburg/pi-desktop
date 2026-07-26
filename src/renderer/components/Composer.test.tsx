// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";

const sendMessage = vi.fn();
const stopGeneration = vi.fn();
const selectModel = vi.fn();

const baseState = {
  status: "idle" as const,
  sendMessage,
  stopGeneration,
  selectedModel: "gpt-4o-mini",
  models: [{ id: "gpt-4o-mini", label: "GPT-4o mini" }],
  selectModel,
};

vi.mock("../state/chat-store", () => {
  return {
    useChatStore: (selector: (state: typeof baseState) => unknown) => selector(currentState),
  };
});

let currentState = { ...baseState };

describe("Composer", () => {
  beforeEach(async () => {
    sendMessage.mockReset();
    stopGeneration.mockReset();
    selectModel.mockReset();
    currentState = { ...baseState };
  });

  afterEach(() => {
    cleanup();
  });

  it("sends the typed message when clicking Send", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "hello there");
    await user.click(screen.getByTitle("Send"));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("hello there");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("submits on Enter without shift", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "hello{Enter}");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("hello");
  });

  it("does not submit on Shift+Enter, inserting a newline instead", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");

    expect(sendMessage).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("line one\nline two");
  });

  it("disables the Send button and does nothing when no model is selected", async () => {
    currentState = { ...baseState, selectedModel: "" };
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "hello");
    const sendButton = screen.getByTitle("Select a model to start chatting");

    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    await user.click(sendButton);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
