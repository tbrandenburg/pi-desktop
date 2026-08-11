// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => {
  const chatState = {
    loadModels: vi.fn().mockResolvedValue(undefined),
    loadCommands: vi.fn().mockResolvedValue(undefined),
    errorMessage: null as string | null,
  };
  const settingsState = { open: vi.fn() };
  const extensionState = {
    handleRequest: vi.fn(),
    dataPushes: {
      "set-title": undefined as { kind: "set-title"; title: string } | undefined,
      "set-status": undefined as { kind: "set-status"; key: string; text: string | undefined } | undefined,
    },
  };
  const onExtensionUIRequest = vi.fn();
  const listShortcuts = vi.fn().mockResolvedValue([]);
  const triggerShortcut = vi.fn().mockResolvedValue(undefined);
  const cleanupSubscription = vi.fn();
  const initialLoadModels = chatState.loadModels;
  const initialLoadCommands = chatState.loadCommands;
  const initialHandler = extensionState.handleRequest;

  return {
    chatState,
    settingsState,
    extensionState,
    onExtensionUIRequest,
    listShortcuts,
    triggerShortcut,
    cleanupSubscription,
    initialLoadModels,
    initialLoadCommands,
    initialHandler,
  };
});

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    listShortcuts: mocks.listShortcuts,
    triggerShortcut: mocks.triggerShortcut,
    onExtensionUIRequest: mocks.onExtensionUIRequest.mockReturnValue(mocks.cleanupSubscription),
  }),
}));

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (state: typeof mocks.chatState) => unknown) => selector(mocks.chatState),
}));

vi.mock("../state/settings-store", () => ({
  useSettingsStore: (selector: (state: typeof mocks.settingsState) => unknown) => selector(mocks.settingsState),
}));

vi.mock("../state/extension-ui-store", () => ({
  useExtensionUIStore: (selector: (state: typeof mocks.extensionState) => unknown) => selector(mocks.extensionState),
}));

