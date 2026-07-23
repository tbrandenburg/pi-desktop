import { Sparkles } from "lucide-react";
import { useChatStore } from "../state/chat-store";

const SUGGESTIONS = [
  "Explain this architecture in five steps",
  "Create an implementation plan",
  "Review a project folder",
];

export function EmptyState() {
  const sendMessage = useChatStore((state) => state.sendMessage);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Sparkles size={22} />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-white">What are we building today?</h1>
        <p className="max-w-md text-sm text-white/50">
          Ask a question, explore a codebase, or draft an idea.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => void sendMessage(suggestion)}
            className="rounded-full border border-surface-border bg-surface-panel px-4 py-2 text-sm text-white/70 transition hover:border-accent/40 hover:text-white"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
