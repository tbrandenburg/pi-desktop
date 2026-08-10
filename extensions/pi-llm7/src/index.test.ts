import { describe, expect, it } from "vitest";
import piLlm7 from "./index.js";

interface Registered {
  id: string;
  config: { apiKey: string; api: string; models: { id: string }[] };
}

function collect(): { providers: Registered[]; commands: string[] } {
  const providers: Registered[] = [];
  const commands: string[] = [];
  piLlm7({
    registerProvider: (id, config) => providers.push({ id, config }),
    registerCommand: (name) => commands.push(name),
  });
  return { providers, commands };
}

describe("piLlm7 extension factory", () => {
  it("registers the llm7-free provider with a non-empty key", () => {
    const { providers } = collect();

    expect(providers.map((p) => p.id)).toEqual(["llm7-free"]);
    expect(providers[0].config.apiKey).not.toBe("");
    expect(providers[0].config.models.map((m) => m.id)).toEqual(["default", "fast"]);
  });

  it("still registers the llm7-status signal command", () => {
    const { commands } = collect();

    expect(commands).toEqual(["llm7-status"]);
    expect(commands).toHaveLength(1);
  });
});
