import { describe, expect, it, beforeEach } from "vitest";
import { useExtensionUIStore } from "./extension-ui-store";

describe("useExtensionUIStore", () => {
  beforeEach(() => {
    useExtensionUIStore.setState({ pending: null, notification: null, dataPushes: {} });
  });

  it("routes select/confirm/input requests to pending, not dataPushes", () => {
    useExtensionUIStore.getState().handleRequest({ requestId: "1", kind: "confirm", title: "Sure?", message: "Do it?" });

    const state = useExtensionUIStore.getState();
    expect(state.pending).toMatchObject({ kind: "confirm", title: "Sure?" });
    expect(state.dataPushes).toEqual({});
  });

  it("routes notify requests to notification, not dataPushes", () => {
    useExtensionUIStore.getState().handleRequest({ requestId: "1", kind: "notify", message: "hi", level: "info" });

    const state = useExtensionUIStore.getState();
    expect(state.notification).toMatchObject({ message: "hi" });
    expect(state.dataPushes).toEqual({});
  });

  it("routes data-only pushes (set-title/set-status/set-working/set-tools-expanded/set-editor-text) into dataPushes, keyed by kind, without touching pending/notification", () => {
    useExtensionUIStore.getState().handleRequest({ requestId: "1", kind: "set-title", title: "New Title" });
    useExtensionUIStore.getState().handleRequest({ requestId: "2", kind: "set-status", key: "git", text: "main*" });

    const state = useExtensionUIStore.getState();
    expect(state.dataPushes["set-title"]).toMatchObject({ title: "New Title" });
    expect(state.dataPushes["set-status"]).toMatchObject({ key: "git", text: "main*" });
    expect(state.pending).toBeNull();
    expect(state.notification).toBeNull();
  });

  it("keeps the latest push per kind, overwriting a stale one of the same kind", () => {
    useExtensionUIStore.getState().handleRequest({ requestId: "1", kind: "set-tools-expanded", value: false });
    useExtensionUIStore.getState().handleRequest({ requestId: "2", kind: "set-tools-expanded", value: true });

    expect(useExtensionUIStore.getState().dataPushes["set-tools-expanded"]).toMatchObject({ value: true });
  });
});
