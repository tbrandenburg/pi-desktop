import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { PackageInfo } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders } from "../agent/coding-agent-loaders";

/**
 * A minimal, dedicated exact-match key/value trust store for
 * package-source-keyed decisions (issue #104). `ProjectTrustStore` (pi's
 * own trust primitive) is deliberately NOT reused here: its
 * `normalizeCwd`/`findNearestTrustEntry` treat every key as a filesystem
 * path and walk up parent directories looking for the nearest decision --
 * empirically confirmed to silently inherit `trusted=true` for a
 * local-path package nested under an already-trusted project directory,
 * and to silently resolve non-path source strings (`git:...`, `npm:...`)
 * relative to `process.cwd()`, producing unstable keys. This store treats
 * every key as fully opaque: no ancestor walk, no path resolution.
 *
 * Locking: deliberately NOT using `proper-lockfile` here (unlike
 * `SettingsManager`/`ProjectTrustStore`, which guard against a real
 * concurrent CLI writer). This file is single-writer: only this desktop
 * app's own Electron main process ever reads/writes it -- the real `pi`
 * CLI/TUI has no concept of a "package-source trust" file and never
 * touches it. Adding a lock here would be an unjustified reinvented wheel
 * for a concurrency scenario that does not exist.
 */
export class PackageTrustStore {
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = path.join(agentDir, "pi-desktop-package-trust.json");
  }

  private read(): Record<string, boolean> {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, boolean>;
      return {};
    } catch {
      return {};
    }
  }

  get(key: string): boolean | null {
    const data = this.read();
    return key in data ? data[key] : null;
  }

  set(key: string, decision: boolean): void {
    const data = this.read();
    data[key] = decision;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}

/** Candidate package-manager binaries `DefaultPackageManager` may shell out to for an `npm:` source (default "npm", overridable via settings' `npmCommand`). */
const NPM_CAPABLE_BINARIES = ["npm", "bun", "pnpm"];

function isBinaryAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [command] : ["-v", command];
  const result = spawnSync(probe, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}

function anyNpmCapableBinaryAvailable(): boolean {
  return NPM_CAPABLE_BINARIES.some(isBinaryAvailable);
}

/**
 * Owns runtime pi-package install/remove/list/update (ADR 0001 §3.6/§3.7,
 * issues #92/#104). Wraps pi's own `DefaultPackageManager`, scoped to the
 * real, shared `~/.pi/agent` directory (`getAgentDir()`, honoring
 * `$PI_CODING_AGENT_DIR`) -- the exact same directory models/sessions
 * already use, so a package installed via pi-desktop or the real `pi`
 * CLI/TUI is immediately visible to the other, with no import/migration
 * step. `cwd` is kept equal to `agentDir` (not the real workspace
 * directory): every call here is hardcoded `scope: "user"`, and `cwd` only
 * affects project-scope resolution, which nothing here exercises -- see
 * issue #104 for the full reasoning against wiring in the workspace cwd.
 *
 * The mandatory trust gate (ADR 0001 §3.7, non-negotiable per issue #92) is
 * a dedicated `PackageTrustStore` (see above), NOT `ProjectTrustStore`
 * reused -- reusing it directly was found to be an empirically unsafe
 * shortcut (silent trust-by-inheritance for nested local paths, unstable
 * keys for non-path sources), so this is the smallest amount of new glue
 * code needed to keep the "ask once, persist the binary decision" model
 * without that bug.
 *
 * The gate is enforced by omission, not by any capability sandbox: a
 * package's resolved on-disk path is only ever included in
 * `trustedExtensionPaths()` (consumed by `AgentRuntime` as an
 * `additionalExtensionPath`) once `trustStore.get(source) === true`. An
 * untrusted/undecided package is fully installed and listed (source is
 * always visible, per ADR §3.7), but its extension code is never fed into
 * the resource-loader/extension-discovery pipeline, so it never runs.
 */
export class PackageService {
  constructor(
    /** Real, mandatory post-install consent prompt -- routed through the same `ExtensionUIContext` IPC bridge (#91) used for extension `ctx.ui.confirm` calls, never a second parallel modal mechanism. */
    private readonly confirmTrust: (source: string) => Promise<boolean>,
    /**
     * Real, mandatory pre-install consent prompt shown only for `npm:`
     * sources, before `installAndPersist()` runs -- npm lifecycle scripts
     * (`postinstall`/`prepare`) execute immediately on install, before any
     * review is possible, a materially different risk than a git/local-path
     * source. Uses the same `confirmTrust`-shaped callback mechanism, just
     * with a distinct, npm-specific warning message.
     */
    private readonly confirmNpmInstall: (source: string) => Promise<boolean>,
    private readonly loaders: CodingAgentLoaders = {},
  ) {}