vi.mock("./ChatTimeline", () => ({ ChatTimeline: () => <div data-testid="chat-timeline" /> }));
vi.mock("./Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./ErrorBanner", () => ({ ErrorBanner: ({ message }: { message: string }) => <div role="alert">{message}</div> }));
vi.mock("./InputDialog", () => ({ InputDialog: () => null }));
vi.mock("./NotificationToast", () => ({ NotificationToast: () => null }));
vi.mock("./SelectDialog", () => ({ SelectDialog: () => null }));
vi.mock("./SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside data-testid="sidebar" /> }));

import { AppShell } from "./AppShell";

describe("AppShell", () => {
  beforeEach(() => {
    mocks.chatState.errorMessage = null;
    mocks.chatState.loadModels = mocks.initialLoadModels;
    mocks.chatState.loadCommands = mocks.initialLoadCommands;
    mocks.extensionState.handleRequest = mocks.initialHandler;
    mocks.chatState.loadModels.mockClear();
    mocks.chatState.loadCommands.mockClear();
    mocks.settingsState.open.mockClear();
    mocks.extensionState.handleRequest.mockClear();
    mocks.extensionState.dataPushes["set-title"] = undefined;
    mocks.extensionState.dataPushes["set-status"] = undefined;
    mocks.onExtensionUIRequest.mockClear();
    mocks.listShortcuts.mockClear().mockResolvedValue([]);
    mocks.triggerShortcut.mockClear();
    mocks.cleanupSubscription.mockClear();
    document.documentElement.dataset.theme = "dark";
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    document.documentElement.dataset.theme = "dark";
    localStorage.clear();
  });

  it("loads models and commands and subscribes to extension UI requests on mount", async () => {
    render(<AppShell />);

    await waitFor(() => {
      expect(mocks.chatState.loadModels).toHaveBeenCalledTimes(1);
      expect(mocks.chatState.loadCommands).toHaveBeenCalledTimes(1);
    });
    expect(mocks.onExtensionUIRequest).toHaveBeenCalledTimes(1);
    expect(mocks.onExtensionUIRequest).toHaveBeenCalledWith(mocks.extensionState.handleRequest);
  });

  it("reruns loading effects when their store actions change", async () => {
    const view = render(<AppShell />);
    const replacementLoadModels = vi.fn().mockResolvedValue(undefined);
    const replacementLoadCommands = vi.fn().mockResolvedValue(undefined);
    mocks.chatState.loadModels = replacementLoadModels;
    mocks.chatState.loadCommands = replacementLoadCommands;

    view.rerender(<AppShell />);

    await waitFor(() => {
      expect(replacementLoadModels).toHaveBeenCalledTimes(1);
      expect(replacementLoadCommands).toHaveBeenCalledTimes(1);
    });
    expect(mocks.chatState.loadModels).toBe(replacementLoadModels);
    expect(mocks.chatState.loadCommands).toBe(replacementLoadCommands);
  });

  it("resubscribes when the extension request handler changes", () => {
    const view = render(<AppShell />);
    const replacementHandler = vi.fn();
    mocks.extensionState.handleRequest = replacementHandler;

    view.rerender(<AppShell />);

    expect(mocks.onExtensionUIRequest).toHaveBeenCalledTimes(2);
    expect(mocks.onExtensionUIRequest).toHaveBeenLastCalledWith(replacementHandler);
  });

  it("removes the extension UI subscription when unmounted", () => {
    const { unmount } = render(<AppShell />);

    unmount();

    expect(mocks.cleanupSubscription).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("toggles the theme and persists the selected value", async () => {
    const user = userEvent.setup();
    render(<AppShell />);
    const toggle = screen.getByRole("button", { name: "Switch to light mode" });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Switch to dark mode" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" })).toBeTruthy();
  });

  it("seeds the theme from a light document attribute", () => {
    document.documentElement.dataset.theme = "light";

    render(<AppShell />);

    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("opens settings and renders the fallback title", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByTitle("Settings"));

    expect(mocks.settingsState.open).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Pi Desktop")).toBeTruthy();
  });

  it("renders the error banner when the chat store reports an error", () => {
    mocks.chatState.errorMessage = "Unable to reach provider";

    render(<AppShell />);

    expect(screen.getByRole("alert").textContent).toBe("Unable to reach provider");
    expect(screen.getByTestId("chat-timeline")).toBeTruthy();
  });

  it("renders an extension title and accumulates statuses by key", async () => {
    mocks.extensionState.dataPushes["set-title"] = { kind: "set-title", title: "Release helper" };
    mocks.extensionState.dataPushes["set-status"] = { kind: "set-status", key: "git", text: "main*" };
    const view = render(<AppShell />);

    await waitFor(() => expect(screen.getByText("git: main*")).toBeTruthy());
    expect(screen.getByText("Release helper")).toBeTruthy();

    mocks.extensionState.dataPushes["set-status"] = { kind: "set-status", key: "tests", text: "passing" };
    view.rerender(<AppShell />);

    await waitFor(() => expect(screen.getByText("tests: passing")).toBeTruthy());
    expect(screen.getByText("git: main*")).toBeTruthy();
  });

  it("does not render an empty status area", () => {
    const { container } = render(<AppShell />);

    expect(screen.getByText("Pi Desktop")).toBeTruthy();
    expect(container.querySelector("header > div > div")).toBeNull();
  });

  it("clears an existing status and leaves other status keys intact", async () => {
    mocks.extensionState.dataPushes["set-status"] = { kind: "set-status", key: "git", text: "main*" };
    const view = render(<AppShell />);
    await waitFor(() => expect(screen.getByText("git: main*")).toBeTruthy());

    mocks.extensionState.dataPushes["set-status"] = { kind: "set-status", key: "tests", text: "passing" };
    view.rerender(<AppShell />);
    await waitFor(() => expect(screen.getByText("tests: passing")).toBeTruthy());

    mocks.extensionState.dataPushes["set-status"] = { kind: "set-status", key: "git", text: undefined };
    view.rerender(<AppShell />);

    await waitFor(() => expect(screen.queryByText("git: main*")).toBeNull());
    expect(screen.getByText("tests: passing")).toBeTruthy();
  });

  it("triggers a matching loaded keyboard shortcut and ignores an unmatched key", async () => {
    mocks.listShortcuts.mockResolvedValue([{ id: "open-palette", keys: "ctrl+p" }]);
    render(<AppShell />);
    await waitFor(() => expect(mocks.listShortcuts).toHaveBeenCalledTimes(1));

    const matchingEvent = createEvent.keyDown(window, { key: "p", ctrlKey: true });
    fireEvent(window, matchingEvent);
    const unmatchedEvent = createEvent.keyDown(window, { key: "x", ctrlKey: true });
    fireEvent(window, unmatchedEvent);

    expect(mocks.triggerShortcut).toHaveBeenCalledTimes(1);
    expect(mocks.triggerShortcut).toHaveBeenCalledWith("open-palette");
    expect(matchingEvent.defaultPrevented).toBe(true);
    expect(unmatchedEvent.defaultPrevented).toBe(false);
  });

  it("removes the keyboard listener when unmounted", async () => {
    mocks.listShortcuts.mockResolvedValue([{ id: "open-palette", keys: "ctrl+p" }]);
    const { unmount } = render(<AppShell />);
    await waitFor(() => expect(mocks.listShortcuts).toHaveBeenCalledTimes(1));
    unmount();

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });

    expect(mocks.triggerShortcut).not.toHaveBeenCalled();
    expect(mocks.cleanupSubscription).toHaveBeenCalledTimes(1);
  });
});
