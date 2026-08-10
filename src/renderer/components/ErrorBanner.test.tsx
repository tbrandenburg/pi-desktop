// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ErrorBanner } from "./ErrorBanner";

afterEach(() => cleanup());

describe("ErrorBanner", () => {
  it("renders the supplied error message in a banner element", () => {
    render(<ErrorBanner message="Unable to connect to the provider" />);

    const banner = screen.getByText("Unable to connect to the provider");

    expect(banner.tagName).toBe("DIV");
    expect(banner.textContent).toBe("Unable to connect to the provider");
  });

  it("applies the error banner styling to the rendered message", () => {
    render(<ErrorBanner message="Request failed" />);

    const banner = screen.getByText("Request failed");

    expect(banner.className).toContain("border-red-500/30");
    expect(banner.className).toContain("bg-red-500/10");
  });
});
