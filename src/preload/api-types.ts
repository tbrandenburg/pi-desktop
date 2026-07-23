import type { DesktopLLMApi } from "../shared/events";

declare global {
  interface Window {
    desktopApi: DesktopLLMApi;
  }
}

export {};
