import type { AgentEvent, AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { ChatEvent, StartChatRequest } from "../../shared/events";
import { loadAgentCore, loadAgentCoreNode, type AgentCoreLoaders } from "./agent-core";
import { createReadOnlyTools } from "./tools";

type SessionMetadataLike = { id: string };

const AGENT_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

function isAgentEvent(event: AgentHarnessEvent): event is AgentEvent {
  return AGENT_EVENT_TYPES.has(event.type as AgentEvent["type"]);
}

/**
 * Locates an existing on-disk session for `conversationId`, or creates a
 * fresh one with that id if none exists yet. This is what lets the same
 * `conversationId` (generated once by the renderer per conversation) keep
 * resolving to the same persisted, cwd-scoped `JsonlSessionRepo` session
 * across separate `runChat` calls -- each call constructs its own
 * short-lived `AgentHarness`, but they all share the same on-disk session.
 */
async function openOrCreateSession<TSession, TMetadata extends SessionMetadataLike>(
  repo: {
    list: (options?: { cwd?: string }) => Promise<TMetadata[]>;
    open: (metadata: TMetadata) => Promise<TSession>;
    create: (options: { cwd: string; id?: string }) => Promise<TSession>;
  },
  cwd: string,
  conversationId: string,
): Promise<TSession> {
  const existing = await repo.list({ cwd });
  const match = existing.find((metadata) => metadata.id === conversationId);
  if (match) return repo.open(match);
  return repo.create({ cwd, id: conversationId });
}

export interface AgentRuntimeRunArgs {
  requestId: string;
  request: StartChatRequest;
  cwd: string;
  models: MutableModels;
  model: Model<Api>;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
}

/**
 * Wraps `@earendil-works/pi-agent-core`'s `AgentHarness`, translating its
 * event protocol into this app's `ChatEvent` union. Replaces the direct
 * `registry.models.stream(...)` single-turn call that `ChatService` used
 * before -- see the event-mapping table in the issue #41 investigation.
 */
export class AgentRuntime {
  constructor(private readonly loaders: AgentCoreLoaders = {}) {}

  async run({ requestId, request, cwd, models, model, signal, emit }: AgentRuntimeRunArgs): Promise<void> {
    const { AgentHarness, JsonlSessionRepo } = await loadAgentCore(this.loaders);
    const { NodeExecutionEnv } = await loadAgentCoreNode(this.loaders);

    const env = new NodeExecutionEnv({ cwd });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: cwd });
    const session = await openOrCreateSession(repo, cwd, request.conversationId);

    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMessage) {
      emit({ type: "error", requestId, message: "No user message to send." });
      return;
    }

    const harness = new AgentHarness({
      env,
      session,
      models,
      model,
      tools: createReadOnlyTools(env),
    });

    const unsubscribe = harness.subscribe((event) => {
      if (isAgentEvent(event)) this.forward(requestId, event, emit);
    });
    const onAbort = () => {
      void harness.abort();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    emit({ type: "started", requestId });

    try {
      await harness.prompt(lastUserMessage.content);
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

  private forward(requestId: string, event: AgentEvent, emit: (event: ChatEvent) => void): void {
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
