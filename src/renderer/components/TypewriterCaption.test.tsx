// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { TypewriterCaption } from "./TypewriterCaption";

const TYPE_SPEED_MS = 28;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  useExtensionUIStore.setState({ dataPushes: {} });
  vi.useRealTimers();
});

describe("TypewriterCaption", () => {
  it("shows no characters yet on initial render but includes the cursor", () => {
    const { container } = render(<TypewriterCaption label="Hello" />);

    expect(container.querySelector("span.streaming-cursor")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("reveals one character after one tick and the full label after label.length ticks", () => {
    const { container } = render(<TypewriterCaption label="Hi" />);

    act(() => {
      vi.advanceTimersByTime(TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe("H");

    act(() => {
      vi.advanceTimersByTime(TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe("Hi");
  });

  it("stops at the full label and does not overshoot when advanced further", () => {
    const label = "Hi";
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { container } = render(<TypewriterCaption label={label} />);

    act(() => {
      vi.advanceTimersByTime((label.length - 1) * TYPE_SPEED_MS);
    });
    // One tick before completion, the interval must still be pending so the
    // final character is revealed on the next tick, not skipped early.
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe(label);
    // The interval must self-clear the exact tick the label completes
    // (rather than one tick later), or it would keep running one extra cycle.
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe(label);
    // Confirm the interval actually cleared itself once the label finished
    // typing (rather than merely relying on slice() clamping), so further
    // ticks never fire at all.
    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts the animation from scratch when the label prop changes", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { container, rerender } = render(<TypewriterCaption label="ABCD" />);

    act(() => {
      vi.advanceTimersByTime(2 * TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe("AB");

    const callsBeforeRerender = clearSpy.mock.calls.length;
    act(() => {
      rerender(<TypewriterCaption label="XYZ" />);
    });
    expect(container.textContent).toBe("");
    // The still-running prior interval must be torn down before the new one
    // starts, or stale ticks would keep typing the old label alongside the
    // new one.
    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBeforeRerender);

    act(() => {
      vi.advanceTimersByTime(TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe("X");

    act(() => {
      vi.advanceTimersByTime(2 * TYPE_SPEED_MS);
    });
    expect(container.textContent).toBe("XYZ");
  });

  it("types the store push message instead of the label prop when a set-working push exists", () => {
    useExtensionUIStore.setState({
      dataPushes: {
        "set-working": { requestId: "w-1", kind: "set-working", message: "Loading" },
      },
    });
    const { container } = render(<TypewriterCaption label="fallback" />);

    act(() => {
      vi.advanceTimersByTime("Loading".length * TYPE_SPEED_MS);
    });

    expect(container.textContent).toBe("Loading");
    expect(container.textContent).not.toBe("fallback");
  });

  it("renders null when the push marks visible as false, regardless of timer advances", () => {
    useExtensionUIStore.setState({
      dataPushes: {
        "set-working": { requestId: "w-2", kind: "set-working", message: "Hidden", visible: false },
      },
    });
    const { container } = render(<TypewriterCaption label="fallback" />);

    expect(container.firstChild).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.firstChild).toBeNull();
  });

  it("clears its interval on unmount without throwing on further timer advances", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    // Use a label long enough that it never finishes typing (and thus never
    // self-clears its interval) within the small advances below, isolating
    // the cleanup function's own clearInterval call.
    const { unmount } = render(<TypewriterCaption label="a very long caption label" />);

    act(() => {
      vi.advanceTimersByTime(2 * TYPE_SPEED_MS);
    });

    const callsBeforeUnmount = clearSpy.mock.calls.length;
    expect(() => {
      act(() => {
        unmount();
        vi.advanceTimersByTime(TYPE_SPEED_MS);
      });
    }).not.toThrow();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(callsBeforeUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call clearInterval again on unmount once the interval already self-cleared", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const label = "Hi";
    const { unmount } = render(<TypewriterCaption label={label} />);

    act(() => {
      vi.advanceTimersByTime(label.length * TYPE_SPEED_MS);
    });
    // The interval already cleared itself on completion; its ref was reset
    // to null, so cleanup's own guarded clearInterval call must be skipped.
    const callsAfterCompletion = clearSpy.mock.calls.length;
    expect(callsAfterCompletion).toBeGreaterThan(0);

    act(() => {
      unmount();
    });
    expect(clearSpy.mock.calls.length).toBe(callsAfterCompletion);
  });
});
