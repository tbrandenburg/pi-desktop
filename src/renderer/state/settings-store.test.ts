import { describe, it, expect, afterEach } from "vitest";
import { useSettingsStore } from "./settings-store";

describe("settings-store", () => {
  afterEach(() => {
    // Reset to the store's own documented initial state so tests never leak
    // state into each other.
    useSettingsStore.setState({ isOpen: false });
  });

  it("starts closed by default", () => {
    const state = useSettingsStore.getState();
    expect(state.isOpen).toBe(false);
    expect(typeof state.open).toBe("function");
  });

  it("open() sets isOpen to true", () => {
    useSettingsStore.getState().open();

    const state = useSettingsStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.isOpen).not.toBe(false);
  });

  it("close() sets isOpen to false", () => {
    useSettingsStore.setState({ isOpen: true });

    useSettingsStore.getState().close();

    const state = useSettingsStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.isOpen).not.toBe(true);
  });

  it("open() is idempotent when already open", () => {
    useSettingsStore.getState().open();
    useSettingsStore.getState().open();

    const state = useSettingsStore.getState();
    expect(state.isOpen).toBe(true);
  });

  it("close() is idempotent when already closed", () => {
    useSettingsStore.getState().close();
    useSettingsStore.getState().close();

    const state = useSettingsStore.getState();
    expect(state.isOpen).toBe(false);
  });
});
