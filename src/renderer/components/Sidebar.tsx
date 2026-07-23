import { MessageSquarePlus, X } from "lucide-react";
import { useEffect } from "react";
import { useChatStore } from "../state/chat-store";

export function Sidebar() {
  const conversationId = useChatStore((state) => state.conversationId);
  const sessions = useChatStore((state) => state.sessions);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const loadConversation = useChatStore((state) => state.loadConversation);
  const resetConversation = useChatStore((state) => state.resetConversation);
  const deleteSession = useChatStore((state) => state.deleteSession);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  return (
    <aside className="flex w-60 flex-col border-r border-surface-border bg-surface-panel/60 px-3 py-4">
      <button
        type="button"
        onClick={resetConversation}
        className="flex items-center gap-2 rounded-lg border border-surface-border px-3 py-2 text-sm text-white/80 transition hover:border-accent/40 hover:text-white"
      >
        <MessageSquarePlus size={16} />
        New chat
      </button>
      <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center rounded-lg text-xs transition ${
                session.id === conversationId
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:bg-white/5 hover:text-white/80"
              }`}
            >
              <button
                type="button"
                onClick={() => void loadConversation(session.id)}
                className="block flex-1 truncate px-3 py-2 text-left"
                title={session.title}
              >
                {session.title}
              </button>
              <button
                type="button"
                onClick={() => void deleteSession(session.id)}
                aria-label={`Delete ${session.title}`}
                className="mr-1 rounded p-1 text-white/30 opacity-0 transition hover:text-white/80 group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          ))
        ) : (
          <p className="px-3 py-2 text-xs text-white/30">No conversations yet.</p>
        )}
      </div>
    </aside>
  );
}
