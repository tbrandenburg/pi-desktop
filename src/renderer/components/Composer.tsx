import { Send, Square } from "lucide-react";
import { useState } from "react";
import { ModelPicker } from "./ModelPicker";
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
      <div className="relative rounded-2xl border border-surface-border bg-surface-panel px-4 py-3 focus-within:border-accent/50">
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
          className="max-h-40 w-full resize-none bg-transparent pr-10 text-sm text-white outline-none placeholder:text-white/30"
        />
        {isGenerating ? (
          <button
            type="button"
            onClick={() => void stopGeneration()}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-surface-hover text-white transition hover:bg-surface-hover-strong"
            title="Stop generation"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || !hasModel}
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-black transition disabled:opacity-30"
            title={hasModel ? "Send" : "Select a model to start chatting"}
          >
            <Send size={14} />
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-[11px] text-white/30">Enter to send · Shift+Enter for newline</p>
        <ModelPicker />
      </div>
    </div>
  );
}
