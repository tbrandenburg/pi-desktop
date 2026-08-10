// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, within, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createFakeDesktopApi } from "../lib/fake-desktop-api";

const fakeApi = createFakeDesktopApi();

vi.mock("../lib/desktop-api", () => ({
  desktopApi: () => fakeApi,
}));

vi.mock("../state/settings-store", () => {
  let isOpen = true;
  return {
    useSettingsStore: (selector: (state: { isOpen: boolean; close: () => void }) => unknown) =>
      selector({ isOpen, close: () => (isOpen = false) }),
  };
});

describe("SettingsDialog recommended packages", () => {
  afterEach(() => {
    cleanup();
  });

  it(
    "shows an Install button for a recommended package that is not yet installed",
    async () => {
      const { SettingsDialog } = await import("./SettingsDialog");
      render(<SettingsDialog />);

      const recommendedItem = (await screen.findByText(/pi-web-access/)).closest("li");
      expect(recommendedItem).not.toBeNull();
      const installButton = within(recommendedItem as HTMLElement).getByRole("button", {
        name: "Install",
      }) as HTMLButtonElement;
      expect(installButton.disabled).toBe(false);
      expect(recommendedItem?.contains(installButton)).toBe(true);
    },
    10000,
  );

  it("shows a disabled Installed button once the recommended package's source is installed", async () => {
    await fakeApi.installPackage("npm:pi-web-access");
    const { SettingsDialog } = await import("./SettingsDialog");
    render(<SettingsDialog />);

    const recommendedItem = (await screen.findByText(/pi-web-access/)).closest("li");
    expect(recommendedItem).not.toBeNull();
    const installedButtons = (await screen.findAllByRole("button", {
      name: "Installed",
    })) as HTMLButtonElement[];
    expect(installedButtons).toHaveLength(1);
    expect(installedButtons[0].disabled).toBe(true);
    expect(within(recommendedItem as HTMLElement).queryByRole("button", { name: "Install" })).toBeNull();

    await fakeApi.removePackage("npm:pi-web-access");
  });

  it("installs the recommended package when Install is clicked and refreshes to Installed", async () => {
    const user = userEvent.setup();
    const { SettingsDialog } = await import("./SettingsDialog");
    render(<SettingsDialog />);

    const recommendedItem = (await screen.findByText(/pi-web-access/)).closest("li");
    const installButton = within(recommendedItem as HTMLElement).getByRole("button", {
      name: "Install",
    });
    expect(recommendedItem?.contains(installButton)).toBe(true);
    await user.click(installButton);

    await waitFor(async () => {
      const installedButtons = (await screen.findAllByRole("button", {
        name: "Installed",
      })) as HTMLButtonElement[];
      const withinRecommended = installedButtons.filter((btn) =>
        recommendedItem?.contains(btn),
      );
      expect(withinRecommended).toHaveLength(1);
      expect(withinRecommended[0].disabled).toBe(true);
    });
    const installed = await fakeApi.listPackages();
    expect(installed.some((pkg) => pkg.source === "npm:pi-web-access")).toBe(true);

    await fakeApi.removePackage("npm:pi-web-access");
  });
});
