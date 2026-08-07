import { spawnSync } from "node:child_process";
import type { PackageInfo } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders } from "../agent/coding-agent-loaders";

/** Candidate package-manager binaries `DefaultPackageManager` may shell out to for an `npm:` source (default "npm", overridable via settings' `npmCommand`). */
const NPM_CAPABLE_BINARIES = ["npm", "bun", "pnpm"];

export function isBinaryAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { stdio: "ignore" });
  return result.status === 0;
}

function anyNpmCapableBinaryAvailable(): boolean {
  return NPM_CAPABLE_BINARIES.some(isBinaryAvailable);
}

/**
 * Owns runtime pi-package install/remove/list/update (ADR 0001 §3.6/§3.7,
 * issues #92/#104/#109). Wraps pi's own `DefaultPackageManager`, scoped to
 * the real, shared `~/.pi/agent` directory (`getAgentDir()`, honoring
 * `$PI_CODING_AGENT_DIR`) -- the exact same directory models/sessions
 * already use, so a package installed via pi-desktop or the real `pi`
 * CLI/TUI is immediately visible to the other, with no import/migration
 * step. `cwd` is kept equal to `agentDir` (not the real workspace
 * directory): every call here is hardcoded `scope: "user"`, and `cwd` only
 * affects project-scope resolution, which nothing here exercises -- see
 * issue #104 for the full reasoning against wiring in the workspace cwd.
 *
 * Issue #109: there is no persistent per-package trust gate anymore. Two
 * real bugs (#105, #106) proved that enforcing an app-invented capability
 * gate correctly requires an identical filter at every place
 * `pi-coding-agent` resolves extensions internally -- every one of those
 * call sites lives inside a library we don't control, so there was no
 * structural guarantee a third bypass didn't exist. Instead: one informed
 * consent prompt *before* anything is installed (`confirmInstall`), and
 * full transparency after (the Settings dialog's package list is exactly
 * the set of packages that load -- no hidden loaded/not-loaded state).
 * This matches upstream `pi`'s own security posture exactly (a single
 * consent gate, no capability sandbox, source-visible package list) --
 * see ADR 0001 §3.7.
 */
export class PackageService {
  constructor(
    /**
     * Real, mandatory pre-install consent prompt, shown for every source
     * type before `installAndPersist()` runs -- routed through the same
     * `ExtensionUIContext` IPC bridge (#91) used for extension
     * `ctx.ui.confirm` calls, never a second parallel modal mechanism.
     * Declining aborts before anything is installed or written to
     * `settings.json`.
     */
    private readonly confirmInstall: (source: string) => Promise<boolean>,
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
    return { packageManager };
  }

  async list(): Promise<PackageInfo[]> {
    const { packageManager } = await this.build();
    return packageManager.listConfiguredPackages().map((pkg) => ({ source: pkg.source }));
  }

  /**
   * Installs a local-path, git, or `npm:` source, after a single, real
   * consent prompt (`confirmInstall`) that must be accepted first --
   * declining it installs nothing and writes nothing to `settings.json`.
   * `npm:` sources additionally need a reachable npm-capable binary,
   * checked before prompting (a hard environment failure, not a trust
   * decision).
   */
  async install(source: string): Promise<PackageInfo> {
    const trimmed = source.trim();
    const isNpmSource = trimmed.toLowerCase().startsWith("npm:");

    if (isNpmSource && !anyNpmCapableBinaryAvailable()) {
      throw new Error(
        "No npm-capable package manager (npm, bun, or pnpm) was found on this system's PATH -- npm: sources cannot be installed.",
      );
    }

    const proceed = await this.confirmInstall(trimmed);
    if (!proceed) {
      throw new Error(`Installation of "${trimmed}" was declined.`);
    }

    const { packageManager } = await this.build();
    await packageManager.installAndPersist(trimmed);

    return { source: trimmed };
  }

  async remove(source: string): Promise<void> {
    const { packageManager } = await this.build();
    await packageManager.removeAndPersist(source);
  }

  async update(source: string): Promise<void> {
    const { packageManager } = await this.build();
    await packageManager.update(source);
  }
}
