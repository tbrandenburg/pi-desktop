import { ChevronDown, ChevronRight, Wrench } from "lucide-react";

interface ToolCallBubbleProps {
  toolName: string;
  arguments: unknown;
  expanded: boolean;
}

/**
 * Renders a single tool-call event (issue #139) as its own bubble in the
 * chat timeline. Expand/collapse is driven globally by `chat-store`'s
 * `toolsExpanded` boolean (kept in sync with pi-coding-agent's own
 * `getToolsExpanded()`/`setToolsExpanded()`, which is a single boolean, not
 * per-tool-call state) rather than tracking per-bubble expand state.
 */
export function ToolCallBubble({ toolName, arguments: args, expanded }: ToolCallBubbleProps) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl border border-surface-border bg-surface-hover px-4 py-2.5 text-sm text-white/70">
        <div className="flex items-center gap-2">
          <Wrench size={14} className="shrink-0 text-accent" />
          <span className="font-mono text-[13px] text-white/80">{toolName}</span>
          {expanded ? (
            <ChevronDown size={14} className="ml-auto shrink-0 text-white/40" />
          ) : (
            <ChevronRight size={14} className="ml-auto shrink-0 text-white/40" />
          )}
        </div>
        {expanded && (
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/30 p-3 text-[12px] text-white/60">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
