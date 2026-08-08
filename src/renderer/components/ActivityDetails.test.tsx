// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ActivityDetails } from "./ActivityDetails";
import type { Activity } from "../state/chat-store";

afterEach(() => cleanup());

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "call-1",
    toolName: "web_search",
    label: "Searched the web",
    args: { query: "hello" },
    status: "done",
    durationMs: 2200,
    ...overrides,
  };
}

describe("ActivityDetails sources section", () => {
  it("omits the Sources section entirely when no activity has sources", () => {
    render(<ActivityDetails activity={[makeActivity()]} open onClose={() => {}} />);
    expect(screen.queryByText("Sources")).toBeNull();
  });

  it("renders numbered external links for combined sources across activities", () => {
    render(
      <ActivityDetails
        activity={[
          makeActivity({ id: "a", sources: [{ title: "MDN", url: "https://developer.mozilla.org" }] }),
          makeActivity({ id: "b", sources: [{ title: "Wiki", url: "https://wikipedia.org" }] }),
        ]}
        open
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Sources")).toBeTruthy();
    const mdnLink = screen.getByRole("link", { name: /MDN/ });
    expect(mdnLink.getAttribute("href")).toBe("https://developer.mozilla.org");
    expect(mdnLink.getAttribute("target")).toBe("_blank");
    const wikiLink = screen.getByRole("link", { name: /Wiki/ });
    expect(wikiLink.getAttribute("href")).toBe("https://wikipedia.org");
  });
});

describe("ActivityDetails technical trace", () => {
  it("always opens with Technical trace collapsed, and expands it on click", () => {
    render(<ActivityDetails activity={[makeActivity({ durationMs: 2200 })]} open onClose={() => {}} />);
    expect(screen.queryByText("✓ 2.2s")).toBeNull();
    fireEvent.click(screen.getByText("Technical trace"));
    expect(screen.getByText("✓ 2.2s")).toBeTruthy();
  });

  it("stays collapsed on open even across re-renders that might carry an external expanded-by-default signal", () => {
    const { rerender } = render(
      <ActivityDetails activity={[makeActivity({ durationMs: 2200 })]} open={false} onClose={() => {}} />,
    );
    rerender(<ActivityDetails activity={[makeActivity({ durationMs: 2200 })]} open onClose={() => {}} />);
    expect(screen.queryByText("✓ 2.2s")).toBeNull();
    expect(screen.getByText("Technical trace")).toBeTruthy();
  });

  it("shows a human-readable success duration instead of raw isError text", () => {
    render(<ActivityDetails activity={[makeActivity({ durationMs: 2200 })]} open onClose={() => {}} />);
    fireEvent.click(screen.getByText("Technical trace"));
    expect(screen.getByText("✓ 2.2s")).toBeTruthy();
    expect(screen.queryByText(/isError/)).toBeNull();
  });

  it("shows an explicit failed affordance for errored trace rows", () => {
    render(
      <ActivityDetails activity={[makeActivity({ status: "error", durationMs: 100 })]} open onClose={() => {}} />,
    );
    fireEvent.click(screen.getByText("Technical trace"));
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByText(/isError/)).toBeNull();
  });
});

describe("ActivityDetails ACTIVITY row duration formatting (closes #158)", () => {
  it("renders the ACTIVITY row's duration in seconds format, not raw milliseconds", () => {
    render(<ActivityDetails activity={[makeActivity({ durationMs: 22105 })]} open onClose={() => {}} />);
    expect(screen.getByText("22.1s")).toBeTruthy();
    expect(screen.queryByText("22105ms")).toBeNull();
  });
});

describe("ActivityDetails viewport-aware positioning", () => {
  it("flips the panel upward when there is not enough room below the anchor", () => {
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 700, bottom: 720, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

    const { container } = render(<ActivityDetails activity={[makeActivity()]} open onClose={() => {}} />);
    const panel = container.querySelector("div.absolute");
    expect(panel?.className).toContain("bottom-full");
    expect(panel?.className).not.toContain("mt-2");

    getBoundingClientRectSpy.mockRestore();
  });

  it("anchors downward (default) when there is enough room below", () => {
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ top: 10, bottom: 30, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

    const { container } = render(<ActivityDetails activity={[makeActivity()]} open onClose={() => {}} />);
    const panel = container.querySelector("div.absolute");
    expect(panel?.className).toContain("mt-2");
    expect(panel?.className).not.toContain("bottom-full");

    getBoundingClientRectSpy.mockRestore();
  });

  it("anchors the panel's right edge to its trigger (right-0), regardless of up/down flip", () => {
    const { container } = render(<ActivityDetails activity={[makeActivity()]} open onClose={() => {}} />);
    const panel = container.querySelector("div.absolute");
    expect(panel?.className).toContain("right-0");
    expect(panel?.className).toContain("w-[400px]");
  });
});
