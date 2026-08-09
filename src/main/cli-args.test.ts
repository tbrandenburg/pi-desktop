import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLaunchDirectoryArg } from "./cli-args";

describe("resolveLaunchDirectoryArg", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves a relative dev-mode argument against cwd", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-desktop-cli-args-"));
    const result = resolveLaunchDirectoryArg(["node", "main.js", "."], false, tmpDir);
    expect(result).toBe(tmpDir);
    expect(result).not.toBeUndefined();
  });

  it("resolves a relative packaged-mode argument against cwd (one fewer leading arg)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-desktop-cli-args-"));
    const result = resolveLaunchDirectoryArg(["pi-desktop", "."], true, tmpDir);
    expect(result).toBe(tmpDir);
    expect(result).not.toBeUndefined();
  });

  it("resolves an absolute nested subdirectory argument", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-desktop-cli-args-"));
    const result = resolveLaunchDirectoryArg(["node", "main.js", tmpDir], false, "/irrelevant");
    expect(result).toBe(tmpDir);
    expect(result).not.toBe("/irrelevant");
  });

  it("returns undefined and warns when no argument is given", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveLaunchDirectoryArg(["node", "main.js"], false, "/some/cwd");
    expect(result).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns undefined and warns when the argument does not exist on disk", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveLaunchDirectoryArg(["node", "main.js", "/definitely/does/not/exist/pi-164"], false, "/");
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and warns when the argument resolves to a file, not a directory", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-desktop-cli-args-"));
    const filePath = join(tmpDir, "not-a-dir.txt");
    writeFileSync(filePath, "x");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveLaunchDirectoryArg(["node", "main.js", filePath], false, "/irrelevant");
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
