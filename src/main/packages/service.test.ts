import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PackageService } from "./service";
import { realCodingAgentLoaders } from "../agent/test-support/real-coding-agent-loaders";

/**
 * Writes a real, tiny local pi-package to disk: a `package.json` with a
 * `pi.extensions` manifest entry and a plain CommonJS extension module that
 * registers an observable, distinctively-named `pi.registerCommand` --
 * mirrors the exact manifest shape of the real bundled `read-only-tools`
 * package (`resources/pi-packages/read-only-tools/package.json`).
 */
function writeFixturePackage(dir: string, markerName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-package", version: "1.0.0", pi: { extensions: ["extension.js"] } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "extension.js"),
    `module.exports = function (pi) {
      pi.registerCommand("${markerName}", { description: "marker command" }, async () => {});
    };`,
  );
  return dir;
}

/** Real extension discovery (no trust gate involved) -- proves whether `paths` are actually loaded by pi-coding-agent's own resource loader. */
async function discoveredCommandNames(paths: string[]): Promise<string[]> {
  const { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, SettingsManager, getAgentDir } =
    await realCodingAgentLoaders.loadCodingAgent!();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-cwd-"));
  try {
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const agentDir = getAgentDir();
    const resourceLoader =
      paths.length > 0
        ? new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager: SettingsManager.create(cwd, agentDir),
            additionalExtensionPaths: paths,
          })
        : undefined;
    if (resourceLoader) await resourceLoader.reload();
    const { extensionsResult } = await createAgentSession({
      cwd,
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
      resourceLoader,
    });
    const names: string[] = [];
    for (const extension of extensionsResult.extensions) {
      for (const [name] of extension.commands) names.push(name);
    }
    return names;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("PackageService (real DefaultPackageManager + real ProjectTrustStore, throwaway disk dir)", () => {
  let agentDir: string;
  let fixtureDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-agentdir-"));
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-fixture-"));
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("installs a real local-path source, persists it desktop-owned (never touching a real ~/.pi/agent), and lists it back", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-a"), "pkg-a-marker");
    const service = new PackageService(agentDir, async () => true, realCodingAgentLoaders);

    const installed = await service.install(source);

    expect(installed.source).toBe(source);
    expect(installed.trusted).toBe(true);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    // pi's own `DefaultPackageManager` normalizes local-path sources it
    // persists (e.g. relative-to-agentDir form) -- still fully source-visible
    // per ADR §3.7, just not necessarily byte-identical to what was typed.
    expect(listed[0].trusted).toBe(true);
    expect(path.resolve(agentDir, listed[0].source)).toBe(source);

    // Desktop-owned: the settings file this wrote must be under our own
    // agentDir, not anywhere near a real global ~/.pi/agent.
    expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(true);
  });

  it("prompts for trust exactly once on first install of an undecided source, and never re-prompts on a later re-install", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-b"), "pkg-b-marker");
    let confirmCalls = 0;
    const service = new PackageService(
      agentDir,
      async () => {
        confirmCalls += 1;
        return true;
      },
      realCodingAgentLoaders,
    );

    const first = await service.install(source);
    expect(first.trusted).toBe(true);
    expect(confirmCalls).toBe(1);

    const second = await service.install(source);
    expect(second.trusted).toBe(true);
    expect(confirmCalls).toBe(1);
  });

  it("rejects an npm: source with a clear error and never installs anything", async () => {
    const service = new PackageService(agentDir, async () => true, realCodingAgentLoaders);

    await expect(service.install("npm:some-package")).rejects.toThrow(/npm:/i);
    await expect(service.list()).resolves.toEqual([]);
  });

  it("the trust gate genuinely blocks execution: an untrusted package's resolved path is withheld from trustedExtensionPaths, and its real registerCommand never loads -- once trusted, both flip", async () => {
    const markerName = "trust-gate-marker-cmd";
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-c"), markerName);
    const service = new PackageService(agentDir, async () => false, realCodingAgentLoaders);

    // 1. Install with a declined trust prompt.
    const installed = await service.install(source);
    expect(installed.trusted).toBe(false);

    // 2. Untrusted: withheld from the resolved path list AgentRuntime feeds
    //    into the real extension-discovery pipeline.
    const untrustedPaths = await service.trustedExtensionPaths();
    expect(untrustedPaths).toEqual([]);

    // 3. Proven at the real pi-coding-agent extension-loading layer (not
    //    just "the list is empty" -- the marker command genuinely never
    //    gets registered when fed an empty path list).
    const commandsWhileUntrusted = await discoveredCommandNames(untrustedPaths);
    expect(commandsWhileUntrusted).not.toContain(markerName);

    // 4. The user (or a settings UI action) later trusts the exact same
    //    real `ProjectTrustStore` entry directly -- proving this is a real,
    //    persisted, flippable decision, not a one-way gate.
    new ProjectTrustStore(agentDir).set(source, true);

    const trustedPaths = await service.trustedExtensionPaths();
    expect(trustedPaths).toEqual([source]);

    // 5. Now genuinely loads and registers the real marker command.
    const commandsWhileTrusted = await discoveredCommandNames(trustedPaths);
    expect(commandsWhileTrusted).toContain(markerName);
  });

  it("remove deletes the configured package so it no longer appears in list() or trustedExtensionPaths()", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-d"), "pkg-d-marker");
    const service = new PackageService(agentDir, async () => true, realCodingAgentLoaders);

    await service.install(source);
    expect(await service.list()).toHaveLength(1);
    expect(await service.trustedExtensionPaths()).toEqual([source]);

    await service.remove(source);

    expect(await service.list()).toEqual([]);
    expect(await service.trustedExtensionPaths()).toEqual([]);
  });
});
