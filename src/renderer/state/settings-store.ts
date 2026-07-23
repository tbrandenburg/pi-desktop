import { create } from "zustand";
import type { ProviderSettingsSummary } from "../../shared/events";
import { desktopApi } from "../lib/desktop-api";

interface SettingsState {
  summary: ProviderSettingsSummary | null;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  refresh: () => Promise<void>;
  save: (apiKey: string, baseUrl: string, model: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  summary: null,
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  refresh: async () => {
    const summary = await desktopApi().getProviderSettings();
    set({ summary });
  },
  save: async (apiKey: string, baseUrl: string, model: string) => {
    await desktopApi().saveProviderSettings({ apiKey, baseUrl, model });
    const summary = await desktopApi().getProviderSettings();
    set({ summary, isOpen: false });
  },
}));
