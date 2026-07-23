import { Paperclip, Send, Square } from "lucide-react";
import { useState } from "react";
import { useChatStore } from "../state/chat-store";

export function Composer() {
  const [value, setValue] = useState("");
  const status = useChatStore((state) => state.status);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const stopGeneration = useChatStore((state) => state.stopGeneration);
  const selectedModel = useChatStore((state) => state.selectedModel);
  const isGenerating = status === "thinking" || status === "streaming";

  const submit = () => {
    if (isGenerating || !value.trim()) return;
    void sendMessage(value);
    setValue("");
  };

  return (
    <div className="border-t border-surface-border bg-surface-panel/60 px-6 py-4">
      <div className="flex items-end gap-3 rounded-2xl border border-surface-border bg-surface-panel px-4 py-3 focus-within:border-accent/50">
        <button
          type="button"
          disabled
          className="mt-1 text-white/25"
          title="Attachments (coming soon)"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Send a message…"
          className="max-h-40 flex-1 resize-none bg-transparent text-sm text-white outline-none placeholder:text-white/30"
        />
        <span className="mb-1 rounded-full border border-surface-border px-2 py-0.5 text-[11px] text-white/40">
          {selectedModel || "no model"}
        </span>
        {isGenerating ? (
          <button
            type="button"
            onClick={() => void stopGeneration()}
            className="mb-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
            title="Stop generation"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className="mb-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-black transition disabled:opacity-30"
            title="Send"
          >
            <Send size={14} />
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-white/30">Enter to send · Shift+Enter for newline</p>
    </div>
  );
}
