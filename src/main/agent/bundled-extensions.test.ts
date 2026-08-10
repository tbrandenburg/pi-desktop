import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBundledExtensionPaths,
  resolveBundledExtensionPaths,
  resolveBundledExtensionsDir,
} from "./bundled-extensions";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-ext-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes a real on-disk pi package directory and returns its absolute path. */
function writePackage(
  parent: string,
  name: string,
  manifest: unknown,
  entryFiles: string[] = [],
): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
  for (const rel of entryFiles) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "export default function () {}\n");
  }
  return dir;
}

describe("resolveBundledExtensionsDir", () => {
  it("resolves <resourcesPath>/pi-extensions when packaged", () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, "pi-extensions"));
    const resolved = resolveBundledExtensionsDir({ isPackaged: true, resourcesPath: root });
    expect(resolved).toBe(path.join(root, "pi-extensions"));
    // The dev path must NOT be used when packaged, even if it exists.
    fs.mkdirSync(path.join(root, "extensions"));
    expect(resolveBundledExtensionsDir({ isPackaged: true, resourcesPath: root })).toBe(
      path.join(root, "pi-extensions"),
    );
  });

  it("resolves <repoRoot>/extensions in dev mode", () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, "extensions"));
    fs.mkdirSync(path.join(root, "pi-extensions"));
    const resolved = resolveBundledExtensionsDir({ isPackaged: false, repoRoot: root });
    expect(resolved).toBe(path.join(root, "extensions"));
    expect(resolved).not.toBe(path.join(root, "pi-extensions"));
  });

  it("returns undefined when the directory is missing or is a file", () => {
    const root = makeTempRoot();
    expect(resolveBundledExtensionsDir({ isPackaged: false, repoRoot: root })).toBeUndefined();
    fs.writeFileSync(path.join(root, "extensions"), "not a directory");
    expect(resolveBundledExtensionsDir({ isPackaged: false, repoRoot: root })).toBeUndefined();
    expect(resolveBundledExtensionsDir({ isPackaged: true, resourcesPath: undefined })).toBeUndefined();
  });
});

describe("listBundledExtensionPaths", () => {
  it("returns every manifest-declared entry file, absolute", () => {
    const root = makeTempRoot();
    writePackage(
      root,
      "pkg-a",
      { name: "pkg-a", pi: { extensions: ["dist/index.js", "dist/second.js"] } },
      ["dist/index.js", "dist/second.js"],
    );
    const paths = listBundledExtensionPaths(root);
    expect(paths).toEqual([
      path.join(root, "pkg-a", "dist", "index.js"),
      path.join(root, "pkg-a", "dist", "second.js"),
    ]);
    expect(paths.every((p) => path.isAbsolute(p))).toBe(true);
  });

  it("skips packages with no pi.extensions manifest and non-existent entry files", () => {
    const root = makeTempRoot();
    writePackage(root, "no-manifest", { name: "no-manifest", main: "dist/index.js" }, ["dist/index.js"]);
    // Declares an entry that was never built.
    writePackage(root, "unbuilt", { name: "unbuilt", pi: { extensions: ["dist/index.js"] } }, []);
    fs.writeFileSync(path.join(root, "loose-file.js"), "// not a package dir");
    expect(listBundledExtensionPaths(root)).toEqual([]);
  });

  it("one broken package does not prevent the others from loading", () => {
    const root = makeTempRoot();
    writePackage(root, "a-good", { name: "a-good", pi: { extensions: ["dist/index.js"] } }, ["dist/index.js"]);
    // Unparseable JSON.
    const broken = path.join(root, "b-broken");
    fs.mkdirSync(path.join(broken, "dist"), { recursive: true });
    fs.writeFileSync(path.join(broken, "package.json"), "{ this is not json");
    // No package.json at all.
    fs.mkdirSync(path.join(root, "c-empty"));
    writePackage(root, "d-good", { name: "d-good", pi: { extensions: ["dist/index.js"] } }, ["dist/index.js"]);

    const paths = listBundledExtensionPaths(root);
    expect(paths).toEqual([
      path.join(root, "a-good", "dist", "index.js"),
      path.join(root, "d-good", "dist", "index.js"),
    ]);
    expect(paths).toHaveLength(2);
  });

  it("ignores non-string manifest entries and returns [] for a missing directory", () => {
    const root = makeTempRoot();
    writePackage(root, "weird", { name: "weird", pi: { extensions: [42, "dist/index.js"] } }, ["dist/index.js"]);
    expect(listBundledExtensionPaths(root)).toEqual([path.join(root, "weird", "dist", "index.js")]);
    expect(listBundledExtensionPaths(path.join(root, "does-not-exist"))).toEqual([]);
    expect(listBundledExtensionPaths(undefined)).toEqual([]);
  });
});

describe("resolveBundledExtensionPaths", () => {
  it("composes resolution + enumeration for the packaged layout", () => {
    const root = makeTempRoot();
    const extDir = path.join(root, "pi-extensions");
    fs.mkdirSync(extDir);
    writePackage(extDir, "pi-llm7", { name: "pi-llm7", pi: { extensions: ["dist/index.js"] } }, ["dist/index.js"]);
    expect(resolveBundledExtensionPaths({ isPackaged: true, resourcesPath: root })).toEqual([
      path.join(extDir, "pi-llm7", "dist", "index.js"),
    ]);
    // Same env, dev mode: no `<root>/extensions` dir exists -> nothing.
    expect(resolveBundledExtensionPaths({ isPackaged: false, repoRoot: root })).toEqual([]);
  });
});
