import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat-store";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";

export function ChatTimeline() {
  const messages = useChatStore((state) => state.messages);
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
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </div>
  );
}
