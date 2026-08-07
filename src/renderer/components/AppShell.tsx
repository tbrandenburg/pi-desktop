import { Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatTimeline } from "./ChatTimeline";
import { Composer } from "./Composer";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBanner } from "./ErrorBanner";
import { InputDialog } from "./InputDialog";
import { NotificationToast } from "./NotificationToast";
import { SelectDialog } from "./SelectDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Sidebar } from "./Sidebar";
import { desktopApi } from "../lib/desktop-api";
import { normalizeShortcutEvent } from "../lib/shortcut-key";
import { useChatStore } from "../state/chat-store";
import { useExtensionUIStore } from "../state/extension-ui-store";
import { useSettingsStore } from "../state/settings-store";
import type { ExtensionUIRequest, ShortcutInfo } from "../../shared/events";

type SetTitlePush = Extract<ExtensionUIRequest, { kind: "set-title" }>;
type SetStatusPush = Extract<ExtensionUIRequest, { kind: "set-status" }>;

export function AppShell() {
  const loadModels = useChatStore((state) => state.loadModels);
  const loadCommands = useChatStore((state) => state.loadCommands);
  const errorMessage = useChatStore((state) => state.errorMessage);
  const openSettings = useSettingsStore((state) => state.open);
  const handleExtensionUIRequest = useExtensionUIStore((state) => state.handleRequest);
  const titlePush = useExtensionUIStore((state) => state.dataPushes["set-title"]) as SetTitlePush | undefined;
  const statusPush = useExtensionUIStore((state) => state.dataPushes["set-status"]) as SetStatusPush | undefined;

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

  useEffect(() => {
    void loadCommands();
  }, [loadCommands]);

  useEffect(() => {
    return desktopApi().onExtensionUIRequest(handleExtensionUIRequest);
  }, [handleExtensionUIRequest]);

  // Extension-set window title (issue #137): the real OS title is set
  // directly in the main process; this mirrors it into the in-app header,
  // falling back to the default app name when no extension has called
  // `setTitle()` yet.
  const title = titlePush?.title ?? "Pi Desktop";

  // Extension status area (issue #138): `set-status` pushes are keyed by
  // `key`, and the store only retains the single most recent push overall,
  // so multiple concurrent status keys are accumulated locally here.
  // `text: undefined` clears that key's status.
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!statusPush) return;
    setStatuses((prev) => {
      if (statusPush.text === undefined) {
        if (!(statusPush.key in prev)) return prev;
        const next = { ...prev };
        delete next[statusPush.key];
        return next;
      }
      return { ...prev, [statusPush.key]: statusPush.text };
    });
  }, [statusPush]);

  // Extension keyboard shortcuts (issue #142): the list is fetched once on
  // mount -- currently always empty upstream (see handoff notes) -- and
  // every real keydown is normalized and checked against it.
  useEffect(() => {
    let shortcuts: ShortcutInfo[] = [];
    let cancelled = false;
    void desktopApi()
      .listShortcuts()
      .then((list) => {
        if (!cancelled) shortcuts = list;
      });

    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcuts.length === 0) return;
      const combo = normalizeShortcutEvent(event);
      const match = shortcuts.find((shortcut) => shortcut.keys === combo);
      if (!match) return;
      event.preventDefault();
      void desktopApi().triggerShortcut(match.id);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-surface text-white">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-surface-border px-6 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold tracking-wide text-white/80">{title}</span>
            {Object.keys(statuses).length > 0 && (
              <div className="flex items-center gap-3 text-xs text-white/50">
                {Object.entries(statuses).map(([key, text]) => (
                  <span key={key}>
                    {key}: {text}
                  </span>
                ))}
              </div>
            )}
          </div>
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
      <SelectDialog />
      <ConfirmDialog />
      <InputDialog />
      <NotificationToast />
    </div>
  );
}