  private async build() {
    const { DefaultPackageManager, SettingsManager, getAgentDir } = await loadCodingAgent(this.loaders);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(agentDir, agentDir);
    const packageManager = new DefaultPackageManager({
      cwd: agentDir,
      agentDir,
      settingsManager,
    });
    const trustStore = new PackageTrustStore(agentDir);
    return { packageManager, trustStore };
  }

  async list(): Promise<PackageInfo[]> {
    const { packageManager, trustStore } = await this.build();
    return packageManager.listConfiguredPackages().map((pkg) => ({
      source: pkg.source,
      trusted: trustStore.get(this.canonicalTrustKey(packageManager, pkg.source)) === true,
    }));
  }

  /**
   * Installs a local-path, git, or `npm:` source, then blocks until a real
   * trust decision exists for it (prompting only when none is already
   * recorded -- matching pi's own "ask once, persist the binary decision"
   * model). For `npm:` sources, an additional pre-install confirm is
   * required first (see `confirmNpmInstall`'s doc comment): npm lifecycle
   * scripts run immediately on install, before any review, so declining
   * this prompt must install nothing.
   */
  async install(source: string): Promise<PackageInfo> {
    const trimmed = source.trim();
    const isNpmSource = trimmed.toLowerCase().startsWith("npm:");

    if (isNpmSource) {
      if (!anyNpmCapableBinaryAvailable()) {
        throw new Error(
          "No npm-capable package manager (npm, bun, or pnpm) was found on this system's PATH -- npm: sources cannot be installed.",
        );
      }
      const proceed = await this.confirmNpmInstall(trimmed);
      if (!proceed) {
        throw new Error(`Installation of "${trimmed}" was declined before running its npm lifecycle scripts.`);
      }
    }

    const { packageManager, trustStore } = await this.build();
    await packageManager.installAndPersist(trimmed);
    const key = this.canonicalTrustKey(packageManager, trimmed);

    // Only prompt when the source has never been decided (`null`) --
    // matching pi's own "ask once, persist the binary decision" model. A
    // previously-recorded `false` stays untrusted without re-prompting on
    // every install/re-install call; a previously-recorded `true` skips
    // straight to being usable.
    let trusted = trustStore.get(key);
    if (trusted === null) {
      const decision = await this.confirmTrust(trimmed);
      trustStore.set(key, decision);
      trusted = decision;
    }

    return { source: trimmed, trusted: trusted === true };
  }

  async remove(source: string): Promise<void> {
    const { packageManager } = await this.build();
    await packageManager.removeAndPersist(source);
  }

  async update(source: string): Promise<void> {
    const { packageManager } = await this.build();
    await packageManager.update(source);
  }

  /**
   * Resolved, on-disk directory paths of every *trusted* configured
   * package -- fed to `AgentRuntime` as `additionalExtensionPaths` so an
   * untrusted package's code is never loaded into a running chat session.
   * `getInstalledPath(source, "user")` (not `resolveExtensionSources`) is
   * used deliberately: it returns the literal already-resolved filesystem
   * directory (works identically for local-path, git, and npm sources), so
   * the *session's own* resource loader/package-manager instance (scoped to
   * the real `~/.pi/agent`, same `agentDir` as ours) can treat it as a
   * plain local path.
   */
  async trustedExtensionPaths(): Promise<string[]> {
    const { packageManager, trustStore } = await this.build();
    const configured = packageManager.listConfiguredPackages();
    const resolved: string[] = [];
    for (const pkg of configured) {
      const installedPath = packageManager.getInstalledPath(pkg.source, "user");
      if (!installedPath) continue;
      if (trustStore.get(this.canonicalTrustKey(packageManager, pkg.source)) !== true) continue;
      resolved.push(path.resolve(installedPath));
    }
    return resolved;
  }

  /**
   * `DefaultPackageManager.addSourceToSettings` normalizes local-path
   * sources it persists (e.g. relative-to-`agentDir` form) -- see
   * `package-manager.js`'s `normalizePackageSourceForSettings`. Re-resolving
   * through `getInstalledPath` (which reparses whatever string form it's
   * given) yields a single, stable, canonical absolute-path key so trust
   * decisions recorded at install time (keyed off the raw user input) are
   * always found again later when read back via `listConfiguredPackages()`
   * (keyed off the persisted, possibly-normalized form).
   */
  private canonicalTrustKey(
    packageManager: Awaited<ReturnType<PackageService["build"]>>["packageManager"],
    source: string,
  ): string {
    return packageManager.getInstalledPath(source, "user") ?? source;
  }
}
