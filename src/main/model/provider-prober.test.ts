import { beforeEach, describe, expect, it } from "vitest";
import { clearAllStatus, getProviderReachability } from "./model-status";
import { clearProbeCache } from "./provider-probe-cache";
import { scheduleProviderAvailabilitySweep, type ProviderProbeFn } from "./provider-prober";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits for real timers to flush a handful of microtask/macrotask turns. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("provider-prober", () => {
  beforeEach(() => {
    clearAllStatus();
    clearProbeCache();
  });

  it("returns synchronously without waiting for probes to resolve", () => {
    const blocker = deferred<"reachable">();
    const probe: ProviderProbeFn = () => blocker.promise;

    const before = Date.now();
    scheduleProviderAvailabilitySweep(["slow-provider"], probe);
    const after = Date.now();

    expect(after - before).toBeLessThan(50);
    // The probe must have been kicked off (status set to "checking")
    // even though it hasn't resolved yet -- proves the sweep actually
    // started work rather than doing nothing.
    expect(getProviderReachability("slow-provider")).toBe("checking");
  });

  it("sets 'checking' before the probe resolves, then the classified outcome after", async () => {
    const gate = deferred<"reachable">();
    const probe: ProviderProbeFn = () => gate.promise;

    scheduleProviderAvailabilitySweep(["prov-a"], probe);
    expect(getProviderReachability("prov-a")).toBe("checking");

    gate.resolve("reachable");
    await flush();

    expect(getProviderReachability("prov-a")).toBe("reachable");
  });

  it("classifies a successful probe as reachable and a failing probe as unreachable", async () => {
    const probe: ProviderProbeFn = async (providerId) => {
      if (providerId === "good") return "reachable";
      throw new Error("boom");
    };

    scheduleProviderAvailabilitySweep(["good", "bad"], probe);
    await flush();

    expect(getProviderReachability("good")).toBe("reachable");
    expect(getProviderReachability("bad")).toBe("unreachable");
  });

  it("classifies a provider with no resolvable credential as auth-failed", async () => {
    const probe: ProviderProbeFn = async () => "auth-failed";

    scheduleProviderAvailabilitySweep(["no-credential"], probe);
    await flush();

    expect(getProviderReachability("no-credential")).toBe("auth-failed");
  });

  it("bounds concurrency to at most 8 in-flight probes", async () => {
    const providerIds = Array.from({ length: 20 }, (_, i) => `provider-${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const probe: ProviderProbeFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return "reachable";
    };

    scheduleProviderAvailabilitySweep(providerIds, probe);
    await flush(20);
    // Give the 20ms-per-probe workers enough real time to fully drain.
    await new Promise((r) => setTimeout(r, 200));

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(maxInFlight).toBeGreaterThan(1);
    for (const id of providerIds) {
      expect(getProviderReachability(id)).toBe("reachable");
    }
  });

  it("is a safe no-op for an empty provider list", () => {
    const probe: ProviderProbeFn = async () => "reachable";
    expect(() => scheduleProviderAvailabilitySweep([], probe)).not.toThrow();
  });

  it("skips a provider whose probe cache entry is still fresh on a repeated sweep call", async () => {
    let calls = 0;
    const probe: ProviderProbeFn = async () => {
      calls++;
      return "reachable";
    };

    scheduleProviderAvailabilitySweep(["cached-provider"], probe);
    await flush();
    expect(calls).toBe(1);

    // A second sweep call shortly after must not re-probe a still-fresh provider.
    scheduleProviderAvailabilitySweep(["cached-provider"], probe);
    await flush();
    expect(calls).toBe(1);
  });
});
