import { FolderOpen, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
import { useChatStore } from "../state/chat-store";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(true);
  const [version, setVersion] = useState("");
  const conversationId = useChatStore((state) => state.conversationId);
  const sessions = useChatStore((state) => state.sessions);
  const workspaceDir = useChatStore((state) => state.workspaceDir);
  const loadWorkspace = useChatStore((state) => state.loadWorkspace);
  const chooseWorkspace = useChatStore((state) => state.chooseWorkspace);
  const loadConversation = useChatStore((state) => state.loadConversation);
  const resetConversation = useChatStore((state) => state.resetConversation);
  const deleteSession = useChatStore((state) => state.deleteSession);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    void desktopApi().getVersion().then(setVersion);
  }, []);

  return (
    <aside
      className={`flex flex-col overflow-hidden border-r border-surface-border bg-surface-panel/60 py-4 transition-[width] duration-200 ease-in-out ${
        collapsed ? "w-14 px-2" : "w-60 px-3"
      }`}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={`mb-3 flex h-8 w-8 items-center justify-center rounded-lg text-white/60 transition hover:bg-surface-hover hover:text-white ${
          collapsed ? "" : "self-end"
        }`}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>

      <button
        type="button"
        onClick={resetConversation}
        title="New chat"
        className={`flex items-center gap-2 rounded-lg border border-surface-border text-sm text-white/80 transition hover:border-accent/40 hover:text-white ${
          collapsed ? "justify-center px-0 py-2" : "px-3 py-2"
        }`}
      >
        <MessageSquarePlus size={16} />
        {!collapsed && "New chat"}
      </button>

      <button
        type="button"
        onClick={() => void chooseWorkspace()}
        title={workspaceDir ? `Workspace: ${workspaceDir}` : "Choose workspace folder"}
        className={`mt-2 flex items-center gap-2 rounded-lg border border-surface-border text-sm text-white/60 transition hover:border-accent/40 hover:text-white ${
          collapsed ? "justify-center px-0 py-2" : "px-3 py-2"
        }`}
      >
        <FolderOpen size={16} />
        {!collapsed && <span className="truncate">{workspaceDir || "Choose workspace"}</span>}
      </button>

      {!collapsed && (
        <div className="mt-4 flex-1 space-y-1 overflow-y-auto">
          {sessions.length > 0 ? (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`group flex items-center rounded-lg text-xs transition ${
                  session.id === conversationId
                    ? "bg-surface-hover-strong text-white"
                    : "text-white/60 hover:bg-surface-hover hover:text-white/80"
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
      )}

      {!collapsed && version && (
        <p className="mt-auto pb-2 text-center text-[10px] text-white/30">v{version}</p>
      )}
    </aside>
  );
}
