// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import type { AutocompleteSuggestion } from "../../shared/events";

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
  commands: [] as { name: string; description?: string }[],
};

vi.mock("../state/chat-store", () => {
  return {
    useChatStore: (selector: (state: typeof baseState) => unknown) => selector(currentState),
  };
});

const reportEditorText = vi.fn();
const queryAutocomplete = vi.fn<(text: string) => Promise<AutocompleteSuggestion[]>>();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    reportEditorText,
    queryAutocomplete,
  }),
}));

let editorPush: { requestId: string; kind: "set-editor-text"; text: string; mode: "replace" | "paste" } | undefined;

vi.mock("../state/extension-ui-store", () => ({
  useExtensionUIStore: (selector: (state: { dataPushes: Record<string, unknown> }) => unknown) =>
    selector({ dataPushes: { "set-editor-text": editorPush } }),
}));

let currentState = { ...baseState };

describe("Composer", () => {
  beforeEach(async () => {
    sendMessage.mockReset();
    stopGeneration.mockReset();
    selectModel.mockReset();
    reportEditorText.mockReset();
    queryAutocomplete.mockReset();
    queryAutocomplete.mockResolvedValue([]);
    currentState = { ...baseState };
    editorPush = undefined;
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

  it("reports the composer text back to main on every change", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "hi");

    expect(reportEditorText).toHaveBeenCalledWith("hi");
  });

  it("replaces the composer content on a set-editor-text 'replace' push", async () => {
    editorPush = { requestId: "req-1", kind: "set-editor-text", text: "replaced text", mode: "replace" };
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("replaced text");
  });

  it("inserts (pastes) text without clobbering existing content on a 'paste' push", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    const { rerender } = render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…") as HTMLTextAreaElement;
    await user.type(textarea, "hello world");

    editorPush = { requestId: "req-2", kind: "set-editor-text", text: "PASTED", mode: "paste" };
    rerender(<Composer />);

    expect(textarea.value).toContain("hello world");
    expect(textarea.value).toContain("PASTED");
  });

  it("does not re-apply the same editor push twice", async () => {
    editorPush = { requestId: "req-3", kind: "set-editor-text", text: "once", mode: "replace" };
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    const { rerender } = render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…") as HTMLTextAreaElement;
    expect(textarea.value).toBe("once");

    await user.clear(textarea);
    await user.type(textarea, "user typed");
    rerender(<Composer />);

    expect(textarea.value).toBe("user typed");
  });

  it("shows extension-provided autocomplete suggestions alongside built-in commands", async () => {
    queryAutocomplete.mockResolvedValue([{ value: "@file.txt", description: "Insert file reference" }]);
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "@fi");

    expect(await screen.findByText("@file.txt")).toBeTruthy();
    expect(screen.getByText("Insert file reference")).toBeTruthy();
  });

  it("does not query extension autocomplete while typing a slash command", async () => {
    const user = userEvent.setup();
    const { Composer } = await import("./Composer");
    render(<Composer />);

    const textarea = screen.getByPlaceholderText("Send a message…");
    await user.type(textarea, "/foo");

    expect(queryAutocomplete).not.toHaveBeenCalled();
  });
});
