import { describe, it, expect } from "vitest";
import {
  parseVersion,
  classifyDrift,
  determineDrift,
  buildIssueBody,
  PACKAGES,
  LABEL,
} from "./pi-version-drift.mjs";

describe("parseVersion", () => {
  it("strips a caret range prefix and returns numeric components", () => {
    const parsed = parseVersion("^0.83.0");
    expect(parsed).toEqual({ major: 0, minor: 83, patch: 0 });
    expect(parsed.minor).toBe(83);
  });

  it("returns null for unparseable or non-string input", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe("classifyDrift", () => {
  it("reports major when the major component increases", () => {
    expect(classifyDrift("^0.83.0", "1.0.0")).toBe("major");
    expect(classifyDrift("^1.2.3", "3.0.0")).toBe("major");
  });

  it("reports minor when only the minor component increases", () => {
    expect(classifyDrift("^0.83.0", "0.84.0")).toBe("minor");
    expect(classifyDrift("^0.83.9", "0.84.0")).toBe("minor");
  });

  it("reports patch when only the patch component increases", () => {
    expect(classifyDrift("^0.83.0", "0.83.4")).toBe("patch");
    expect(classifyDrift("^1.0.0", "1.0.1")).toBe("patch");
  });

  it("reports none when equal or when the registry is behind", () => {
    expect(classifyDrift("^0.83.0", "0.83.0")).toBe("none");
    expect(classifyDrift("^0.84.0", "0.83.9")).toBe("none");
  });

  it("reports unknown when either side cannot be parsed", () => {
    expect(classifyDrift("workspace:*", "0.83.0")).toBe("unknown");
    expect(classifyDrift("^0.83.0", undefined)).toBe("unknown");
  });
});

describe("determineDrift", () => {
  it("does not report when every package is only a patch behind", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: "^0.83.0", latest: "0.83.1" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "0.83.2" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "0.83.0" },
    ]);
    expect(result.shouldReport).toBe(false);
    expect(result.level).toBe("patch");
  });

  it("reports at the highest drift level across the lockstep set", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: "^0.83.0", latest: "0.83.1" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "0.84.0" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "1.0.0" },
    ]);
    expect(result.shouldReport).toBe(true);
    expect(result.level).toBe("major");
    expect(result.entries.map((e) => e.drift)).toEqual(["patch", "minor", "major"]);
  });

  it("reports minor drift when a single package moved a minor line", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: "^0.83.0", latest: "0.84.0" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "0.83.0" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "0.83.0" },
    ]);
    expect(result.level).toBe("minor");
    expect(result.shouldReport).toBe(true);
  });

  it("refuses to report when any version is unparseable", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: undefined, latest: "0.90.0" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "0.90.0" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "0.90.0" },
    ]);
    expect(result.shouldReport).toBe(false);
    expect(result.level).toBe("unknown");
  });

  it("does not report when everything is current", () => {
    const result = determineDrift(
      PACKAGES.map((name) => ({ name, current: "^0.83.0", latest: "0.83.0" })),
    );
    expect(result.shouldReport).toBe(false);
    expect(result.level).toBe("none");
  });
});

describe("buildIssueBody", () => {
  it("includes every package with its declared and latest version", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: "^0.83.0", latest: "0.84.0" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "0.84.0" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "0.84.0" },
    ]);
    const body = buildIssueBody(result, "https://example.test/run/1");
    expect(body).toContain("`@earendil-works/pi-coding-agent` | `^0.83.0` | `0.84.0`");
    expect(body).toContain("Run: https://example.test/run/1");
  });

  it("omits the run link when none is provided and names the drift level", () => {
    const result = determineDrift([
      { name: PACKAGES[0], current: "^0.83.0", latest: "1.0.0" },
      { name: PACKAGES[1], current: "^0.83.0", latest: "1.0.0" },
      { name: PACKAGES[2], current: "^0.83.0", latest: "1.0.0" },
    ]);
    const body = buildIssueBody(result);
    expect(body).not.toContain("Run: ");
    expect(body).toContain("A **major** upstream release is available");
  });
});

describe("constants", () => {
  it("uses the same three lockstep packages as check-pi-lockstep", () => {
    expect(PACKAGES).toEqual([
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-coding-agent",
    ]);
    expect(LABEL).toBe("pi-version-drift");
  });
});
