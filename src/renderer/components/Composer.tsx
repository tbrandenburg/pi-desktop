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
  const hasModel = Boolean(selectedModel);

  const submit = () => {
    if (isGenerating || !value.trim() || !hasModel) return;
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
        <span
          className={
            hasModel
              ? "mb-1 rounded-full border border-surface-border px-2 py-0.5 text-[11px] text-white/40"
              : "mb-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400"
          }
        >
          {hasModel ? selectedModel : "⚠ Select a model to start chatting"}
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
            disabled={!value.trim() || !hasModel}
            className="mb-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-accent text-black transition disabled:opacity-30"
            title={hasModel ? "Send" : "Select a model to start chatting"}
          >
            <Send size={14} />
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-white/30">Enter to send · Shift+Enter for newline</p>
    </div>
  );
}
