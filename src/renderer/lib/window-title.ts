// User-configurable in-app header title (issue #251): persisted via
// localStorage (Chromium-managed, no fs code, no IPC), mirroring the
// existing theme (AppShell.tsx/theme-init.ts) and zoom (zoom.ts) patterns.
// This only affects the in-app header label rendered by AppShell -- it does
// not change the real OS window title (see src/main/windows.ts).
export const DEFAULT_WINDOW_TITLE = "Pi Desktop";

const STORAGE_KEY = "windowTitle";

// Cross-component notification so AppShell's header updates live the moment
// SettingsDialog changes the title, without a reload or prop drilling.
export const WINDOW_TITLE_CHANGE_EVENT = "window-title-changed";

export function getStoredTitle(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && stored.trim() ? stored : DEFAULT_WINDOW_TITLE;
}

export function setStoredTitle(title: string): void {
  const trimmed = title.trim();
  if (!trimmed) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, trimmed);
  }
  window.dispatchEvent(new CustomEvent(WINDOW_TITLE_CHANGE_EVENT));
}
