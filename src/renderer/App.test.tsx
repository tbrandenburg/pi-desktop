// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./components/AppShell", () => ({
  AppShell: () => <div data-testid="app-shell-stub">app shell rendered</div>,
}));

import { App } from "./App";

describe("App", () => {
  it("renders the AppShell component", () => {
    render(<App />);
    const shell = screen.getByTestId("app-shell-stub");
    expect(shell).not.toBeNull();
    expect(shell.textContent).toBe("app shell rendered");
  });

  it("renders exactly one AppShell instance and nothing else at the top level", () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll('[data-testid="app-shell-stub"]')).toHaveLength(1);
    expect(container.children).toHaveLength(1);
  });
});
