import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat-store";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolCallBubble } from "./ToolCallBubble";

export function ChatTimeline() {
  const messages = useChatStore((state) => state.messages);
  const status = useChatStore((state) => state.status);
  const toolsExpanded = useChatStore((state) => state.toolsExpanded);
  const setToolsExpanded = useChatStore((state) => state.setToolsExpanded);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const toolsExpandedPush = useExtensionUIStore((state) => state.dataPushes["set-tools-expanded"]);
  const lastToolsExpandedRequestId = useRef<string | null>(null);

  useEffect(() => {
    if (!toolsExpandedPush || toolsExpandedPush.kind !== "set-tools-expanded") return;
    if (toolsExpandedPush.requestId === lastToolsExpandedRequestId.current) return;
    lastToolsExpandedRequestId.current = toolsExpandedPush.requestId;
    setToolsExpanded(toolsExpandedPush.value);
  }, [toolsExpandedPush, setToolsExpanded]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return <EmptyState />;
  }

  return (
    <div ref={containerRef} className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setToolsExpanded(!toolsExpanded)}
          className="flex items-center gap-1.5 text-[11px] text-white/40 transition hover:text-white"
        >
          {toolsExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
          {toolsExpanded ? "Collapse tool calls" : "Expand tool calls"}
        </button>
      </div>
      {messages.map((message) =>
        message.toolCall ? (
          <ToolCallBubble
            key={message.id}
            toolName={message.toolCall.toolName}
            arguments={message.toolCall.arguments}
            expanded={toolsExpanded}
          />
        ) : (
          <MessageBubble key={message.id} message={message} />
        ),
      )}
      {status === "thinking" && <ThinkingIndicator />}
    </div>
  );
}
