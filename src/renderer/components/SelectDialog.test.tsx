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

import { SelectDialog } from "./SelectDialog";

afterEach(() => {
  cleanup();
  responses.length = 0;
  useExtensionUIStore.getState().clearPending();
});

describe("SelectDialog", () => {
  it("renders nothing without a pending select request", () => {
    const { container } = render(<SelectDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for a non-select pending request", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "confirm-1",
      kind: "confirm",
      title: "Delete?",
      message: "Are you sure?",
    });
    const { container } = render(<SelectDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("renders the select title, one button per option, and a Cancel button", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "select-1",
      kind: "select",
      title: "Choose a model",
      options: ["gpt-5", "claude", "gemini"],
    });
    render(<SelectDialog />);

    expect(screen.getByRole("heading", { name: "Choose a model" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "gpt-5" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "claude" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "gemini" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
    const optionButtons = screen.getAllByRole("button").filter((btn) => btn.textContent !== "Cancel");
    expect(optionButtons).toHaveLength(3);
  });

  it("responds with the chosen option's value and clears the pending request", async () => {
    const user = userEvent.setup();
    useExtensionUIStore.getState().handleRequest({
      requestId: "select-42",
      kind: "select",
      title: "Pick one",
      options: ["A", "B"],
    });
    render(<SelectDialog />);

    await user.click(screen.getByRole("button", { name: "B" }));

    expect(responses).toEqual([{ requestId: "select-42", response: { kind: "select", value: "B" } }]);
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
  });

  it("responds with value undefined and clears the pending request when Cancel is clicked", async () => {
    const user = userEvent.setup();
    useExtensionUIStore.getState().handleRequest({
      requestId: "select-cancel-7",
      kind: "select",
      title: "Pick one",
      options: ["A", "B"],
    });
    render(<SelectDialog />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(responses).toEqual([
      { requestId: "select-cancel-7", response: { kind: "select", value: undefined } },
    ]);
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
  });
});
