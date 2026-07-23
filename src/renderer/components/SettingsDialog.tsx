import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSettingsStore } from "../state/settings-store";

export function SettingsDialog() {
  const isOpen = useSettingsStore((state) => state.isOpen);
  const summary = useSettingsStore((state) => state.summary);
  const close = useSettingsStore((state) => state.close);
  const save = useSettingsStore((state) => state.save);

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (summary) {
      setBaseUrl(summary.baseUrl);
      setModel(summary.model);
    }
  }, [summary]);

  if (!isOpen) return null;

  const onSave = async () => {
    try {
      setError(null);
      await save(apiKey, baseUrl, model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Provider settings</h2>
          <button type="button" onClick={close} className="text-white/50 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="block text-xs text-white/60">
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={summary?.hasApiKey ? "•••••••••••• (saved)" : "sk-..."}
              className="mt-1 w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            />
          </label>

          <label className="block text-xs text-white/60">
            Base URL
            <input
              type="text"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="mt-1 w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            />
          </label>

          <label className="block text-xs text-white/60">
            Model ID
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="mt-1 w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-white outline-none focus:border-accent/50"
            />
          </label>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-lg px-3 py-2 text-sm text-white/60 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
