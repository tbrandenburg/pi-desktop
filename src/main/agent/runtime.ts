import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders, type AgentSessionEvent } from "./coding-agent-loaders";
import { createReadOnlyTools } from "./tools";

// Only lists the event types `AgentRuntime.forward`'s switch statement
// actually handles below -- everything else falls through to `default:
// return` regardless of filter membership, so keep this set in sync with
// that switch. `AgentSessionEvent` is a strict superset of the old
// `AgentEvent` union (see ADR 0001 §1.5) -- "message_update" and
// "tool_execution_start" pass through unchanged; only "agent_end" gained a
// `willRetry` field the switch below doesn't need.
const AGENT_SESSION_EVENT_TYPES = new Set<AgentSessionEvent["type"]>([
  "message_update",
  "tool_execution_start",
  "agent_end",
]);

export interface AgentRuntimeRunArgs {
  requestId: string;
  request: StartChatRequest;
  cwd: string;
  /** Fully-qualified provider id the resolved `model` belongs to (see `qualifyModelId`/`findModelById`). */
  providerId: string;
  model: Model<Api>;
  /** pi-desktop's own stored credential for `providerId`, if any (never `~/.pi/agent/auth.json` -- see AGENTS.md rule #5). */
  apiKey?: string;
  /**
   * Overrides pi-coding-agent's default `~/.pi/agent` config directory
   * (auth.json/models.json/sessions). Production code never sets this
   * (it intentionally shares the real `~/.pi/agent`, same as
   * `src/main/model/registry.ts`'s built-in/agent-dir provider sources);
   * tests set it to an isolated temp directory so they never read or
   * write the real developer's `~/.pi/agent` (which can be large enough
   * to make `createAgentSession`'s resource discovery slow).
   */
  agentDir?: string;
  /**
   * Injectable `ModelRuntime` instance, overriding the default
   * `ModelRuntime.create()` construction below. Production code never sets
   * this (each real chat turn builds its own instance from the real
   * `~/.pi/agent` config directory). Tests inject one pre-configured with a
   * `registerProvider`-based fake network provider -- `AgentRuntime.run`
   * would otherwise always construct a *fresh* `ModelRuntime` instance
   * internally that has no way to see a fake registered on a *different*
   * instance a test built separately, since `registerProvider` is purely
   * in-memory (not persisted to `auth.json`/`models.json`).
   */
  modelRuntime?: ModelRuntime;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
}

/**
 * Wraps `@earendil-works/pi-coding-agent`'s `AgentSession` (via
 * `createAgentSession`), translating its event protocol into this app's
 * `ChatEvent` union. Replaces the previous direct `pi-agent-core`
 * `AgentHarness` wrapper (issue #90 / ADR 0001 Phase 1) -- see the ADR's
 * §3.2 for the full before/after rationale. Runs headless (`hasUI=false`
 * is `AgentSession`'s own default when no `ExtensionUIContext` is wired);
 * commands/hooks may load via the real `ExtensionRunner`, but no UI-context
 * calls are wired yet (Phase 2, issue #91).
 */
export class AgentRuntime {
  constructor(private readonly loaders: CodingAgentLoaders = {}) {}

  async run({
    requestId,
    request,
    cwd,
    providerId,
    model,
    apiKey,
    agentDir,
    modelRuntime: injectedModelRuntime,
    signal,
    emit,
  }: AgentRuntimeRunArgs): Promise<void> {
    const { createAgentSession, ModelRuntime, SessionManager } = await loadCodingAgent(this.loaders);

    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage) {
      emit({ type: "error", requestId, message: "No user message to send." });
      return;
    }

