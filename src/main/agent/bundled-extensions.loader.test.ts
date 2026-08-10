import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime";
import { realCodingAgentLoaders } from "./test-support/real-coding-agent-loaders";

/**
 * Real end-to-end discovery test for issue #192's bundling wiring: no
 * mocks, no injected `ResourceLoader` -- `AgentRuntime.listCommands` builds
 * its own real `DefaultResourceLoader` (the exact production code path)
 * against a real, throwaway `PI_CODING_AGENT_DIR` on disk, and loads real
 * on-disk pi packages.
 *
 * Deliberately does NOT inject `resourceLoader`: injecting one short-
 * circuits `buildBundledExtensionsResourceLoader` entirely, which is
 * precisely the production branch under test (see AGENTS.md's 2026-08-08
 * lesson about tests whose fixtures silently disable the branch they claim
 * to cover).
 */

let root: string;
let agentDir: string;
let cwd: string;
let bundledDir: string;
let previousAgentDirEnv: string | undefined;
let withBundled: string[];
let withoutBundled: string[];

/** Writes a real, loadable pi package whose extension registers one command. */
function writePackage(parent: string, name: string, commandName: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "dist/index.mjs", pi: { extensions: ["dist/index.mjs"] } }),
  );
  fs.writeFileSync(
    path.join(dir, "dist", "index.mjs"),
    `export default function (pi) {\n` +
      `  pi.registerCommand(${JSON.stringify(commandName)}, {\n` +
      `    description: ${JSON.stringify(`from ${name}`)},\n` +
      `    handler: async () => {},\n` +
      `  });\n` +
      `}\n`,
  );
  return dir;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-loader-"));
  agentDir = path.join(root, "agent");
  cwd = path.join(root, "workspace");
  bundledDir = path.join(root, "pi-extensions");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bundledDir, { recursive: true });

  // A first-party, bundled extension (ships inside the signed binary).
  writePackage(bundledDir, "pi-llm7", "llm7-bundled");
  // A third-party package the user configured themselves, exactly the way
  // `PackageService`/`pi install` persists one.
  const thirdParty = writePackage(path.join(root, "third-party"), "acme-ext", "acme-third-party");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [thirdParty] }));

  previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // Each `listCommands()` call spins up a full, real `AgentSession` against
  // the real `@earendil-works/pi-coding-agent` build -- by far the most
  // expensive thing in this file. Both configurations under test are
  // therefore resolved exactly ONCE here and shared by every assertion
  // below, instead of one (or two) real sessions per `it()`. That keeps the
  // suite inside `scripts/check-test-duration.sh`'s budget while testing the
  // identical production code path (the fixture is immutable and read-only
  // for all three cases, so sharing it cannot leak state between them).
  withBundled = (await new AgentRuntime(realCodingAgentLoaders, bundledEntryPaths()).listCommands(cwd)).map(
    (c) => c.name,
  );
  withoutBundled = (await new AgentRuntime(realCodingAgentLoaders, []).listCommands(cwd)).map((c) => c.name);
});

afterAll(() => {
  if (previousAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

function bundledEntryPaths(): string[] {
  return [path.join(bundledDir, "pi-llm7", "dist", "index.mjs")];
}

describe("bundled extension discovery (real DefaultResourceLoader)", () => {
  it("activates a bundled extension's commands via additionalExtensionPaths", () => {
    expect(withBundled).toContain("llm7-bundled");
    // ...and the user's own third-party package is still loaded alongside it.
    expect(withBundled).toContain("acme-third-party");
  });

  it("does NOT activate the bundled extension when no bundled paths are wired", () => {
    // This is the exact assertion that fails if the #192 wiring is reverted.
    expect(withoutBundled).not.toContain("llm7-bundled");
    // Baseline: third-party `settings.json` packages loaded before this
    // change and must load identically after it.
    expect(withoutBundled).toContain("acme-third-party");
  });

  it("leaves third-party settings.json activation byte-for-byte unchanged", () => {
    // The bundled-paths loader is a strict *superset* of the library's own
    // default: it adds first-party extensions and changes nothing else.
    // (`noExtensions: true` would break this -- it would silently disable
    // every user-configured package instead, the exact failure mode
    // AGENTS.md's #104 lesson warns about.)
    expect(withBundled.filter((n) => n !== "llm7-bundled").sort()).toEqual([...withoutBundled].sort());
    expect(withoutBundled).toContain("acme-third-party");
  });
});
