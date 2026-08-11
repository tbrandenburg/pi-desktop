/**
 * Minimal, opt-in chat-turn timing instrumentation.
 *
 * Born from a real profiling session (issue-less spike, see PR description)
 * that measured, phase-by-phase, where a single chat turn's latency
 * actually goes in the packaged app: `ChatService.runChat`'s registry
 * rebuild, `AgentRuntime.run`'s `ModelRuntime.create`/`createAgentSession`
 * calls, and the real network stream to the provider (time to first token,
 * time to full completion). The measured result was that the three
 * rebuild/setup phases combined cost roughly 300-500ms per turn -- the
 * dominant cost is the provider network round-trip itself, not any of this
 * app's own setup work. That conclusion is only trustworthy as long as it
 * can be re-checked later (a future pi-coding-agent/pi-ai bump, a slower
 * machine, a provider with a heavier catalog) without re-adding throwaway
 * `console.log` calls and deleting them again -- hence this permanent,
 * always-safe-when-disabled helper instead of leaving the instrumentation
 * out entirely.
 *
 * Disabled by default (a single boolean check per call site -- see
 * `isTurnTimingEnabled`'s doc comment for why call sites still take a
 * `Date.now()` timestamp even when disabled): set
 * `PI_DESKTOP_DEBUG_TIMING=1` in the environment to enable. Never gated
 * behind a Settings UI toggle -- this is a developer/support diagnostic,
 * not a user-facing feature, so an environment variable (matching this
 * app's existing `VITE_DEV_SERVER_URL`/`PI_CODING_AGENT_DIR` precedent) is
 * the right level of exposure: present for anyone who needs it, invisible
 * to everyone else.
 */
const enabled = process.env.PI_DESKTOP_DEBUG_TIMING === "1";

/** Whether chat-turn timing logging is enabled for this process. Read once at module load, matching this file's own `enabled` constant -- never re-reads `process.env` per call. */
export function isTurnTimingEnabled(): boolean {
  return enabled;
}

/**
 * Logs one structured chat-turn-timing line, tagged so it is trivially
 * greppable/parseable out of the app's stdout log (`"chat-turn-timing"` is
 * never used as a tag anywhere else in this codebase). No-ops entirely
 * (skips both the string formatting and the `console.debug` call) when
 * timing logging is disabled -- call sites still pay for their own
 * `Date.now()` timestamp regardless (a single `Date.now()` call has
 * negligible, sub-microsecond cost and is needed either way to compute
 * `durationMs`), but never pay for JSON serialization or an I/O write
 * unless a developer explicitly opted in.
 */
export function logTurnTiming(requestId: string, phase: string, durationMs: number): void {
  if (!enabled) return;
  console.debug(JSON.stringify({ tag: "chat-turn-timing", requestId, phase, durationMs }));
}
