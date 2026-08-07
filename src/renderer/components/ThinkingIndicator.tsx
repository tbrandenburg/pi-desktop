import { useExtensionUIStore } from "../state/extension-ui-store";
import type { ExtensionUIRequest } from "../../shared/events";

type SetWorkingPush = Extract<ExtensionUIRequest, { kind: "set-working" }>;

interface ThinkingIndicatorProps {
  /** Default message shown while no extension override is active (issue #138). */
  message?: string;
}

export function ThinkingIndicator({ message = "Thinking…" }: ThinkingIndicatorProps = {}) {
  const working = useExtensionUIStore((state) => state.dataPushes["set-working"]) as
    | SetWorkingPush
    | undefined;

  // Explicit `visible: false` hides the indicator entirely, even while a
  // chat turn is in progress (issue #138's acceptance criterion).
  if (working?.visible === false) return null;

  const resolvedMessage = working?.message ?? message;

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-white/40">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {resolvedMessage}
    </div>
  );
}
