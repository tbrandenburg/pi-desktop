import { Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatTimeline } from "./ChatTimeline";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { useChatStore } from "../state/chat-store";
import { useSettingsStore } from "../state/settings-store";

export function AppShell() {
  const loadModels = useChatStore((state) => state.loadModels);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const openSettings = useSettingsStore((state) => state.open);

  // Theme is applied pre-paint by theme-init.ts (see main.tsx) to avoid FOUC,
  // so <html data-theme> is already correct on first render — seed state from
  // it rather than re-reading localStorage. Persisted via localStorage
  // (Chromium-managed, no fs code, no IPC), default dark. Flipping the
  // attribute re-resolves every surface/border/accent utility in styles.css
  // with zero per-component changes.
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  const isDark = theme === "dark";
  const toggleTheme = () => setTheme((prev) => (prev === "dark" ? "light" : "dark"));

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  return (
    <div className="flex h-screen w-screen bg-surface text-white">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-surface-border px-6 py-3">
          <span className="text-sm font-semibold tracking-wide text-white/80">
            Pi Desktop
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border text-foreground/50 transition hover:text-foreground"
              title={isDark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              type="button"
              onClick={openSettings}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-surface-border text-foreground/50 transition hover:text-foreground"
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
