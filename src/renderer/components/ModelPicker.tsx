import { ChevronDown } from "lucide-react";
import { useChatStore } from "../state/chat-store";

export function ModelPicker() {
  const models = useChatStore((state) => state.models);
  const selectedModel = useChatStore((state) => state.selectedModel);
  const selectModel = useChatStore((state) => state.selectModel);
  const hasModels = models.length > 0;

  return (
    <div className="relative opacity-50 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100">
      <select
        value={hasModels ? selectedModel : ""}
        onChange={(event) => selectModel(event.target.value)}
        disabled={!hasModels}
        className="appearance-none rounded-lg border border-surface-border bg-surface-panel py-1.5 pl-3 pr-8 text-xs text-white/80 outline-none disabled:cursor-not-allowed disabled:text-white/40"
      >
        {hasModels ? (
          models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))
        ) : (
          <option value="">No models available</option>
        )}
      </select>
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40"
      />
    </div>
  );
}
