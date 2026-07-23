import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./session-store";
import type { SessionRecord } from "../../shared/events";

// Real electron-store (not mocked) writing to a throwaway directory on disk,
// proving sessions genuinely survive across app restarts (recovery), not
// just an in-memory fake.
vi.mock("electron-store", async () => {
  const actual =
    await vi.importActual<typeof import("electron-store")>("electron-store");
  return actual;
});

describe("SessionStore persistence (real electron-store)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function newStoreAt(dir: string): SessionStore {
    const store = new SessionStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).load = async function load() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((this as any).store) return (this as any).store;
      const { default: Store } = await import("electron-store");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).store = new Store({
        name: "sessions",
        cwd: dir,
        defaults: { sessions: {} },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this as any).store;
    };
    return store;
  }

  const sample: SessionRecord = {
    id: "s1",
    title: "Hello world",
    model: "gpt-4o",
    updatedAt: 1000,
    messages: [{ role: "user", content: "Hello world" }],
  };

  it("persists a session to disk and recovers it from a fresh SessionStore instance", async () => {
    const first = newStoreAt(cwd);
    await first.save(sample);

    // simulate an app restart: brand-new SessionStore instance, same disk cwd
    const second = newStoreAt(cwd);
    const recovered = await second.get("s1");
    expect(recovered).toEqual(sample);
  });

  it("lists sessions newest-first for browsing", async () => {
    const store = newStoreAt(cwd);
    await store.save(sample);
    await store.save({ ...sample, id: "s2", title: "Second", updatedAt: 2000 });

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("deletes a session so it no longer appears in list or get", async () => {
    const store = newStoreAt(cwd);
    await store.save(sample);
    await store.delete("s1");

    expect(await store.get("s1")).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
