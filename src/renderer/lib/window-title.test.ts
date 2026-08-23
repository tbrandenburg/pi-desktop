// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_TITLE,
  WINDOW_TITLE_CHANGE_EVENT,
  getStoredTitle,
  setStoredTitle,
} from "./window-title";

describe("window-title", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to the app name when nothing is stored", () => {
    expect(localStorage.getItem("windowTitle")).toBeNull();
    expect(getStoredTitle()).toBe(DEFAULT_WINDOW_TITLE);
  });

  it("persists and returns a custom title", () => {
    setStoredTitle("My Assistant");

    expect(localStorage.getItem("windowTitle")).toBe("My Assistant");
    expect(getStoredTitle()).toBe("My Assistant");
  });

  it("reverts to the default when the title is cleared", () => {
    setStoredTitle("My Assistant");
    setStoredTitle("");

    expect(localStorage.getItem("windowTitle")).toBeNull();
    expect(getStoredTitle()).toBe(DEFAULT_WINDOW_TITLE);
  });

  it("dispatches a change event so other components can react live", () => {
    let received: string | undefined;
    const listener = () => {
      received = getStoredTitle();
    };
    window.addEventListener(WINDOW_TITLE_CHANGE_EVENT, listener);

    setStoredTitle("Release Helper");

    expect(received).toBe("Release Helper");
    window.removeEventListener(WINDOW_TITLE_CHANGE_EVENT, listener);
  });
});
