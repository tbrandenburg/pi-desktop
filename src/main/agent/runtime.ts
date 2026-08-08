import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ModelRuntime, ResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, CommandInfo, StartChatRequest } from "../../shared/events";
import { loadCodingAgent, type CodingAgentLoaders, type AgentSessionEvent } from "./coding-agent-loaders";

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
   * Injectable `ModelRuntime` instance, overriding the default
   * `ModelRuntime.create()` construction below. Production code never sets
   * this (each real chat turn builds its own instance from the real
   * `~/.pi/agent` config directory). Tests inject one pre-configured with a
   * `registerProvider`-based fake network provider -- `AgentRuntime.run`
   * would otherwise always construct a *fresh* `ModelRuntime` instance
   * internally that has no way to see a fake registered on a *different*
   * instance a test built separately, since `registerProvider` is purely
   * in-memory (not persisted to `auth.json`/`models.json`).
   *
   * Test isolation from the real `~/.pi/agent` (auth.json/models.json/
   * sessions) is achieved via the `PI_CODING_AGENT_DIR` env var pi-coding-agent's
   * own `getAgentDir()` already honors (see `config.js`) -- not via a
   * separate `agentDir` constructor/run-arg override, so that both
   * `AgentRuntime` (via `SessionManager`'s *default*, cwd-encoded session
   * directory resolution) and `SessionService` (`src/main/session/
   * service.ts`, via `getAgentDir()` directly) always resolve to the exact
   * same directory with zero extra plumbing.
   */
  modelRuntime?: ModelRuntime;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
  /**
   * Real `ExtensionUIContext` adapter (`ui-context.ts`'s `IpcUIContextBridge`)
   * bridging `ctx.ui.select/confirm/input/notify` calls over IPC to React
   * modals in the renderer -- ADR 0001 §3.4 Phase 2. When omitted (e.g. the
   * lightweight `listCommands` discovery session), extensions run headless
   * exactly as in Phase 1 -- `AgentSession` defaults `hasUI` to `false` until
   * `bindExtensions` is called with a real `uiContext`.
   */
  uiContext?: ExtensionUIContext;
  /**
   * Injectable `ResourceLoader`, overriding `createAgentSession`'s own
   * default (which discovers real extensions/skills/prompts/themes from
   * `cwd`/`agentDir`). Production code never sets this. Tests inject a
   * `DefaultResourceLoader` configured with `extensionFactories` to load an
   * inline test extension (`registerCommand` + `ctx.ui.*`) without touching
   * any real global or project-local extension directory -- mirrors the
   * `modelRuntime` injection seam above for the identical reason (real
   * discovery has no way to see a factory a test built separately).
   */
  resourceLoader?: ResourceLoader;
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
  /**
   * Tracks the start timestamp of an in-flight tool call (keyed by
   * `toolCallId`) so `tool_execution_end` can compute `durationMs` --
   * pi-agent-core does not surface a duration itself. Entries are removed
   * as soon as the matching `tool_execution_end` arrives; any left orphaned
   * by an aborted/crashed turn are swept in `run()`'s `finally` block so
   * this map can never grow unbounded across turns.
   */
  private readonly toolCallStartedAt = new Map<string, number>();

  constructor(private readonly loaders: CodingAgentLoaders = {}) {}

  async run({
    requestId,
    request,
    cwd,
    providerId,
    model,
    apiKey,
    modelRuntime: injectedModelRuntime,
    signal,
    emit,
    uiContext,
    resourceLoader,
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
    const modelRuntime = injectedModelRuntime ?? (await ModelRuntime.create({ allowModelNetwork: false }));
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

    const sessionManager = await openOrCreateSessionManager(SessionManager, cwd, request.conversationId);

    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model: resolvedModel,
      sessionManager,
      resourceLoader,
    });

    // Phase 2 (ADR 0001 §3.4, issue #91): wire the real IPC-backed
    // `ExtensionUIContext` so `ctx.ui.select/confirm/input/notify` calls
    // made by `registerCommand` handlers or hooks resolve against real
    // React modals in the renderer instead of no-oping. `mode: "rpc"` is
    // the closest of pi-coding-agent's own non-TUI modes to what
    // pi-desktop actually is (a UI-optional host with dialog-capable but
    // no terminal UI) -- see `ui-context.ts`'s doc comment. Omitted (as in
    // `listCommands` below) this stays headless exactly like Phase 1.
    if (uiContext) {
      await session.bindExtensions({ uiContext, mode: "rpc" });
    }

    const startedToolCallIds = new Set<string>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") startedToolCallIds.add(event.toolCallId);
      this.forward(requestId, event, emit);
    });
    const onAbort = () => {
      void session.abort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    emit({ type: "started", requestId });

    try {
      await session.prompt(lastUserMessage.content);

      // `session.prompt()` deliberately never throws for a request/model/
      // runtime failure (see pi-agent-core's `StreamFn` contract) -- a
      // failed turn (e.g. a real provider 403/OAuth error surfaced mid-call,
      // as opposed to the OAuth *resolution* failure thrown before any
      // request is even attempted, handled by the `catch` below) instead
      // resolves normally with a final assistant message whose
      // `stopReason` is `"error"`/`"aborted"` and `errorMessage` set. The
      // `agent_end`/`usage` forwarding above never inspects this, so
      // without this check the desktop UI would silently emit `completed`
      // for a turn that produced zero content and a real provider error
      // (issue found via manual production verification of #118/#119/#120,
      // reproduced with a real suspended github-copilot account).
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && last.stopReason === "error" && last.errorMessage) {
        emit({ type: "error", requestId, message: last.errorMessage });
      } else {
        emit({ type: "completed", requestId });
      }
    } catch (error) {
      emit({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      // Sweep any tool calls started during this turn whose
      // `tool_execution_end` never arrived (aborted/crashed turn) so
      // `toolCallStartedAt` never leaks entries across turns.
      for (const toolCallId of startedToolCallIds) this.toolCallStartedAt.delete(toolCallId);
    }
  }

  /**
   * Lists `pi.registerCommand` slash-commands from bundled/discovered
   * extensions, for the composer's `/` autocomplete (ADR 0001 §3.4 Phase 2,
   * issue #91). Uses a throwaway in-memory `SessionManager` (no on-disk
   * writes, no persisted conversation) purely to run extension discovery --
   * `createAgentSession`'s `extensionsResult.extensions[].commands` is
   * populated by loading extensions alone, before any `prompt()`/
   * `bindExtensions()` call, so this never needs a resolved model, a
   * `uiContext`, or to touch the real cwd-scoped session on disk (contrast
   * with `run()`'s session, which is real and persisted).
   */
  async listCommands(cwd: string, resourceLoader?: ResourceLoader): Promise<CommandInfo[]> {
    const { createAgentSession, ModelRuntime, SessionManager } = await loadCodingAgent(this.loaders);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    const { extensionsResult } = await createAgentSession({
      cwd,
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
      resourceLoader,
    });
    const commands: CommandInfo[] = [];
    for (const extension of extensionsResult.extensions) {
      for (const [name, command] of extension.commands) {
        commands.push({ name, description: command.description });
      }
    }
    return commands;
  }

  /**
   * `AgentSessionEvent` (`coding-agent-loaders.ts`) is a third-party union
   * from `@earendil-works/pi-coding-agent`/`pi-agent-core` this app doesn't
   * control (issue #111). Every branch below is an explicit, deliberate
   * decision -- no-op branches are documented, not merely omitted -- and the
   * `default` assigns to a `never`-typed variable so `tsc` fails to compile
   * if a future pi-coding-agent upgrade grows the union with a member not
   * yet triaged here, instead of silently falling through. This switch is
   * now the single source of truth for which event types this app reacts
   * to; the previous separate `AGENT_SESSION_EVENT_TYPES` allowlist Set
   * (kept in sync purely by a doc comment) has been removed.
   */
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
        this.toolCallStartedAt.set(event.toolCallId, Date.now());
        emit({
          type: "tool-call",
          requestId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
        });
        return;
      case "tool_execution_end": {
        const startedAt = this.toolCallStartedAt.get(event.toolCallId);
        this.toolCallStartedAt.delete(event.toolCallId);
        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt;
        emit({
          type: "tool-result",
          requestId,
          toolCallId: event.toolCallId,
          isError: event.isError,
          durationMs,
        });
        return;
      }
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
      case "auto_retry_start":
        emit({
          type: "retrying",
          requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        });
        return;
      // Deliberate no-ops: this app has no `ChatEvent` counterpart for these
      // yet (no turn/message boundary UI, no tool-progress UI beyond the
      // `tool-call`/`tool-result` pair, no queue/compaction/bash-streaming
      // UI). Note:
      // `auto_retry_end` is intentionally a no-op here -- the renderer
      // (`chat-store.ts`) clears the "retrying" indicator itself as soon as
      // any subsequent event (e.g. `text-delta`, `completed`, `error`)
      // arrives for the same message, so no explicit "retry resolved"
      // `ChatEvent` is needed.
      // Each is listed explicitly (rather than falling through to a bare
      // `default`) so the exhaustiveness check below actually forces a
      // decision the next time this union grows.
      case "agent_start":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_end":
      case "tool_execution_update":
      case "agent_settled":
      case "queue_update":
      case "compaction_start":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
      case "compaction_end":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update":
        return;
      default: {
        const exhaustiveCheck: never = event;
        return exhaustiveCheck;
      }
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
 *
 * Deliberately never passes an explicit `sessionDir` override to
 * `SessionManager.list/open/create` -- omitting it is what makes
 * `SessionManager` apply its own default, cwd-encoded resolution
 * (`<agentDir>/sessions/<encoded-cwd>/...`, see `getDefaultSessionDirPath`
 * in pi-coding-agent's `session-manager.js`). `SessionService`
 * (`src/main/session/service.ts`) relies on this exact same default
 * resolution (reconstructed via `JsonlSessionRepo`'s own identical
 * `encodeCwd()` step) to read back what this method writes -- passing a
 * custom `sessionDir` here would silently break that alignment (see issue
 * #90's session-format-alignment follow-up).
 */
async function openOrCreateSessionManager(
  SessionManagerClass: typeof SessionManager,
  cwd: string,
  conversationId: string,
): Promise<SessionManager> {
  const existing = await SessionManagerClass.list(cwd);
  const match = existing.find((info) => info.id === conversationId);
  if (match) return SessionManagerClass.open(match.path);
  return SessionManagerClass.create(cwd, undefined, { id: conversationId });
}

