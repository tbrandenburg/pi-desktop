import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Activity } from "../state/chat-store";

const CIRCLED_DIGITS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function circledNumber(index: number): string {
  return CIRCLED_DIGITS[index] ?? `(${index + 1})`;
}

function formatDurationSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * A small, hand-rolled anchored popover showing the full trace of one
 * assistant message's tool-call activity (issue #151). Overlays the
 * message rather than pushing layout; closes on outside click, `Escape`,
 * or the × button.
 */
export function ActivityDetails({
  activity,
  open,
  onClose,
}: {
  activity: Activity[];
  open: boolean;
  onClose: () => void;
}) {
  const [traceExpanded, setTraceExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTraceExpanded(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const allSources = activity.flatMap((item) => item.sources ?? []);

  return (
    <div
      ref={panelRef}
      className="absolute z-40 right-0 mt-2 max-h-[420px] w-[400px] overflow-y-auto rounded-2xl border border-surface-border bg-surface-panel p-4 text-sm shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-white">How this answer was made</h3>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="text-white/40 transition hover:text-white"
        >
          <X size={16} />
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-white/40">Activity</p>
        {activity.map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-white/80">
            {item.status === "running" && <Loader2 size={13} className="animate-spin text-accent" />}
            {item.status === "done" && <Check size={13} className="text-white/40" />}
            {item.status === "error" && <AlertTriangle size={13} className="text-amber-400" />}
            <span className="flex-1">{item.label}</span>
            {item.durationMs !== undefined && (
              <span className="text-[11px] text-white/40">{formatDurationSeconds(item.durationMs)}</span>
            )}
          </div>
        ))}
      </div>

      {allSources.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-white/40">Sources</p>
          {allSources.map((source, index) => (
            <a
              key={`${source.url}-${index}`}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 text-white/70 transition hover:text-white"
            >
              <span className="text-[12px] text-white/40">{circledNumber(index)}</span>
              <span className="flex-1 truncate">{source.title}</span>
              <ExternalLink size={12} className="shrink-0 text-white/40" />
            </a>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setTraceExpanded((value) => !value)}
        className="mt-3 flex items-center gap-1 text-[12px] text-white/50 transition hover:text-white"
      >
        {traceExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Technical trace
      </button>

      {traceExpanded && (
        <div className="mt-2 space-y-3">
          {activity.map((item) => (
            <div key={item.id} className="rounded-lg border border-surface-border bg-black/20 p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[12px] text-white/80">{item.toolName}</span>
                {item.status === "error" ? (
                  <span className="flex items-center gap-1 text-[11px] text-amber-400">
                    <AlertTriangle size={11} />
                    Failed
                  </span>
                ) : (
                  <span className="text-[11px] text-white/40">
                    {item.durationMs !== undefined ? `✓ ${formatDurationSeconds(item.durationMs)}` : "✓"}
                  </span>
                )}
              </div>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/10 p-3 text-[10px] text-white/30">
                {JSON.stringify(item.args, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
