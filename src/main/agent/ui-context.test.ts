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
});
