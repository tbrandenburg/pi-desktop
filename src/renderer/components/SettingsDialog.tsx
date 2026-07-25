import { X } from "lucide-react";
import { useSettingsStore } from "../state/settings-store";

export function SettingsDialog() {
  const isOpen = useSettingsStore((state) => state.isOpen);
  const close = useSettingsStore((state) => state.close);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-2xl border border-surface-border bg-surface-panel p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button type="button" onClick={close} className="text-white/50 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <p className="text-sm text-white/70">
          Pi Desktop is so easy, there is nothing to configure yet :)
        </p>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
