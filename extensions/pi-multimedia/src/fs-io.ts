/**
 * Minimal filesystem access for reading a local audio file into base64.
 *
 * The shared extension tsconfig deliberately omits Node type definitions
 * (see pi-llm7's ambient `process` declaration), so this module declares
 * only the exact Node `fs`/`path` surface it needs instead of depending on
 * `@types/node`.
 */

declare function require(id: string): unknown;

interface MinimalFs {
  readFileSync(path: string): { toString(encoding: string): string };
}

function loadFs(): MinimalFs {
  return require("fs") as MinimalFs;
}

/** Reads a local file and returns its contents as a base64 string. */
export function readFileAsBase64(filePath: string): string {
  const fs = loadFs();
  return fs.readFileSync(filePath).toString("base64");
}
