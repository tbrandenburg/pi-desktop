import fs from "node:fs";
import { qualifyModelId, asBareModelId } from "../model/registry";
import type { SessionEntry, SessionManager } from "../agent/coding-agent-loaders";
import type { ActivityRecord, ChatMessage, SessionRecord, SessionSummary } from "../../shared/events";

/**
 * Adapts `@earendil-works/pi-coding-agent`'s `SessionManager` (session tree
 * + `SessionInfo`/`SessionHeader`) to this app's flat `SessionSummary`/
 * `SessionRecord` shapes -- the on-disk format has no `title`/`updatedAt`
 * field, so both are derived here (`model` is read from `getEntries()`'s own
 * `model_change` entries).
 *
 * Title derivation and the compaction-aware entry-to-message projection are
 * deliberately reduced-scope adaptations of two upstream patterns from
 * `earendil-works/pi`'s `packages/coding-agent/src/core/session-manager.ts`
 * (`buildSessionInfo`'s title fallback chain, and its compaction-aware
 * tree->flat projection, ~lines 401-459): latest `session_info` name wins,
 * else the first user message (trimmed/truncated), else "(untitled)".
 *
 * `updatedAt` has no equivalent on `SessionHeader`/`SessionInfo` at all --
 * this uses the on-disk JSONL file's mtime, which is simpler and just as
 * accurate as re-deriving a timestamp from the last session entry, since
 * every `SessionManager.append*` call appends to (and touches the mtime of)
 * that same file once it has been flushed to disk.
 */
const TITLE_MAX_LENGTH = 80;

function deriveTitle(entries: readonly SessionEntry[], sessionName: string | undefined): string {
  if (sessionName) return sessionName;

  const firstUserMessage = entries.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  if (firstUserMessage?.type === "message" && firstUserMessage.message.role === "user") {
    const content = firstUserMessage.message.content;
    const text = typeof content === "string" ? content : textFromContentBlocks(content);
    const trimmed = text.trim();
    if (trimmed) {
      return trimmed.length > TITLE_MAX_LENGTH ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}...` : trimmed;
    }
  }

  return "(untitled)";
}

function textFromContentBlocks(content: { type: string; text?: string }[], separator = " "): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(separator);
}

/**
 * Conservative, best-effort extraction of a "sources" list (title + url
 * pairs) from an opaque tool-result payload (issue #157). Behavior kept
 * identical to the renderer's `extractSources` in
 * `src/renderer/state/chat-store.ts` -- colocated here rather than
 * cross-imported since this is main-process code and that's renderer state.
 * Never fabricates: returns `undefined` unless it finds a recognizable list
 * of items each carrying both a title-like and a url-like string field.
 */
function extractSources(result: unknown): { title: string; url: string }[] | undefined {
  const candidates = candidateArray(result);
  if (!candidates) return undefined;

  const sources: { title: string; url: string }[] = [];
  for (const item of candidates) {
    const source = asSource(item);
    if (source) sources.push(source);
  }
  return sources.length > 0 ? sources : undefined;
}

function candidateArray(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (result === null || typeof result !== "object") return undefined;

  for (const key of ["results", "sources", "items"]) {
    const value = (result as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function asSource(item: unknown): { title: string; url: string } | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;

  const url = firstStringField(record, ["url", "link"]);
  const title = firstStringField(record, ["title", "name"]);
  if (!url || !title) return undefined;
  return { title, url };
}

function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key.toLowerCase()) && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function deriveModel(entries: readonly SessionEntry[]): string {
  const modelChange = [...entries].reverse().find((entry) => entry.type === "model_change");
  if (modelChange?.type === "model_change") {
    return qualifyModelId(modelChange.provider, asBareModelId(modelChange.modelId));
  }
  return "";
}

interface PendingToolCall {
  toolName: string;
  args: unknown;
}

/**
 * `entriesToMessages` walks the flat, chronological session tree and needs to
 * pair up two separately-persisted entry kinds: an assistant message's
 * `toolCall` content blocks (the request) and a later, separate `toolResult`
 * `Message` entry (the response), matched by `toolCall.id` /
 * `toolResult.toolCallId`. `pendingToolCalls` holds requests not yet matched
 * to a result; `pendingActivity` holds matched pairs, projected into
 * `ActivityRecord`s, not yet attached to a `ChatMessage` -- they're flushed
 * onto the next assistant message pushed (or, if the session ends before
 * another assistant message arrives, onto a final synthetic empty-text one).
 *
 * Note: the persisted session format has no timestamp pair to compute a real
 * tool-call duration from (that's only ever tracked transiently in
 * `runtime.ts` while a chat is live), so `durationMs` is always `0` here for
 * restored sessions -- not a fabricated value, just "unknown".
 */
function entriesToMessages(entries: readonly SessionEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolCall>();
  let pendingActivity: ActivityRecord[] = [];

  const pushAssistant = (content: string) => {
    const message: ChatMessage = { role: "assistant", content };
    if (pendingActivity.length > 0) {
      message.activity = pendingActivity;
      pendingActivity = [];
    }
    messages.push(message);
  };

  for (const entry of entries) {
    if (entry.type === "message") {
      const { message } = entry;
      if (message.role === "user") {
        const content =
          typeof message.content === "string" ? message.content : textFromContentBlocks(message.content);
        messages.push({ role: "user", content });
      } else if (message.role === "assistant") {
        const content = textFromContentBlocks(message.content, "");
        for (const block of message.content) {
          if (block.type === "toolCall") {
            pendingToolCalls.set(block.id, { toolName: block.name, args: block.arguments });
          }
        }
        pushAssistant(content);
      } else if (message.role === "toolResult") {
        const pending = pendingToolCalls.get(message.toolCallId);
        pendingToolCalls.delete(message.toolCallId);
        pendingActivity.push({
          id: message.toolCallId,
          toolName: pending?.toolName ?? message.toolName,
          isError: message.isError ?? false,
          durationMs: 0,
          args: pending?.args,
          sources: extractSources(message.details),
        });
      }
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({ role: "system", content: entry.summary });
    }
  }

  if (pendingActivity.length > 0) {
    pushAssistant("");
  }

  return messages;
}

export async function projectSessionSummary(
  session: SessionManager,
  metadataPath: string,
): Promise<SessionSummary> {
  const header = session.getHeader();
  if (!header) throw new Error("Cannot project an in-memory session without a header");
  const entries = session.getEntries();
  const updatedAt = fs.existsSync(metadataPath) ? fs.statSync(metadataPath).mtimeMs : Date.now();

  return {
    id: header.id,
    title: deriveTitle(entries, session.getSessionName()),
    model: deriveModel(entries),
    updatedAt,
  };
}

export async function projectSessionRecord(
  session: SessionManager,
  metadataPath: string,
): Promise<SessionRecord> {
  const summary = await projectSessionSummary(session, metadataPath);
  const entries = session.buildContextEntries();
  return { ...summary, messages: entriesToMessages(entries) };
}
