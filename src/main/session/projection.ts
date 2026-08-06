import fs from "node:fs";
import type { Session, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { qualifyModelId, asBareModelId } from "../model/registry";
import type { ChatMessage, SessionRecord, SessionSummary } from "../../shared/events";

/**
 * Adapts `@earendil-works/pi-agent-core`'s `JsonlSessionRepo` (session tree
 * + `JsonlSessionMetadata`) to this app's flat `SessionSummary`/`SessionRecord`
 * shapes -- the on-disk format has no `title`/`updatedAt`/`model` fields, so
 * all three are derived here.
 *
 * Title derivation and the compaction-aware entry-to-message projection are
 * deliberately reduced-scope adaptations of two upstream patterns from
 * `earendil-works/pi`'s `packages/coding-agent/src/core/session-manager.ts`
 * (`buildSessionInfo`'s title fallback chain, and its compaction-aware
 * tree->flat projection, ~lines 401-459): latest `session_info` name wins,
 * else the first user message (trimmed/truncated), else "(untitled)".
 *
 * `updatedAt` has no equivalent in `JsonlSessionMetadata` at all -- this
 * uses the on-disk JSONL file's mtime, which is simpler and just as accurate
 * as re-deriving a timestamp from the last session entry, since every
 * `Session.append*` call appends to (and touches the mtime of) that same file.
 */
const TITLE_MAX_LENGTH = 80;

function deriveTitle(entries: readonly SessionTreeEntry[]): string {
  const sessionInfo = [...entries].reverse().find((entry) => entry.type === "session_info");
  if (sessionInfo?.type === "session_info" && sessionInfo.name) {
    return sessionInfo.name;
  }

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

function textFromContentBlocks(content: { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

function deriveModel(entries: readonly SessionTreeEntry[]): string {
  const modelChange = [...entries].reverse().find((entry) => entry.type === "model_change");
  if (modelChange?.type === "model_change") {
    return qualifyModelId(modelChange.provider, asBareModelId(modelChange.modelId));
  }
  return "";
}

function entriesToMessages(entries: readonly SessionTreeEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const { message } = entry;
      if (message.role === "user") {
        const content =
          typeof message.content === "string" ? message.content : textFromContentBlocks(message.content);
        messages.push({ role: "user", content });
      } else if (message.role === "assistant") {
        const content = message.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map((block) => block.text)
          .join("");
        messages.push({ role: "assistant", content });
      }
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      messages.push({ role: "system", content: entry.summary });
    }
  }
  return messages;
}

export async function projectSessionSummary(
  session: Session,
  metadataPath: string,
): Promise<SessionSummary> {
  const metadata = await session.getMetadata();
  const entries = await session.getEntries();
  const updatedAt = fs.existsSync(metadataPath) ? fs.statSync(metadataPath).mtimeMs : Date.now();

  return {
    id: metadata.id,
    title: deriveTitle(entries),
    model: deriveModel(entries),
    updatedAt,
  };
}

export async function projectSessionRecord(
  session: Session,
  metadataPath: string,
): Promise<SessionRecord> {
  const summary = await projectSessionSummary(session, metadataPath);
  const entries = await session.buildContextEntries();
  return { ...summary, messages: entriesToMessages(entries) };
}
