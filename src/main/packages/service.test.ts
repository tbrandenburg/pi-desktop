import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  function makeService(confirmInstall: (source: string) => Promise<boolean> = async () => true): PackageService {
    return new PackageService(confirmInstall, realCodingAgentLoaders);
  }

  it("installs a real local-path source into the real shared agentDir (getAgentDir()), and lists it back", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-a"), "pkg-a-marker");
    const service = makeService();

    const installed = await service.install(source);

    expect(installed.source).toBe(source);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    // pi's own `DefaultPackageManager` normalizes local-path sources it
    // persists (e.g. relative-to-agentDir form) -- still fully
    // source-visible, just not necessarily byte-identical to what was
    // typed.
    expect(path.resolve(agentDir, listed[0].source)).toBe(source);

    // Real shared agentDir: the settings file this wrote must be under
    // `getAgentDir()`'s resolved directory (here, $PI_CODING_AGENT_DIR),
    // exactly the same directory sessions/models already use.
    expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(true);
  });

  it("declining the single pre-install confirm aborts before anything is installed or written to settings.json", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-decline"), "pkg-decline-marker");
    let confirmCalls = 0;
    const service = makeService(async () => {
      confirmCalls += 1;
      return false;
    });

    await expect(service.install(source)).rejects.toThrow(/declined/i);
    expect(confirmCalls).toBe(1);

    // Nothing installed, no settings.json write.
    await expect(service.list()).resolves.toEqual([]);
    expect(fs.existsSync(path.join(agentDir, "settings.json"))).toBe(false);
  });

  it("accepting the single pre-install confirm installs normally, exactly once per install call", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-accept"), "pkg-accept-marker");
    let confirmCalls = 0;
    const service = makeService(async () => {
      confirmCalls += 1;
      return true;
    });

    const installed = await service.install(source);
    expect(installed.source).toBe(source);
    expect(confirmCalls).toBe(1);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
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

    it("declining the single install confirm never installs an npm: source", async () => {
      fakeBin = writeFakeNpmOnPath();
      const service = makeService(async () => false);

      await expect(service.install("npm:some-package")).rejects.toThrow(/declined/i);
      await expect(service.list()).resolves.toEqual([]);
    });

    it("accepting the confirm proceeds to a real install attempt via DefaultPackageManager for an npm: source", async () => {
      fakeBin = writeFakeNpmOnPath();
      let confirmCalls = 0;
      const service = makeService(async () => {
        confirmCalls += 1;
        return true;
      });

      const installed = await service.install("npm:fixture-npm-package");

      expect(confirmCalls).toBe(1);
      expect(installed.source).toBe("npm:fixture-npm-package");

      const listed = await service.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].source).toBe("npm:fixture-npm-package");
    });

    it("fails with a clear error, without prompting, when no npm-capable binary is reachable on PATH", async () => {
      const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-emptybin-"));
      const originalPath = process.env.PATH;
      process.env.PATH = emptyBinDir;
      try {
        let confirmCalls = 0;
        const service = makeService(async () => {
          confirmCalls += 1;
          return true;
        });

        await expect(service.install("npm:some-package")).rejects.toThrow(/no npm-capable package manager/i);
        expect(confirmCalls).toBe(0);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        fs.rmSync(emptyBinDir, { recursive: true, force: true });
      }
    });
  });

  it("an installed package's resource-loader path is NOT suppressed (issue #109: no more noExtensions/trust filtering) -- its real registerCommand loads via the library's own settings.json-derived resolution", async () => {
    const markerName = "issue-109-marker-cmd";
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-e"), markerName);
    const service = makeService();

    await service.install(source);

    // Exercises the real, unfiltered `DefaultResourceLoader` default
    // resolution (no `additionalExtensionPaths`, no `noExtensions`) against
    // the SAME shared agentDir the package was installed into -- proving
    // library-default `settings.json`-driven extension resolution is
    // restored, not suppressed.
    const { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, SettingsManager, getAgentDir } =
      await realCodingAgentLoaders.loadCodingAgent!();
    expect(getAgentDir()).toBe(agentDir);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-pkg-109-cwd-"));
    try {
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.create(cwd, agentDir),
      });
      await resourceLoader.reload();
      const { extensionsResult } = await createAgentSession({
        cwd,
        modelRuntime,
        sessionManager: SessionManager.inMemory(cwd),
        noTools: "all",
        resourceLoader,
      });
      const commandNames: string[] = [];
      for (const extension of extensionsResult.extensions) {
        for (const [name] of extension.commands) commandNames.push(name);
      }
      expect(commandNames).toContain(markerName);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("a package installed via the real pi CLI (already in settings.json, never seen by pi-desktop's install()) lists normally with no prompt", async () => {
    // Simulates CLI parity: write directly into the shared agentDir's
    // settings.json the way `DefaultPackageManager.installAndPersist` would,
    // without ever going through `PackageService.install()`.
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-cli"), "pkg-cli-marker");
    const service = makeService(async () => {
      throw new Error("should never be prompted for an already-configured package");
    });
    const { DefaultPackageManager, SettingsManager, getAgentDir } = await realCodingAgentLoaders.loadCodingAgent!();
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const packageManager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
    await packageManager.installAndPersist(source);
    expect(getAgentDir()).toBe(agentDir);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(path.resolve(agentDir, listed[0].source)).toBe(source);
  });

  it("remove deletes the configured package so it no longer appears in list()", async () => {
    const source = writeFixturePackage(path.join(fixtureDir, "pkg-d"), "pkg-d-marker");
    const service = makeService();

    await service.install(source);
    expect(await service.list()).toHaveLength(1);

    await service.remove(source);

    expect(await service.list()).toEqual([]);
  });
});
