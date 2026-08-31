// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { NotificationToast } from "./NotificationToast";

afterEach(() => {
  cleanup();
  useExtensionUIStore.setState({ notification: null });
});

describe("NotificationToast", () => {
  it("renders nothing without a pending notification", () => {
    const { container } = render(<NotificationToast />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an error toast with the error tone class", () => {
    useExtensionUIStore.setState({
      notification: { requestId: "notify-1", kind: "notify", message: "Something broke", level: "error" },
    });
    render(<NotificationToast />);

    const toast = screen.getByText("Something broke").closest("div");
    expect(toast?.className).toContain("border-red-500/40");
    expect(toast?.className).toContain("text-red-200");
  });

  it("shows a warning toast with the warning tone class, not error or default", () => {
    useExtensionUIStore.setState({
      notification: { requestId: "notify-2", kind: "notify", message: "Careful now", level: "warning" },
    });
    render(<NotificationToast />);

    const toast = screen.getByText("Careful now").closest("div");
    expect(toast?.className).toContain("border-yellow-500/40");
    expect(toast?.className).toContain("text-yellow-200");
    expect(toast?.className).not.toContain("border-red-500/40");
    expect(toast?.className).not.toContain("border-surface-border");
  });

  it("shows an info toast with the default tone class, not error or warning", () => {
    useExtensionUIStore.setState({
      notification: { requestId: "notify-3", kind: "notify", message: "Just so you know", level: "info" },
    });
    render(<NotificationToast />);

    const toast = screen.getByText("Just so you know").closest("div");
    expect(toast?.className).toContain("border-surface-border");
    expect(toast?.className).toContain("text-white/80");
    expect(toast?.className).not.toContain("border-red-500/40");
    expect(toast?.className).not.toContain("border-yellow-500/40");
  });

  it("dismisses the notification when the close button is clicked", async () => {
    const user = userEvent.setup();
    useExtensionUIStore.setState({
      notification: { requestId: "notify-4", kind: "notify", message: "Bye now", level: "info" },
    });
    render(<NotificationToast />);

    await user.click(screen.getByRole("button", { name: "×" }));

    expect(useExtensionUIStore.getState().notification).toBeNull();
    expect(screen.queryByText("Bye now")).toBeNull();
  });
});
