import { Settings } from "lucide-react";
import { useEffect } from "react";
import { ChatTimeline } from "./ChatTimeline";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { ModelPicker } from "./ModelPicker";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { useChatStore } from "../state/chat-store";
import { useSettingsStore } from "../state/settings-store";

export function AppShell() {
  const loadModels = useChatStore((state) => state.loadModels);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const openSettings = useSettingsStore((state) => state.open);
  const refreshSettings = useSettingsStore((state) => state.refresh);

  useEffect(() => {
    void loadModels();
    void refreshSettings();
  }, [loadModels, refreshSettings]);

  return (
    <div className="flex h-screen w-screen bg-surface text-white">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-surface-border px-6 py-3">
          <span className="text-sm font-semibold tracking-wide text-white/80">
            Pi Desktop
          </span>
          <div className="flex items-center gap-3">
            <ModelPicker />
            <button
              type="button"
              onClick={openSettings}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border text-white/60 transition hover:text-white"
              title="Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </header>

        {errorMessage && <ErrorBanner message={errorMessage} />}

        <ChatTimeline />
        <Composer />
      </div>

      <SettingsDialog />
    </div>
  );
}
