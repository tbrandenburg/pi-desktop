import path from "node:path";
import type { PackageInfo } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders } from "../agent/coding-agent-loaders";

/**
 * Owns runtime pi-package install/remove/list/update (ADR 0001 §3.6/§3.7,
 * issue #92) -- local-path and git sources ONLY, `npm:` sources are
 * rejected. Wraps pi's own `DefaultPackageManager`, scoped to a
 * desktop-owned directory under Electron's `userData` (never `~/.pi/agent`,
 * never next to a portable exe -- both `cwd` and `agentDir` below point at
 * the same desktop-owned directory, so every settings file, git clone, and
 * npm-tier metadata this package manager could ever write lands there).
 *
 * The mandatory trust gate (ADR 0001 §3.7, non-negotiable per issue #92) is
 * `ProjectTrustStore` reused AS-IS, keyed by the package's own source
 * string rather than a project `cwd` -- pi's own model keys trust by `cwd`
 * because its packages are always installed *for* a given project
 * directory, but pi-desktop's runtime-installed packages are desktop-wide
 * (installed once under `userData`, not per-workspace), so there is no
 * meaningful project `cwd` to key on. Applying the identical class/storage
 * format/binary-decision semantics to the package source identity instead
 * is the smallest change that preserves "reuse pi's trust primitive AS-IS,
 * no invented sandbox" while actually gating the real risk (arbitrary code
 * from an installed package), which is what matters here -- see the
 * `Notes for integrator` in the PR/handoff for the full rationale.
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
    private readonly agentDir: string,
    /** Real, mandatory consent prompt -- routed through the same `ExtensionUIContext` IPC bridge (#91) used for extension `ctx.ui.confirm` calls, never a second parallel modal mechanism. */
    private readonly confirmTrust: (source: string) => Promise<boolean>,
    private readonly loaders: CodingAgentLoaders = {},
  ) {}

  private async build() {
    const { DefaultPackageManager, ProjectTrustStore, SettingsManager } = await loadCodingAgent(this.loaders);
    const settingsManager = SettingsManager.create(this.agentDir, this.agentDir);
    const packageManager = new DefaultPackageManager({
      cwd: this.agentDir,
      agentDir: this.agentDir,
      settingsManager,
    });
    const trustStore = new ProjectTrustStore(this.agentDir);
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
   * Installs a local-path or git source, then blocks until a real trust
   * decision exists for it (prompting only when none is already recorded --
   * matching pi's own "ask once, persist the binary decision" model).
   * Throws, without installing anything, for `npm:` sources (out of scope
   * per ADR §3.6 -- local-path/git tier only in this phase).
   */
  async install(source: string): Promise<PackageInfo> {
    const trimmed = source.trim();
    if (trimmed.toLowerCase().startsWith("npm:")) {
      throw new Error(
        "npm: package sources are not supported yet -- only local-path and git sources can be installed at runtime.",
      );
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
   * directory (works identically for local-path and git sources), so the
   * *session's own* resource loader/package-manager instance (scoped to
   * `~/.pi/agent`, a different `agentDir` than ours) can treat it as a
   * plain local path without needing to know about our desktop-owned
   * `agentDir` at all.
   */
  async trustedExtensionPaths(): Promise<string[]> {
    const { packageManager, trustStore } = await this.build();
    const configured = packageManager.listConfiguredPackages();
    const resolved: string[] = [];
    for (const pkg of configured) {
      const installedPath = packageManager.getInstalledPath(pkg.source, "user");
      if (!installedPath) continue;
      if (trustStore.get(installedPath) !== true) continue;
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
