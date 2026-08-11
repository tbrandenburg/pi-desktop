// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useExtensionUIStore } from "../state/extension-ui-store";

const respondExtensionUI = vi.fn();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => ({ respondExtensionUI }),
}));

import { InputDialog } from "./InputDialog";

describe("InputDialog", () => {
  afterEach(() => {
    cleanup();
    respondExtensionUI.mockReset();
    useExtensionUIStore.getState().clearPending();
  });

  it("renders nothing without an input request", () => {
    const { container } = render(<InputDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders nothing for a non-input request", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "confirm-1",
      kind: "confirm",
      title: "Continue?",
      message: "Continue with this action?",
    });
    const { container } = render(<InputDialog />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("renders the input request details and controls", () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "input-1",
      kind: "input",
      title: "Project name",
      placeholder: "Enter a project name",
    });
    render(<InputDialog />);

    expect(screen.getByRole("heading", { name: "Project name" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Enter a project name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  it("submits the typed value with the request id and clears the dialog", async () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "input-submit",
      kind: "input",
      title: "Value",
      placeholder: "Type a value",
    });
    const user = userEvent.setup();
    render(<InputDialog />);
    const input = screen.getByPlaceholderText("Type a value");

    await user.type(input, "typed value");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(respondExtensionUI).toHaveBeenCalledTimes(1);
    expect(respondExtensionUI).toHaveBeenCalledWith("input-submit", {
      kind: "input",
      value: "typed value",
    });
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();

    act(() => {
      useExtensionUIStore.getState().handleRequest({
        requestId: "input-submit-again",
        kind: "input",
        title: "Value again",
        placeholder: "Type another value",
      });
    });
    expect((screen.getByPlaceholderText("Type another value") as HTMLInputElement).value).toBe("");
  });

  it("cancels with undefined and clears the dialog", async () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "input-cancel",
      kind: "input",
      title: "Value",
      placeholder: "Type a value",
    });
    const user = userEvent.setup();
    render(<InputDialog />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(respondExtensionUI).toHaveBeenCalledTimes(1);
    expect(respondExtensionUI).toHaveBeenCalledWith("input-cancel", {
      kind: "input",
      value: undefined,
    });
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("submits the current value when Enter is pressed", async () => {
    useExtensionUIStore.getState().handleRequest({
      requestId: "input-enter",
      kind: "input",
      title: "Value",
      placeholder: "Type a value",
    });
    const user = userEvent.setup();
    render(<InputDialog />);
    const input = screen.getByPlaceholderText("Type a value");

    await user.type(input, "entered value{Enter}");

    expect(respondExtensionUI).toHaveBeenCalledTimes(1);
    expect(respondExtensionUI).toHaveBeenCalledWith("input-enter", {
      kind: "input",
      value: "entered value",
    });
    expect(useExtensionUIStore.getState().pending).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
