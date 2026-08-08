import { useEffect, useRef, useState } from "react";
import { useExtensionUIStore } from "../state/extension-ui-store";
import type { ExtensionUIRequest } from "../../shared/events";

type SetWorkingPush = Extract<ExtensionUIRequest, { kind: "set-working" }>;

/** Milliseconds between each revealed character (issue #145). */
const TYPE_SPEED_MS = 28;

/**
 * A single ephemeral status caption, typed out letter-by-letter at the
 * streaming cursor position (issue #145). Replaces the old static
 * `ThinkingIndicator` dot — this is the only "in progress" ambient signal
 * for the whole lifecycle of a turn, from request sent to first real
 * content token.
 *
 * Every time `label` changes, the previous animation is cut off immediately
 * (no finish-then-replace queueing) and the new label starts typing from
 * scratch. Nothing about a finished step lingers once it's done.
 */
export function TypewriterCaption({ label }: { label: string }) {
  const [displayed, setDisplayed] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Issue #138: an extension can still override the message, or hide the
  // caption entirely with `visible: false`.
  const working = useExtensionUIStore((state) => state.dataPushes["set-working"]) as
    | SetWorkingPush
    | undefined;

  const resolvedLabel = working?.message ?? label;
  const hidden = working?.visible === false;

  useEffect(() => {
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    setDisplayed("");
    let i = 0;
    intervalRef.current = setInterval(() => {
      i += 1;
      setDisplayed(resolvedLabel.slice(0, i));
      if (i >= resolvedLabel.length && intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, TYPE_SPEED_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [resolvedLabel]);

  if (hidden) return null;

  return (
    <span className="text-white/40">
      {displayed}
      <span className="streaming-cursor" />
    </span>
  );
}
