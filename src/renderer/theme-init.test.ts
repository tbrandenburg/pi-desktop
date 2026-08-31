// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BASE_FONT_SIZE_PX = 16;
const DEFAULT_ZOOM = 1.0;

describe("theme-init (import-time side effects)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.dataset.theme = "";
    document.documentElement.style.fontSize = "";
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "";
    document.documentElement.style.fontSize = "";
  });

  it("applies light theme when 'theme' is stored as 'light'", async () => {
    localStorage.setItem("theme", "light");

    await import("./theme-init");

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * DEFAULT_ZOOM}px`);
  });

  it("defaults to dark theme when no 'theme' key is stored", async () => {
    expect(localStorage.getItem("theme")).toBeNull();

    await import("./theme-init");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * DEFAULT_ZOOM}px`);
  });

  it("defaults to dark theme when 'theme' is explicitly 'dark'", async () => {
    localStorage.setItem("theme", "dark");

    await import("./theme-init");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * DEFAULT_ZOOM}px`);
  });

  it("defaults to dark theme when 'theme' holds a corrupted/garbage value", async () => {
    localStorage.setItem("theme", "not-a-real-theme-value");

    await import("./theme-init");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * DEFAULT_ZOOM}px`);
  });

  it("defaults to dark theme when 'theme' is an empty string", async () => {
    localStorage.setItem("theme", "");

    await import("./theme-init");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * DEFAULT_ZOOM}px`);
  });

  it("applies a stored custom zoom via applyZoom(getZoom()) on import", async () => {
    localStorage.setItem("zoom", "1.5");

    await import("./theme-init");

    expect(document.documentElement.style.fontSize).toBe(`${BASE_FONT_SIZE_PX * 1.5}px`);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
