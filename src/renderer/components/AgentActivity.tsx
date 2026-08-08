import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useState } from "react";
import type { Activity } from "../state/chat-store";
import { ActivityDetails } from "./ActivityDetails";

/** Number of most-recently-completed items shown alongside the current running one before collapsing into a "N previous steps" line (issue #151). */
const VISIBLE_COMPLETED_COUNT = 2;

function distinctLabels(activity: Activity[]): string {
  const seen: string[] = [];
  for (const item of activity) {
    if (!seen.includes(item.label)) seen.push(item.label);
  }
  return seen.join(" · ");
}

/**
 * Renders the grouped tool-call activity for a single assistant message
 * (issue #151), below a hairline divider. Renders nothing when there is no
 * activity at all, so a tool-free conversation looks pixel-identical to
 * before this feature existed.
 */
export function AgentActivity({
  activity,
  streaming,
  hasContent,
}: {
  activity: Activity[] | undefined;
  streaming?: boolean;
  hasContent?: boolean;
}) {
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!activity || activity.length === 0) return null;

  const running = activity.filter((item) => item.status === "running");
  const isRunning = running.length > 0;

  if (isRunning && streaming && hasContent) {
    // Mode 2: streaming real answer text, but a step is still running --
    // a single quiet line, no stack, no history.
    const current = running[running.length - 1];
    return (
      <div className="mt-3 border-t border-surface-border pt-2 text-[12px] text-white/50">
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin text-accent" />
          {current.label}
        </span>
      </div>
    );
  }

  if (isRunning) {
    // Mode 1: working / no answer text yet -- the activity stack.
    const current = running[running.length - 1];
    const completed = activity.filter((item) => item !== current && item.status !== "running");
    const visibleCompleted = completed.slice(-VISIBLE_COMPLETED_COUNT);
    const hiddenCount = completed.length - visibleCompleted.length;

    return (
      <div className="mt-3 border-t border-surface-border pt-2 text-[12px] text-white/50">
        <div className="flex flex-col gap-1">
          {hiddenCount > 0 && !showAllCompleted && (
            <button
              type="button"
              onClick={() => setShowAllCompleted(true)}
              className="w-fit text-left text-white/35 transition hover:text-white/60"
            >
              ✓ {hiddenCount} previous {hiddenCount === 1 ? "step" : "steps"}
            </button>
          )}
          {(showAllCompleted ? completed : visibleCompleted).map((item) => (
            <span key={item.id} className="flex items-center gap-1.5 text-white/35">
              <Check size={12} className="text-white/30" />
              {item.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-white/60">
            <Loader2 size={12} className="animate-spin text-accent" />
            {current.label}
          </span>
        </div>
      </div>
    );
  }

  // Mode 3: complete -- compact footer with a Details link.
  const hasError = activity.some((item) => item.status === "error");
  const summary = distinctLabels(activity);
  const count = activity.length;
  const sourceCount = activity.reduce((total, item) => total + (item.sources?.length ?? 0), 0);

  const footerText = hasError
    ? `${count} step${count === 1 ? "" : "s"} · 1 failed`
    : sourceCount > 0
      ? `${summary} · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`
      : summary;

  return (
    <div className="mt-3 border-t border-surface-border/60 pt-2 text-[12px]">
      <div className={hasError ? "flex items-center gap-2 text-amber-400" : "flex items-center gap-2 text-white/30"}>
        {hasError ? <AlertTriangle size={12} /> : <Check size={12} />}
        <span>{footerText}</span>
        <button
          type="button"
          onClick={() => setDetailsOpen(true)}
          className="ml-auto text-white/30 underline decoration-dotted transition hover:text-white/70"
        >
          Details
        </button>
      </div>
      <ActivityDetails
        activity={activity}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </div>
  );
}
