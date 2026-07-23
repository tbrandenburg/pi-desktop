import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chat-store";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";
import { ThinkingIndicator } from "./ThinkingIndicator";

export function ChatTimeline() {
  const messages = useChatStore((state) => state.messages);
  const status = useChatStore((state) => state.status);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
      {status === "thinking" && <ThinkingIndicator />}
    </div>
  );
}
