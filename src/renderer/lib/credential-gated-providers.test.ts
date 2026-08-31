import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_GATED_HINT,
  CREDENTIAL_GATED_PROVIDER_IDS,
  missingCredentialGatedProviders,
} from "./credential-gated-providers";

const ALL_GATED_IDS = [
  "kilo",
  "zenmux",
  "crofai",
  "deepinfra",
  "sambanova",
  "novita",
  "stepfun",
  "routeway",
  "tokenrouter",
  "anyapi",
  "bai",
  "openmodel",
];

describe("CREDENTIAL_GATED_PROVIDER_IDS", () => {
  it("contains exactly the 12 curated gated provider ids in order", () => {
    expect(CREDENTIAL_GATED_PROVIDER_IDS).toEqual(ALL_GATED_IDS);
    expect(CREDENTIAL_GATED_PROVIDER_IDS).toHaveLength(12);
  });
});

describe("CREDENTIAL_GATED_HINT", () => {
  it("is the exact hint string shown for a gated provider with 0 models", () => {
    expect(CREDENTIAL_GATED_HINT).toBe("requires an API key (not configured)");
    expect(CREDENTIAL_GATED_HINT.length).toBeGreaterThan(0);
  });
});

describe("missingCredentialGatedProviders", () => {
  it("returns all 12 gated ids, in source order, when no models are populated", () => {
    const result = missingCredentialGatedProviders([]);
    expect(result).toEqual(ALL_GATED_IDS);
    expect(result).toHaveLength(12);
  });

  it("excludes gated providers that have populated models, keeps the rest", () => {
    const result = missingCredentialGatedProviders(["kilo/some-model", "zenmux/other"]);
    expect(result).not.toContain("kilo");
    expect(result).not.toContain("zenmux");
    expect(result).toHaveLength(10);
    expect(result).toEqual(ALL_GATED_IDS.filter((id) => id !== "kilo" && id !== "zenmux"));
  });

  it("ignores model ids whose provider is not in the gated list", () => {
    const result = missingCredentialGatedProviders(["openai/gpt-4"]);
    expect(result).toEqual(ALL_GATED_IDS);
    expect(result).toHaveLength(12);
  });

  it("treats a model id with no slash as populated under its own full value", () => {
    // "kilo".split("/")[0] === "kilo", so a bare id still marks that provider populated.
    expect("kilo".split("/")[0]).toBe("kilo");
    const result = missingCredentialGatedProviders(["kilo"]);
    expect(result).not.toContain("kilo");
    expect(result).toHaveLength(11);
  });

  it("extracts the first segment (not the last) for ids with multiple slashes", () => {
    expect("kilo/foo/bar".split("/")[0]).toBe("kilo");
    const result = missingCredentialGatedProviders(["kilo/foo/bar"]);
    expect(result).not.toContain("kilo");
    expect(result).toHaveLength(11);
  });

  it("returns an empty array when every gated provider has a populated model", () => {
    const modelIds = ALL_GATED_IDS.map((id) => `${id}/some-model`);
    const result = missingCredentialGatedProviders(modelIds);
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });
});
