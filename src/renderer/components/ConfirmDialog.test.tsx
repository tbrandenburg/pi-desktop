// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ExtensionUIResponse } from "../../shared/events";
import { useExtensionUIStore } from "../state/extension-ui-store";

const responses = vi.hoisted(() => [] as Array<{ requestId: string; response: ExtensionUIResponse }>);

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({
    respondExtensionUI: async (requestId: string, response: ExtensionUIResponse) => {
      responses.push({ requestId, response });
    },
  }),
}));

import { ConfirmDialog } from "./ConfirmDialog";

afterEach(() => {
  cleanup();
  responses.length = 0;
  useExtensionUIStore.getState().clearPending();
});

describe("ConfirmDialog", () => {
  it("renders nothing without a pending confirm request", () => {
    const { container } = render(<ConfirmDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for a non-confirm pending request", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "select-1",
      kind: "select",
      title: "Choose one",
      options: ["A", "B"],
    });
    const { container } = render(<ConfirmDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("renders the confirm title, message, and response buttons", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "confirm-1",
      kind: "confirm",
      title: "Delete project?",
      message: "This cannot be undone.",
    });
    render(<ConfirmDialog />);

    expect(screen.getByRole("heading", { name: "Delete project?" })).not.toBeNull();
    expect(screen.getByText("This cannot be undone.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "No" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Yes" })).not.toBeNull();
  });

  it("responds false with the request id and clears the pending request", async () => {
    const user = userEvent.setup();
    useExtensionUIStore.getState().handleRequest({
      requestId: "confirm-no-42",
      kind: "confirm",
      title: "Continue?",
      message: "Please choose.",
    });
    render(<ConfirmDialog />);

    await user.click(screen.getByRole("button", { name: "No" }));

    expect(responses).toEqual([
      { requestId: "confirm-no-42", response: { kind: "confirm", value: false } },
    ]);
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("responds true with the request id and clears the pending request", async () => {
    const user = userEvent.setup();
    useExtensionUIStore.getState().handleRequest({
      requestId: "confirm-yes-73",
      kind: "confirm",
      title: "Enable feature?",
      message: "This changes the workspace.",
    });
    render(<ConfirmDialog />);

    await user.click(screen.getByRole("button", { name: "Yes" }));

    expect(responses).toEqual([
      { requestId: "confirm-yes-73", response: { kind: "confirm", value: true } },
    ]);
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("button", { name: "No" })).toBeNull();
  });
});
