import type { DesktopAgentApi } from "../shared/events";

declare global {
  interface Window {
    desktopApi: DesktopAgentApi;
  }
}

export {};
