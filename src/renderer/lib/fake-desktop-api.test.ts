// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartChatRequest } from "../../shared/events";
import { createFakeDesktopApi } from "./fake-desktop-api";

/** Sets the URL query string via history.pushState, without a full navigation. */
function setSearch(search: string) {
  const url = new URL(window.location.href);
  url.search = search;
  window.history.pushState(null, "", url.toString());
}

afterEach(() => {
  setSearch("");
  vi.useRealTimers();
});

describe("createFakeDesktopApi", () => {
  describe("listModels", () => {
    it("returns the fixed 10-entry catalog by default", async () => {
      const api = createFakeDesktopApi();

      const models = await api.listModels();

      expect(models).toHaveLength(10);
      expect(models.map((m) => m.id)).toEqual([
        "fake-mini",
        "fake-pro",
        "fake-flaky",
        "fake-reachable",
        "fake-auth-failed",
        "fake-unreachable",
        "fake-unconfigured",
        "fake-free",
        "fake-oauth",
        "fake-auth-error",
      ]);
    });

    it("covers every credentialState/reachability/verified combination", async () => {
      const api = createFakeDesktopApi();

      const models = await api.listModels();
      const byId = Object.fromEntries(models.map((m) => [m.id, m]));

      expect(byId["fake-mini"]).toMatchObject({
        label: "Fake Mini (browser test)",
        providerId: "fake",
        configured: true,
        credentialState: "configured",
        contextWindow: 128000,
      });
      expect(byId["fake-pro"]).toMatchObject({
        label: "Fake Pro (browser test)",
        providerId: "fake",
        configured: true,
        credentialState: "configured",
        verified: { lastResult: "ok" },
        contextWindow: 1000000,
      });
      expect(byId["fake-flaky"]).toMatchObject({
        label: "Fake Flaky (verified error)",
        providerId: "fake-flaky",
        configured: true,
        credentialState: "configured",
        reachability: "reachable",
        verified: { lastResult: "error" },
      });
      expect(byId["fake-reachable"]).toMatchObject({
        label: "Fake Reachable (browser test)",
        providerId: "fake-reachable",
        configured: true,
        credentialState: "configured",
        reachability: "reachable",
      });
      expect(byId["fake-auth-failed"]).toMatchObject({
        label: "Fake Needs Re-auth (browser test)",
        providerId: "fake-auth-failed",
        configured: true,
        credentialState: "configured",
        reachability: "auth-failed",
      });
      expect(byId["fake-unreachable"]).toMatchObject({
        label: "Fake Unreachable (browser test)",
        providerId: "fake-unreachable",
        configured: true,
        credentialState: "configured",
        reachability: "unreachable",
      });
      expect(byId["fake-unconfigured"]).toMatchObject({
        label: "Fake Unconfigured (browser test)",
        providerId: "fake-unconfigured",
        configured: false,
        credentialState: "missing",
      });
      expect(byId["fake-free"]).toMatchObject({
        label: "Fake Free (no key required)",
        providerId: "fake-free",
        configured: true,
        credentialState: "free",
      });
      expect(byId["fake-oauth"]).toMatchObject({
        label: "Fake OAuth (browser test)",
        providerId: "fake-oauth",
        configured: true,
        credentialState: "oauth",
      });
      expect(byId["fake-auth-error"]).toMatchObject({
        label: "Fake Auth Error (browser test)",
        providerId: "fake-auth-error",
        configured: false,
        credentialState: "auth-error",
      });
    });

    it("returns an empty array when ?fakeModels=empty", async () => {
      setSearch("?fakeModels=empty");
      const api = createFakeDesktopApi();

      const models = await api.listModels();

      expect(models).toEqual([]);
      expect(models).toHaveLength(0);
    });

    it("ignores unrelated fakeModels values", async () => {
      setSearch("?fakeModels=something-else");
      const api = createFakeDesktopApi();

      const models = await api.listModels();

      expect(models).toHaveLength(10);
      expect(models[0]?.id).toBe("fake-mini");
    });
  });

  describe("onModelListUpdated", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("fires once with a single-entry partial list after 5ms", () => {
      const api = createFakeDesktopApi();
      const callback = vi.fn();

      api.onModelListUpdated(callback);
      vi.advanceTimersByTime(5);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith([
        {
          id: "fake-mini",
          label: "Fake Mini (browser test)",
          providerId: "fake",
          configured: true,
          credentialState: "configured",
        },
      ]);
    });

    it("never fires when ?fakeModels=empty", () => {
      setSearch("?fakeModels=empty");
      const api = createFakeDesktopApi();
      const callback = vi.fn();

      api.onModelListUpdated(callback);
      vi.advanceTimersByTime(1000);

      expect(callback).not.toHaveBeenCalled();
    });

    it("does not fire after unsubscribing before the timeout", () => {
      const api = createFakeDesktopApi();
      const callback = vi.fn();

      const unsubscribe = api.onModelListUpdated(callback);
      unsubscribe();
      vi.advanceTimersByTime(5);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("startChat / onChatEvent", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    function request(overrides: Partial<StartChatRequest> = {}): StartChatRequest {
      return {
        conversationId: "conv-1",
        model: "fake-mini",
        messages: [{ role: "user", content: "hello world" }],
        ...overrides,
      };
    }

    it("returns a synchronous requestId immediately", async () => {
      const api = createFakeDesktopApi();

      const result = await api.startChat(request());

      expect(typeof result.requestId).toBe("string");
      expect(result.requestId.length).toBeGreaterThan(0);
    });

    it("streams started -> text-delta(s) -> completed events to the registered listener", async () => {
      const api = createFakeDesktopApi();
      const events: unknown[] = [];
      api.onChatEvent((event) => events.push(event));

      const { requestId } = await api.startChat(request());
      await vi.runAllTimersAsync();

      expect(events[0]).toEqual({ type: "started", requestId });
      expect(events.at(-1)).toEqual({ type: "completed", requestId });
      const deltas = events.filter(
        (e): e is { type: string; text: string } => (e as { type: string }).type === "text-delta",
      );
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.map((d) => d.text).join("")).toBe("Echo (fake-mini): hello world ");
    });

    it("persists a session keyed by conversationId with the echoed reply", async () => {
      const api = createFakeDesktopApi();
      api.onChatEvent(() => {});

      await api.startChat(request({ conversationId: "conv-persist" }));
      await vi.runAllTimersAsync();

      const session = await api.getSession("conv-persist");

      expect(session).not.toBeNull();
      expect(session?.model).toBe("fake-mini");
      expect(session?.messages.at(-1)).toEqual({
        role: "assistant",
        content: "Echo (fake-mini): hello world",
      });
    });

    it("titles the session from the first user message, truncated to 60 chars", async () => {
      const api = createFakeDesktopApi();
      const longMessage = "x".repeat(100);

      await api.startChat(
        request({
          conversationId: "conv-long",
          messages: [{ role: "user", content: longMessage }],
        }),
      );
      await vi.runAllTimersAsync();

      const session = await api.getSession("conv-long");

      expect(session?.title).toBe(longMessage.slice(0, 60));
      expect(session?.title.length).toBe(60);
    });

    it("titles the session 'New chat' when there is no user message", async () => {
      const api = createFakeDesktopApi();

      await api.startChat(
        request({
          conversationId: "conv-no-user",
          messages: [{ role: "system", content: "be nice" }],
        }),
      );
      await vi.runAllTimersAsync();

      const session = await api.getSession("conv-no-user");

      expect(session?.title).toBe("New chat");
      expect(session?.messages.some((m) => m.role === "system")).toBe(true);
    });

    it("unsubscribing onChatEvent stops future delivery", async () => {
      const api = createFakeDesktopApi();
      const events: unknown[] = [];
      const unsubscribe = api.onChatEvent((event) => events.push(event));
      unsubscribe();

      await api.startChat(request());
      await vi.runAllTimersAsync();

      expect(events).toEqual([]);
      expect(events).toHaveLength(0);
    });

    it("handles a request with no messages without throwing (empty echoed content)", async () => {
      const api = createFakeDesktopApi();
      const events: unknown[] = [];
      api.onChatEvent((event) => events.push(event));

      await api.startChat(request({ conversationId: "conv-empty", messages: [] }));
      await vi.runAllTimersAsync();

      const session = await api.getSession("conv-empty");
      expect(session?.title).toBe("New chat");
      expect(session?.messages.at(-1)).toEqual({ role: "assistant", content: "Echo (fake-mini):" });
    });
  });

  describe("cancelChat / saveProviderSettings", () => {
    it("cancelChat resolves to undefined without throwing", async () => {
      const api = createFakeDesktopApi();

      const result = await api.cancelChat("some-request-id");

      expect(result).toBeUndefined();
      await expect(api.cancelChat("another-id")).resolves.toBeUndefined();
    });

    it("saveProviderSettings resolves to undefined without throwing", async () => {
      const api = createFakeDesktopApi();

      const result = await api.saveProviderSettings({ baseUrl: "https://x", model: "m" });

      expect(result).toBeUndefined();
      await expect(api.saveProviderSettings({ baseUrl: "https://y", model: "n" })).resolves.toBeUndefined();
    });
  });

  describe("getProviderSettings", () => {
    it("returns the fixed canned settings", async () => {
      const api = createFakeDesktopApi();

      const settings = await api.getProviderSettings();

      expect(settings.baseUrl).toBe("https://fake.local/v1");
      expect(settings.model).toBe("fake-mini");
      expect(settings.hasApiKey).toBe(true);
    });
  });

  describe("listSessions / getSession / deleteSession", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    async function seedSession(api: ReturnType<typeof createFakeDesktopApi>, conversationId: string, content: string) {
      api.onChatEvent(() => {});
      await api.startChat({ conversationId, model: "fake-mini", messages: [{ role: "user", content }] });
      await vi.runAllTimersAsync();
    }

    it("lists sessions sorted by updatedAt descending without messages", async () => {
      const api = createFakeDesktopApi();
      await seedSession(api, "older", "first message");
      vi.setSystemTime(Date.now() + 1000);
      await seedSession(api, "newer", "second message");

      const sessions = await api.listSessions();

      expect(sessions.map((s) => s.id)).toEqual(["newer", "older"]);
      expect(sessions.every((s) => !("messages" in s))).toBe(true);
    });

    it("getSession returns the full record for a known id and null for unknown", async () => {
      const api = createFakeDesktopApi();
      await seedSession(api, "known", "hi there");

      const known = await api.getSession("known");
      const unknown = await api.getSession("does-not-exist");

      expect(known?.messages).toBeDefined();
      expect(known?.id).toBe("known");
      expect(unknown).toBeNull();
    });

    it("deleteSession removes an existing session", async () => {
      const api = createFakeDesktopApi();
      await seedSession(api, "to-delete", "bye");

      await api.deleteSession("to-delete");

      expect(await api.getSession("to-delete")).toBeNull();
      expect(await api.listSessions()).toEqual([]);
    });

    it("deleteSession on an unknown id does not throw", async () => {
      const api = createFakeDesktopApi();

      await expect(api.deleteSession("never-existed")).resolves.toBeUndefined();
      expect(await api.listSessions()).toEqual([]);
    });
  });

  describe("getWorkspace / chooseWorkspace", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("getWorkspace returns the initial fake-user dir", async () => {
      const api = createFakeDesktopApi();

      const workspace = await api.getWorkspace();

      expect(workspace.dir).toBe("/home/fake-user");
      expect(typeof workspace.dir).toBe("string");
    });

    it("chooseWorkspace alternates between two fixed dirs across calls", async () => {
      const api = createFakeDesktopApi();

      const first = await api.chooseWorkspace();
      const second = await api.chooseWorkspace();
      const third = await api.chooseWorkspace();

      expect(first?.dir).toBe("/home/fake-user/other-workspace");
      expect(second?.dir).toBe("/home/fake-user");
      expect(third?.dir).toBe("/home/fake-user/other-workspace");
    });

    it("chooseWorkspace clears existing sessions", async () => {
      const api = createFakeDesktopApi();
      api.onChatEvent(() => {});
      await api.startChat({ conversationId: "conv-a", model: "fake-mini", messages: [{ role: "user", content: "hi" }] });
      await vi.runAllTimersAsync();
      expect(await api.getSession("conv-a")).not.toBeNull();

      await api.chooseWorkspace();

      expect(await api.getSession("conv-a")).toBeNull();
      expect(await api.listSessions()).toEqual([]);
    });
  });

  describe("getVersion", () => {
    it("returns the fixed dev version literal", async () => {
      const api = createFakeDesktopApi();

      const version = await api.getVersion();

      expect(version).toBe("0.0.0-dev");
      expect(typeof version).toBe("string");
    });
  });

  describe("listCommands / queryAutocomplete / listShortcuts", () => {
    it("all return an empty array, not null/undefined", async () => {
      const api = createFakeDesktopApi();

      const commands = await api.listCommands();
      const autocomplete = await api.queryAutocomplete("query");
      const shortcuts = await api.listShortcuts();

      expect(commands).toEqual([]);
      expect(Array.isArray(commands)).toBe(true);
      expect(autocomplete).toEqual([]);
      expect(Array.isArray(autocomplete)).toBe(true);
      expect(shortcuts).toEqual([]);
      expect(Array.isArray(shortcuts)).toBe(true);
    });
  });

  describe("onExtensionUIRequest / respondExtensionUI", () => {
    it("onExtensionUIRequest returns a no-op unsubscribe that does not throw", () => {
      const api = createFakeDesktopApi();

      const unsubscribe = api.onExtensionUIRequest(() => {});

      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    });

    it("respondExtensionUI resolves without throwing", async () => {
      const api = createFakeDesktopApi();

      const result = await api.respondExtensionUI("req-1", { kind: "confirm", value: true });

      expect(result).toBeUndefined();
      await expect(api.respondExtensionUI("req-2", { kind: "select", value: undefined })).resolves.toBeUndefined();
    });
  });

  describe("listPackages / installPackage / removePackage / updatePackage", () => {
    it("listPackages starts empty", async () => {
      const api = createFakeDesktopApi();

      const packages = await api.listPackages();

      expect(packages).toEqual([]);
      expect(packages).toHaveLength(0);
    });

    it("installPackage adds a new trimmed source", async () => {
      const api = createFakeDesktopApi();

      const installed = await api.installPackage("  npm:some-package  ");

      expect(installed).toEqual({ source: "npm:some-package" });
      expect(await api.listPackages()).toEqual([{ source: "npm:some-package" }]);
    });

    it("installPackage with a distinct new source appends it, not overwriting the first entry", async () => {
      const api = createFakeDesktopApi();
      await api.installPackage("npm:a");

      await api.installPackage("npm:b");

      const packages = await api.listPackages();
      expect(packages).toEqual([{ source: "npm:a" }, { source: "npm:b" }]);
      expect(packages).toHaveLength(2);
    });

    it("installPackage replaces an existing entry with the same trimmed source, not duplicating it", async () => {
      const api = createFakeDesktopApi();
      await api.installPackage("npm:dup");

      const second = await api.installPackage("  npm:dup  ");

      const packages = await api.listPackages();
      expect(second).toEqual({ source: "npm:dup" });
      expect(packages).toHaveLength(1);
      expect(packages).toEqual([{ source: "npm:dup" }]);
    });

    it("removePackage removes an existing entry by exact source match", async () => {
      const api = createFakeDesktopApi();
      await api.installPackage("npm:a");
      await api.installPackage("npm:b");

      await api.removePackage("npm:a");

      const packages = await api.listPackages();
      expect(packages).toEqual([{ source: "npm:b" }]);
      expect(packages).toHaveLength(1);
    });

    it("removePackage on a non-existent source does not throw and does not alter the list", async () => {
      const api = createFakeDesktopApi();
      await api.installPackage("npm:a");

      await expect(api.removePackage("npm:does-not-exist")).resolves.toBeUndefined();

      const packages = await api.listPackages();
      expect(packages).toEqual([{ source: "npm:a" }]);
      expect(packages).toHaveLength(1);
    });

    it("updatePackage resolves without throwing", async () => {
      const api = createFakeDesktopApi();

      await expect(api.updatePackage("npm:a")).resolves.toBeUndefined();
    });
  });

  describe("getToolsExpanded / reportToolsExpanded", () => {
    it("defaults to false and round-trips true then false", async () => {
      const api = createFakeDesktopApi();

      expect(await api.getToolsExpanded()).toBe(false);

      await api.reportToolsExpanded(true);
      expect(await api.getToolsExpanded()).toBe(true);

      await api.reportToolsExpanded(false);
      expect(await api.getToolsExpanded()).toBe(false);
    });
  });

  describe("getEditorText / reportEditorText", () => {
    it("defaults to empty string and round-trips text then back to empty", async () => {
      const api = createFakeDesktopApi();

      expect(await api.getEditorText()).toBe("");

      await api.reportEditorText("some draft text");
      expect(await api.getEditorText()).toBe("some draft text");

      await api.reportEditorText("");
      expect(await api.getEditorText()).toBe("");
    });
  });

  describe("triggerShortcut", () => {
    it("resolves without throwing", async () => {
      const api = createFakeDesktopApi();

      await expect(api.triggerShortcut("shortcut-id")).resolves.toBeUndefined();
    });
  });

  describe("saveRecording", () => {
    it("returns the fixed canned recording path", async () => {
      const api = createFakeDesktopApi();

      const result = await api.saveRecording("base64audiodata", "audio/webm");

      expect(result).toEqual({ path: "/tmp/fake-recording.webm" });
      expect(result.path).toBe("/tmp/fake-recording.webm");
    });
  });

  describe("instance isolation", () => {
    it("two separate instances do not share session state", async () => {
      vi.useFakeTimers();
      const apiA = createFakeDesktopApi();
      const apiB = createFakeDesktopApi();
      apiA.onChatEvent(() => {});
      await apiA.startChat({ conversationId: "only-in-a", model: "fake-mini", messages: [{ role: "user", content: "hi" }] });
      await vi.runAllTimersAsync();

      expect(await apiA.getSession("only-in-a")).not.toBeNull();
      expect(await apiB.getSession("only-in-a")).toBeNull();
    });
  });
});
