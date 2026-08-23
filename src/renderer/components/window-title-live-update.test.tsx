// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFakeDesktopApi } from "../lib/fake-desktop-api";
import { DEFAULT_WINDOW_TITLE } from "../lib/window-title";

const fakeApi = createFakeDesktopApi();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => fakeApi,
}));

vi.mock("../state/chat-store", () => ({
  useChatStore: (selector: (state: { loadModels: () => Promise<void>; loadCommands: () => Promise<void>; errorMessage: string | null }) => unknown) =>
    selector({
      loadModels: vi.fn().mockResolvedValue(undefined),
      loadCommands: vi.fn().mockResolvedValue(undefined),
      errorMessage: null,
    }),
}));

vi.mock("../state/extension-ui-store", () => ({
  useExtensionUIStore: (selector: (state: { handleRequest: () => void; dataPushes: Record<string, unknown> }) => unknown) =>
    selector({ handleRequest: vi.fn(), dataPushes: {} }),
}));

vi.mock("../state/settings-store", () => ({
  useSettingsStore: (selector: (state: { isOpen: boolean; open: () => void; close: () => void }) => unknown) =>
    selector({ isOpen: true, open: vi.fn(), close: vi.fn() }),
}));

vi.mock("./ChatTimeline", () => ({ ChatTimeline: () => <div data-testid="chat-timeline" /> }));
vi.mock("./Composer", () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside data-testid="sidebar" /> }));

import { AppShell } from "./AppShell";

describe("window title live update (issue #251)", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("updates the header text when the Settings header title field is edited", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    expect(screen.getByText(DEFAULT_WINDOW_TITLE)).toBeTruthy();

    const input = screen.getByLabelText("Header title");
    await user.clear(input);
    await user.type(input, "Release Helper");

    await waitFor(() => expect(screen.getByText("Release Helper")).toBeTruthy());
    expect(screen.queryByText(DEFAULT_WINDOW_TITLE)).toBeNull();
    expect(localStorage.getItem("windowTitle")).toBe("Release Helper");
  });

  it("reverts the header to the default when the field is cleared", async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    const input = screen.getByLabelText("Header title");
    await user.clear(input);
    await user.type(input, "Custom Title");
    await waitFor(() => expect(screen.getByText("Custom Title")).toBeTruthy());

    await user.clear(input);

    await waitFor(() => expect(screen.getByText(DEFAULT_WINDOW_TITLE)).toBeTruthy());
    expect(localStorage.getItem("windowTitle")).toBeNull();
  });
});
