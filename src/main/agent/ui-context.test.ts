import { describe, expect, it } from "vitest";
import { IpcUIContextBridge } from "./ui-context";
import type { ExtensionUIRequest } from "../../shared/events";

describe("IpcUIContextBridge", () => {
  it("select() pushes a select request and resolves with the responded value", async () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    const resultPromise = bridge.uiContext.select("Pick one", ["a", "b"]);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "select", title: "Pick one", options: ["a", "b"] });
    const requestId = pushed[0]!.requestId;

    bridge.respond(requestId, { kind: "select", value: "b" });

    await expect(resultPromise).resolves.toBe("b");
  });

  it("confirm() resolves false when the response kind mismatches (never hangs on a mismatched answer)", async () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    const resultPromise = bridge.uiContext.confirm("Sure?", "Do it?");
    const requestId = pushed[0]!.requestId;

    // A malformed/mismatched response (e.g. a stale message for a different
    // dialog kind) must resolve to the safe default, not hang forever.
    bridge.respond(requestId, { kind: "input", value: "not a confirm" });

    await expect(resultPromise).resolves.toBe(false);
    expect(pushed[0]).toMatchObject({ kind: "confirm", title: "Sure?", message: "Do it?" });
  });

  it("input() resolves with undefined when the user cancels", async () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    const resultPromise = bridge.uiContext.input("Name?", "type here");
    const requestId = pushed[0]!.requestId;
    bridge.respond(requestId, { kind: "input", value: undefined });

    await expect(resultPromise).resolves.toBeUndefined();
    expect(pushed[0]).toMatchObject({ kind: "input", title: "Name?", placeholder: "type here" });
  });

  it("notify() pushes immediately with no pending resolution required", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    bridge.uiContext.notify("Something happened", "warning");

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "notify", message: "Something happened", level: "warning" });
  });

  it("respond() on an unknown/already-resolved requestId is a silent no-op", () => {
    const bridge = new IpcUIContextBridge(() => {});
    // Must not throw for a requestId nothing is waiting on.
    expect(() => bridge.respond("does-not-exist", { kind: "confirm", value: true })).not.toThrow();
  });

  it("setTitle() pushes a set-title request (issue #137)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    bridge.uiContext.setTitle("New Title");

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "set-title", title: "New Title" });
  });

  it("setStatus() pushes a set-status request, including clearing with undefined text (issue #138)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    bridge.uiContext.setStatus("git", "main*");
    bridge.uiContext.setStatus("git", undefined);

    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({ kind: "set-status", key: "git", text: "main*" });
    expect(pushed[1]).toMatchObject({ kind: "set-status", key: "git", text: undefined });
  });

  it("working-indicator methods each push a set-working request with only their own field set (issue #138)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    bridge.uiContext.setWorkingMessage("Thinking hard…");
    bridge.uiContext.setWorkingVisible(false);
    bridge.uiContext.setHiddenThinkingLabel("Reasoning");
    bridge.uiContext.setWorkingIndicator({ frames: [] });
    bridge.uiContext.setWorkingIndicator({ frames: ["●"] });

    expect(pushed).toHaveLength(4); // setWorkingIndicator({ frames: ["●"] }) is a documented no-op (non-empty custom frames)
    expect(pushed[0]).toMatchObject({ kind: "set-working", message: "Thinking hard…" });
    expect(pushed[1]).toMatchObject({ kind: "set-working", visible: false });
    expect(pushed[2]).toMatchObject({ kind: "set-working", hiddenThinkingLabel: "Reasoning" });
    expect(pushed[3]).toMatchObject({ kind: "set-working", visible: false });
  });

  it("getToolsExpanded()/setToolsExpanded() round-trip through in-memory state and push the change (issue #139)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    expect(bridge.uiContext.getToolsExpanded()).toBe(false);

    bridge.uiContext.setToolsExpanded(true);

    expect(bridge.uiContext.getToolsExpanded()).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "set-tools-expanded", value: true });
  });

  it("reportToolsExpanded() updates getToolsExpanded() without pushing anything back to the renderer (issue #139)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    bridge.reportToolsExpanded(true);

    expect(bridge.uiContext.getToolsExpanded()).toBe(true);
    expect(pushed).toHaveLength(0);
  });

  it("getEditorText()/setEditorText()/pasteToEditor() cache the latest text and use the right push mode (issue #141)", () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    expect(bridge.uiContext.getEditorText()).toBe("");

    bridge.uiContext.setEditorText("hello");
    expect(bridge.uiContext.getEditorText()).toBe("hello");

    bridge.uiContext.pasteToEditor(" world");
    // pasteToEditor is an insert, not a cache replace -- getEditorText() only
    // reflects what the renderer reports back via reportEditorText().
    expect(bridge.uiContext.getEditorText()).toBe("hello");

    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({ kind: "set-editor-text", text: "hello", mode: "replace" });
    expect(pushed[1]).toMatchObject({ kind: "set-editor-text", text: " world", mode: "paste" });
  });

  it("reportEditorText() keeps getEditorText() accurate as the renderer's composer changes (issue #141)", () => {
    const bridge = new IpcUIContextBridge(() => {});

    bridge.reportEditorText("user typed this");

    expect(bridge.uiContext.getEditorText()).toBe("user typed this");
  });

  it("editor() reuses the input dialog and resolves with the responded value (issue #141)", async () => {
    const pushed: ExtensionUIRequest[] = [];
    const bridge = new IpcUIContextBridge((request) => pushed.push(request));

    const resultPromise = bridge.uiContext.editor("Edit me", "prefill");
    const requestId = pushed[0]!.requestId;

    expect(pushed[0]).toMatchObject({ kind: "input", title: "Edit me", placeholder: "prefill" });
    bridge.respond(requestId, { kind: "input", value: "edited text" });

    await expect(resultPromise).resolves.toBe("edited text");
  });

  it("addAutocompleteProvider()/queryAutocomplete() collects suggestions from every registered provider (issue #140)", async () => {
    const bridge = new IpcUIContextBridge(() => {});

    bridge.uiContext.addAutocompleteProvider(
      (() => ({ getSuggestions: () => [{ value: "foo" }] })) as never,
    );
    bridge.uiContext.addAutocompleteProvider(
      (() => ({ suggest: () => [{ value: "bar", description: "the bar one" }] })) as never,
    );

    const suggestions = await bridge.queryAutocomplete("f");

    expect(suggestions).toHaveLength(2);
    expect(suggestions).toContainEqual({ value: "foo" });
    expect(suggestions).toContainEqual({ value: "bar", description: "the bar one" });
  });

  it("queryAutocomplete() skips a provider that throws instead of failing every other provider (issue #140)", async () => {
    const bridge = new IpcUIContextBridge(() => {});

    bridge.uiContext.addAutocompleteProvider(
      (() => ({
        getSuggestions: () => {
          throw new Error("boom");
        },
      })) as never,
    );
    bridge.uiContext.addAutocompleteProvider(
      (() => ({ getSuggestions: () => [{ value: "safe" }] })) as never,
    );

    const suggestions = await bridge.queryAutocomplete("s");

    expect(suggestions).toEqual([{ value: "safe" }]);
  });
});
