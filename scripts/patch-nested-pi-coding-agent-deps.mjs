#!/usr/bin/env node
// Directly replaces two known-vulnerable transitive dependencies nested
// under @earendil-works/pi-coding-agent's own private node_modules with
// their real, patched npm content.
//
// Why this exists (see tracking issue for full detail):
// - pi-coding-agent@0.83.0 hard-pins an exact, pre-patch `undici@8.5.0`
//   (GHSA-8xcm-r25x-g524 and 4 related high-severity advisories) as a
//   direct dependency, and its own `minimatch` resolves an unpatched
//   `brace-expansion@5.0.7` (GHSA-mh99-v99m-4gvg / GHSA-rgw5-rvv9-x895).
// - npm's own `overrides` mechanism -- the documented, correct way to force
//   a patched version onto a nested dependency -- does not materialize on
//   disk for this specific nested pair (reproducible npm 11.6.2 arborist
//   bug: package-lock.json / `npm explain` both report the override as
//   applied, but the real on-disk files under
//   node_modules/@earendil-works/pi-coding-agent/node_modules/{undici,
//   brace-expansion} remain unchanged). A root-level (non-scoped) override
//   *does* materialize, but that patches the copy jsdom resolves to
//   instead (via plain Node module resolution, since jsdom has no private
//   nested copy of its own) -- breaking jsdom's own internal
//   `jsdom-dispatcher.js`, which requires two files undici removed
//   starting at the first patched release (8.9.0), without fixing the
//   actual nested copy pi-coding-agent runs against or that `npm audit`
//   flags.
// - This script sidesteps both problems: it leaves the root-level/jsdom
//   undici resolution completely untouched (natural, safe 7.x resolution,
//   unaffected by these CVEs, no override needed), and instead fetches the
//   real patched tarballs directly from the npm registry and replaces the
//   two specific nested vulnerable copies in place -- the exact files
//   pi-coding-agent's own `require()` calls resolve to at runtime, and the
//   exact files `npm audit` reports as vulnerable.
//
// Idempotent: safe to run on every `npm install` (wired via postinstall).
// No-ops quietly if the nested package isn't present at the expected path.
// Also rewrites the two corresponding package-lock.json entries (version,
// resolved URL, integrity) to match the real patched tarball -- `npm audit`
// reads package-lock.json's recorded metadata, not actual node_modules
// content, so patching files on disk alone would leave `npm audit` still
// reporting the old vulnerable versions even though the real code is safe.
//
// See tracking issue: https://github.com/tbrandenburg/pi-desktop/issues/99
// Remove this once @earendil-works/pi-coding-agent publishes a release with
// undici/minimatch bumped past these versions (their main branch already
// has this fix as of this writing, just not yet released to npm).
import { execFileSync } from "node:child_process";

// On Windows, `npm` resolves to the `npm.cmd` shim. Node's own docs are
// explicit that spawning a `.cmd`/`.bat` file requires `shell: true` --
// naming the file as `npm.cmd` alone still throws `EINVAL`, since Windows
// itself refuses to CreateProcess a `.cmd` without a shell to interpret it
// (see https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows).
// `shell: true` normally reintroduces a shell-injection surface, but every
// call site below only ever passes hardcoded, non-user-controlled argument
// strings (fixed package specs like `undici@8.9.0`), so there is no
// injectable input here -- safe to enable only on the one platform that
// requires it.
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const npmSpawnOpts = process.platform === "win32" ? { shell: true } : {};
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const lockPath = join(repoRoot, "package-lock.json");

const patches = [
  {
    nestedPath: join(
      repoRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "undici",
    ),
    lockKey:
      "node_modules/@earendil-works/pi-coding-agent/node_modules/undici",
    name: "undici",
    version: "8.9.0",
  },
  {
    nestedPath: join(
      repoRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "brace-expansion",
    ),
    lockKey:
      "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
    name: "brace-expansion",
    version: "5.0.9",
  },
];

let lockChanged = false;
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;

for (const { nestedPath, lockKey, name, version } of patches) {
  const spec = `${name}@${version}`;
  if (!existsSync(nestedPath)) {
    console.log(`patch-nested-pi-coding-agent-deps: ${nestedPath} not found, skipping.`);
    continue;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "patch-nested-dep-"));
  try {
    execFileSync(npmBin, ["pack", spec, "--silent"], { cwd: tmpDir, stdio: "pipe", ...npmSpawnOpts });
    const tarball = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"));
    if (!tarball) {
      throw new Error(`npm pack ${spec} produced no tarball`);
    }
    execFileSync("tar", ["xzf", tarball], { cwd: tmpDir, stdio: "pipe" });

    rmSync(nestedPath, { recursive: true, force: true });
    cpSync(join(tmpDir, "package"), nestedPath, { recursive: true });
    console.log(`patch-nested-pi-coding-agent-deps: replaced ${nestedPath} with real ${spec}`);

    if (lock?.packages?.[lockKey]) {
      const dist = JSON.parse(
        execFileSync(npmBin, ["view", spec, "dist", "--json"], { encoding: "utf8", ...npmSpawnOpts }),
      );
      const entry = lock.packages[lockKey];
      if (entry.version !== version) {
        entry.version = version;
        entry.resolved = dist.tarball;
        entry.integrity = dist.integrity;
        lockChanged = true;
        console.log(`patch-nested-pi-coding-agent-deps: updated lockfile entry for ${lockKey}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (lockChanged && lock) {
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log("patch-nested-pi-coding-agent-deps: package-lock.json updated.");
}

