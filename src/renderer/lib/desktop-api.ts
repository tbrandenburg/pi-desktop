import { createFakeDesktopApi } from "./fake-desktop-api";

export function desktopApi() {
  if (!window.desktopApi) {
    window.desktopApi = createFakeDesktopApi();
  }
  return window.desktopApi;
}
