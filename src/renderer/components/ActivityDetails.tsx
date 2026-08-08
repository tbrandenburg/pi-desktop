import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Activity } from "../state/chat-store";

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
  defaultTraceExpanded,
}: {
  activity: Activity[];
  open: boolean;
  onClose: () => void;
  defaultTraceExpanded: boolean;
}) {
  const [traceExpanded, setTraceExpanded] = useState(defaultTraceExpanded);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTraceExpanded(defaultTraceExpanded);
  }, [open, defaultTraceExpanded]);

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

  return (
    <div
      ref={panelRef}
      className="absolute z-40 mt-2 max-h-[420px] w-[400px] overflow-y-auto rounded-2xl border border-surface-border bg-surface-panel p-4 text-sm shadow-xl"
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
              <span className="text-[11px] text-white/40">{item.durationMs}ms</span>
            )}
          </div>
        ))}
      </div>

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
                <span className="text-[11px] text-white/40">
                  {item.status === "error" ? "isError: true" : "isError: false"}
                  {item.durationMs !== undefined ? ` · ${item.durationMs}ms` : ""}
                </span>
              </div>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/30 p-3 text-[12px] text-white/60">
                {JSON.stringify(item.args, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
