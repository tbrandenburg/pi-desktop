// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyZoom, DEFAULT_ZOOM, getZoom, MAX_ZOOM, MIN_ZOOM, setZoom } from "./zoom";

afterEach(() => {
  localStorage.clear();
  document.documentElement.style.fontSize = "";
});

describe("getZoom", () => {
  it("returns the default zoom when no value is stored", () => {
    expect(localStorage.getItem("zoom")).toBeNull();
    expect(getZoom()).toBe(DEFAULT_ZOOM);
  });

  it("returns the default zoom when the stored value is non-numeric", () => {
    localStorage.setItem("zoom", "not-a-number");

    expect(getZoom()).toBe(DEFAULT_ZOOM);
  });

  it("returns the default zoom when the stored value is zero", () => {
    localStorage.setItem("zoom", "0");

    expect(getZoom()).toBe(DEFAULT_ZOOM);
  });

  it("returns the default zoom when the stored value is negative", () => {
    localStorage.setItem("zoom", "-1");

    expect(getZoom()).toBe(DEFAULT_ZOOM);
  });

  it("returns the stored value when it is within range", () => {
    localStorage.setItem("zoom", "1.3");

    expect(getZoom()).toBe(1.3);
  });

  it("clamps a stored value above the maximum down to the maximum", () => {
    localStorage.setItem("zoom", "5");

    expect(getZoom()).toBe(MAX_ZOOM);
  });

  it("clamps a stored value below the minimum up to the minimum", () => {
    localStorage.setItem("zoom", "0.1");

    expect(getZoom()).toBe(MIN_ZOOM);
  });

  it("does not clamp a stored value exactly at the maximum boundary", () => {
    localStorage.setItem("zoom", String(MAX_ZOOM));

    expect(getZoom()).toBe(MAX_ZOOM);
  });

  it("does not clamp a stored value exactly at the minimum boundary", () => {
    localStorage.setItem("zoom", String(MIN_ZOOM));

    expect(getZoom()).toBe(MIN_ZOOM);
  });
});

describe("applyZoom", () => {
  it("sets the document font-size to 16 times the zoom factor", () => {
    applyZoom(1.5);

    expect(document.documentElement.style.fontSize).toBe("24px");
    expect(document.documentElement.style.fontSize).not.toBe("16px");
  });

  it("sets the document font-size to the base size when zoom is 1", () => {
    applyZoom(1);

    expect(document.documentElement.style.fontSize).toBe("16px");
  });
});

describe("setZoom", () => {
  it("persists an in-range zoom value and applies its font-size", () => {
    setZoom(1.2);

    expect(localStorage.getItem("zoom")).toBe("1.2");
    expect(document.documentElement.style.fontSize).toBe("19.2px");
  });

  it("clamps a zoom above the maximum before persisting and applying it", () => {
    setZoom(10);

    expect(localStorage.getItem("zoom")).toBe(String(MAX_ZOOM));
    expect(document.documentElement.style.fontSize).toBe(`${16 * MAX_ZOOM}px`);
  });

  it("clamps a zoom below the minimum before persisting and applying it", () => {
    setZoom(0.01);

    expect(localStorage.getItem("zoom")).toBe(String(MIN_ZOOM));
    expect(document.documentElement.style.fontSize).toBe(`${16 * MIN_ZOOM}px`);
  });

  it("persists exactly the maximum boundary value without altering it", () => {
    setZoom(MAX_ZOOM);

    expect(localStorage.getItem("zoom")).toBe(String(MAX_ZOOM));
    expect(document.documentElement.style.fontSize).toBe(`${16 * MAX_ZOOM}px`);
  });

  it("persists exactly the minimum boundary value without altering it", () => {
    setZoom(MIN_ZOOM);

    expect(localStorage.getItem("zoom")).toBe(String(MIN_ZOOM));
    expect(document.documentElement.style.fontSize).toBe(`${16 * MIN_ZOOM}px`);
  });
});