    // `ModelRuntime.create()` discovers models the exact same way the `pi`
    // CLI does: built-in provider catalogs plus `~/.pi/agent/auth.json` /
    // `models.json`.
    const modelRuntime =
      injectedModelRuntime ??
      (await ModelRuntime.create({
        authPath: agentDir ? path.join(agentDir, "auth.json") : undefined,
        allowModelNetwork: false,
      }));
    // `ModelRuntime`'s own discovery (builtin catalogs + `~/.pi/agent/{auth,models}.json`)
    // covers most providers already. It does not know about pi-desktop's
    // own single-slot `app-settings` provider (baseUrl/model configured
    // through the app's Settings UI, see `src/main/model/registry.ts`'s
    // `APP_SETTINGS_PROVIDER_ID`), so register it on demand from the
    // already-resolved `model` object, including pi-desktop's own stored
    // credential directly in the registration -- never `~/.pi/agent/auth.json`
    // (AGENTS.md rule #5).
    //
    // NOTE: `ModelRuntime.setRuntimeApiKey` (ADR 0001 §1.5's suggested
    // injection point) was tried here first and found to be unsafe for
    // this case: it internally calls `refresh()`, which -- even when passed
    // `{ allowNetwork: false }` -- still hangs/retries for several seconds
    // against a registered `streamSimple`-only provider with a synthetic
    // `baseUrl` (reproduced directly against the real `0.83.0` package,
    // independent of pi-desktop's own code; see issue #90 handoff for the
    // repro). Including the credential directly in `registerProvider`'s
    // `apiKey` field (below) achieves the same "inject a credential without
    // touching `~/.pi/agent/auth.json`" outcome without that call.
    let resolvedModel = modelRuntime.getModel(providerId, model.id);
    if (!resolvedModel) {
      modelRuntime.registerProvider(providerId, {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey,
        models: [
          {
            id: model.id,
            name: model.name,
            api: model.api,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        ],
      });
      resolvedModel = modelRuntime.getModel(providerId, model.id) ?? model;
    }

    const sessionDir = agentDir ? path.join(agentDir, "sessions") : undefined;
    const sessionManager = await openOrCreateSessionManager(
      SessionManager,
      cwd,
      request.conversationId,
      sessionDir,
    );

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: resolvedModel,
      sessionManager,
      // Read-only tool set -- deliberately excludes pi-coding-agent's own
      // bash/edit/write/read built-ins (`noTools: "builtin"` disables the
      // default built-in tools while leaving our `customTools` active).
      // This preserves issue #41's original read-only scope unchanged by
      // the Phase 1 runtime swap.
      noTools: "builtin",
      customTools: createReadOnlyTools(cwd),
    });

    const unsubscribe = session.subscribe((event) => {
      if (AGENT_SESSION_EVENT_TYPES.has(event.type)) this.forward(requestId, event, emit);
    });
    const onAbort = () => {
      void session.abort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    emit({ type: "started", requestId });

    try {
      await session.prompt(lastUserMessage.content);
      emit({ type: "completed", requestId });
    } catch (error) {
      emit({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }

  private forward(requestId: string, event: AgentSessionEvent, emit: (event: ChatEvent) => void): void {
    switch (event.type) {
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          emit({ type: "text-delta", requestId, text: inner.delta });
        } else if (inner.type === "thinking_delta") {
          emit({ type: "reasoning-delta", requestId, text: inner.delta });
        }
        return;
      }
      case "tool_execution_start":
        emit({
          type: "tool-call",
          requestId,
          toolName: event.toolName,
          arguments: event.args,
        });
        return;
      case "agent_end": {
        const last = event.messages.at(-1);
        if (last && last.role === "assistant") {
          emit({
            type: "usage",
            requestId,
            inputTokens: last.usage.input,
            outputTokens: last.usage.output,
          });
        }
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Locates an existing on-disk session for `conversationId`, or creates a
 * fresh one with that id if none exists yet -- the `SessionManager`
 * equivalent of the pre-Phase-1 `openOrCreateSession`/`JsonlSessionRepo`
 * helper. This is what lets the same `conversationId` (generated once by
 * the renderer per conversation) keep resolving to the same persisted,
 * cwd-scoped session across separate `runChat` calls.
 */
async function openOrCreateSessionManager(
  SessionManagerClass: typeof SessionManager,
  cwd: string,
  conversationId: string,
  sessionDir?: string,
): Promise<SessionManager> {
  const existing = await SessionManagerClass.list(cwd, sessionDir);
  const match = existing.find((info) => info.id === conversationId);
  if (match) return SessionManagerClass.open(match.path, sessionDir);
  return SessionManagerClass.create(cwd, sessionDir, { id: conversationId });
}
