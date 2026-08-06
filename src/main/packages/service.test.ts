import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PackageService, PackageTrustStore } from "./service";
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

/**
 * Real extension discovery (no trust gate involved) -- proves whether
 * `paths` are actually loaded by pi-coding-agent's own resource loader.
 * Uses its own throwaway `agentDir`/`cwd`, deliberately decoupled from
 * `PackageService`'s real shared `getAgentDir()` directory: this isolates
 * "does `additionalExtensionPaths` alone make a path load" from
 * `DefaultResourceLoader.resolve()`'s *separate*, unconditional loading of
 * every package already configured in `settings.json` -- which is a real,
 * distinct behavior from the trust-gated `additionalExtensionPaths` list,
 * and would otherwise make this helper load the fixture package
 * unconditionally once it's persisted to the same shared agentDir,
 * independent of the trust decision under test (see handoff notes for the
 * broader implication).
 */
async function discoveredCommandNames(paths: string[]): Promise<string[]> {
  const { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, SettingsManager } =
    await realCodingAgentLoaders.loadCodingAgent!();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-cwd-"));
  const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-discover-agentdir-"));
  try {
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    // Always construct an explicit resourceLoader (even for an empty
    // `paths` list): `createAgentSession` falls back to its own internal
    // default loader when none is passed, which resolves `getAgentDir()`
    // from `$PI_CODING_AGENT_DIR` -- the *same* shared agentDir the outer
    // test suite points `PackageService` at. Omitting this would silently
    // load the fixture package straight out of that shared `settings.json`,
    // unconditionally, regardless of the trust decision under test.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: isolatedAgentDir,
      settingsManager: SettingsManager.create(cwd, isolatedAgentDir),
      additionalExtensionPaths: paths,
    });
    await resourceLoader.reload();
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
    fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
  }
}

/**
 * Writes a fake, no-op `npm` executable (`exit 0`, no network, no real
 * package resolution) onto a throwaway `PATH` prefix directory, so tests
 * can exercise `PackageService.install()`'s real npm-source code path
 * (binary-availability check, pre-install confirm, `installAndPersist()`
 * actually invoking `DefaultPackageManager`'s real npm-install machinery)
 * without a real registry round-trip. `installNpm`/`ensureNpmProject` only
 * need the child process to exit 0 -- they don't inspect npm's own stdout.
 */
function writeFakeNpmOnPath(): { binDir: string; originalPath: string | undefined } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-fakebin-"));
  const npmPath = path.join(binDir, "npm");
  fs.writeFileSync(npmPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(npmPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return { binDir, originalPath };
}

describe("PackageService (real DefaultPackageManager + real shared agentDir, throwaway disk dir)", () => {
  let agentDir: string;
  let fixtureDir: string;
  let originalPiAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-agentdir-"));
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-fixture-"));
    originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  function makeService(
    confirmTrust: (source: string) => Promise<boolean> = async () => true,
    confirmNpmInstall: (source: string) => Promise<boolean> = async () => true,
  ): PackageService {
    return new PackageService(confirmTrust, confirmNpmInstall, realCodingAgentLoaders);
  }

  it("installs a real local-path source into the real shared agentDir (getAgentDir()), and lists it back", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-a"), "pkg-a-marker");
    const service = makeService();

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

    // Real shared agentDir: the settings file this wrote must be under
    // `getAgentDir()`'s resolved directory (here, $PI_CODING_AGENT_DIR),
    // exactly the same directory sessions/models already use.
    expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(true);
  });

  it("prompts for trust exactly once on first install of an undecided source, and never re-prompts on a later re-install", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-b"), "pkg-b-marker");
    let confirmCalls = 0;
    const service = makeService(async () => {
      confirmCalls += 1;
      return true;
    });

    const first = await service.install(source);
    expect(first.trusted).toBe(true);
    expect(confirmCalls).toBe(1);

    const second = await service.install(source);
    expect(second.trusted).toBe(true);
    expect(confirmCalls).toBe(1);
  });

  describe("npm: source support", () => {
    let fakeBin: { binDir: string; originalPath: string | undefined } | undefined;

    afterEach(() => {
      if (fakeBin) {
        if (fakeBin.originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = fakeBin.originalPath;
        fs.rmSync(fakeBin.binDir, { recursive: true, force: true });
        fakeBin = undefined;
      }
    });

    it("declining the pre-install npm confirm never installs anything, and never reaches the trust prompt", async () => {
      fakeBin = writeFakeNpmOnPath();
      let trustConfirmCalls = 0;
      const service = makeService(
        async () => {
          trustConfirmCalls += 1;
          return true;
        },
        async () => false,
      );

      await expect(service.install("npm:some-package")).rejects.toThrow(/declined/i);
      expect(trustConfirmCalls).toBe(0);
      await expect(service.list()).resolves.toEqual([]);
    });

    it("accepting the pre-install npm confirm proceeds to a real install attempt via DefaultPackageManager, then the post-install trust gate", async () => {
      fakeBin = writeFakeNpmOnPath();
      let npmConfirmCalls = 0;
      let trustConfirmCalls = 0;
      const service = makeService(
        async () => {
          trustConfirmCalls += 1;
          return true;
        },
        async () => {
          npmConfirmCalls += 1;
          return true;
        },
      );

      const installed = await service.install("npm:fixture-npm-package");

      expect(npmConfirmCalls).toBe(1);
      expect(trustConfirmCalls).toBe(1);
      expect(installed.source).toBe("npm:fixture-npm-package");
      expect(installed.trusted).toBe(true);

      const listed = await service.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].source).toBe("npm:fixture-npm-package");
    });

    it("fails with a clear error, without prompting, when no npm-capable binary is reachable on PATH", async () => {
      const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-emptybin-"));
      const originalPath = process.env.PATH;
      process.env.PATH = emptyBinDir;
      try {
        let npmConfirmCalls = 0;
        const service = makeService(async () => true, async () => {
          npmConfirmCalls += 1;
          return true;
        });

        await expect(service.install("npm:some-package")).rejects.toThrow(/no npm-capable package manager/i);
        expect(npmConfirmCalls).toBe(0);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        fs.rmSync(emptyBinDir, { recursive: true, force: true });
      }
    });
  });

  it("the trust gate genuinely blocks execution: an untrusted package's resolved path is withheld from trustedExtensionPaths, and its real registerCommand never loads -- once trusted, both flip", async () => {
    const markerName = "trust-gate-marker-cmd";
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-c"), markerName);
    const service = makeService(async () => false);

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
    //    real trust-store entry directly -- proving this is a real,
    //    persisted, flippable decision, not a one-way gate. Uses the same
    //    canonical key `PackageService` itself resolves for a local-path
    //    source with no on-disk normalization (its own absolute path).
    new PackageTrustStore(agentDir).set(source, true);

    const trustedPaths = await service.trustedExtensionPaths();
    expect(trustedPaths).toEqual([source]);

    // 5. Now genuinely loads and registers the real marker command.
    const commandsWhileTrusted = await discoveredCommandNames(trustedPaths);
    expect(commandsWhileTrusted).toContain(markerName);
  });

  it("remove deletes the configured package so it no longer appears in list() or trustedExtensionPaths()", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-d"), "pkg-d-marker");
    const service = makeService();

    await service.install(source);
    expect(await service.list()).toHaveLength(1);
    expect(await service.trustedExtensionPaths()).toEqual([source]);

    await service.remove(source);

    expect(await service.list()).toEqual([]);
    expect(await service.trustedExtensionPaths()).toEqual([]);
  });
});
