import { beforeEach, describe, expect, it } from "vitest";
import {
  applyStatus,
  clearAllStatus,
  getModelVerification,
  getProviderReachability,
  onStatusChange,
  setModelVerification,
  setProviderReachability,
  type StatusChange,
} from "./model-status";
import type { ModelInfo } from "../../shared/events";

describe("model-status", () => {
  beforeEach(() => {
    clearAllStatus();
  });

  it("round-trips a provider's reachability", () => {
    expect(getProviderReachability("openrouter")).toBeUndefined();

    setProviderReachability("openrouter", "reachable");
    expect(getProviderReachability("openrouter")).toBe("reachable");

    setProviderReachability("openrouter", "auth-failed");
    expect(getProviderReachability("openrouter")).toBe("auth-failed");
    // A different, never-touched provider must remain unaffected.
    expect(getProviderReachability("anthropic")).toBeUndefined();
  });

  it("round-trips a model's verification result, including the given timestamp", () => {
    expect(getModelVerification("openrouter/gpt-4o-mini")).toBeUndefined();

    setModelVerification("openrouter/gpt-4o-mini", "ok", 1_700_000_000_000);
    const verification = getModelVerification("openrouter/gpt-4o-mini");
    expect(verification?.lastResult).toBe("ok");
    expect(verification?.lastVerifiedAt).toBe(1_700_000_000_000);

    setModelVerification("openrouter/gpt-4o-mini", "error", 1_700_000_001_000);
    const updated = getModelVerification("openrouter/gpt-4o-mini");
    expect(updated?.lastResult).toBe("error");
    expect(updated?.lastVerifiedAt).toBe(1_700_000_001_000);
  });

  it("merges known reachability and verification onto a model list without touching configured", () => {
    setProviderReachability("openrouter", "unreachable");
    setModelVerification("anthropic/claude-opus", "ok", 1_700_000_000_000);

    const models: ModelInfo[] = [
      { id: "openrouter/gpt-4o-mini", label: "openrouter/gpt-4o-mini", providerId: "openrouter", configured: true },
      { id: "anthropic/claude-opus", label: "anthropic/claude-opus", providerId: "anthropic", configured: false },
      { id: "unknown/foo", label: "unknown/foo", providerId: "unknown", configured: true },
    ];

    const merged = applyStatus(models);

    expect(merged[0].reachability).toBe("unreachable");
    expect(merged[0].configured).toBe(true);
    expect(merged[1].verified).toEqual({ lastResult: "ok", lastVerifiedAt: 1_700_000_000_000 });
    expect(merged[1].configured).toBe(false);
    expect(merged[2].reachability).toBeUndefined();
    expect(merged[2].verified).toBeUndefined();
  });

  it("notifies onStatusChange listeners with the provider id on a reachability change", () => {
    const received: StatusChange[] = [];
    const unsubscribe = onStatusChange((change) => received.push(change));

    setProviderReachability("openrouter", "reachable");

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ providerId: "openrouter" });

    unsubscribe();
    setProviderReachability("openrouter", "unreachable");
    // Unsubscribed listener must not receive further changes.
    expect(received).toHaveLength(1);
  });

  it("notifies onStatusChange listeners with the model id on a verification change", () => {
    const received: StatusChange[] = [];
    onStatusChange((change) => received.push(change));

    setModelVerification("openrouter/gpt-4o-mini", "ok");

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ modelId: "openrouter/gpt-4o-mini" });
  });

  it("clearAllStatus resets stored status and drops all listeners", () => {
    setProviderReachability("openrouter", "reachable");
    setModelVerification("openrouter/gpt-4o-mini", "ok");
    let notifications = 0;
    onStatusChange(() => {
      notifications += 1;
    });

    clearAllStatus();

    expect(getProviderReachability("openrouter")).toBeUndefined();
    expect(getModelVerification("openrouter/gpt-4o-mini")).toBeUndefined();

    // The listener registered before clearAllStatus() must no longer fire.
    setProviderReachability("openrouter", "reachable");
    expect(notifications).toBe(0);
  });
});
