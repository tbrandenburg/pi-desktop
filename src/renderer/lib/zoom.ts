// Global UI zoom (issue #232): scales `html { font-size }` so Tailwind's
// rem-based utilities (text-xs, text-sm, ...) scale proportionally with
// zero per-component changes. Persisted via localStorage (Chromium-managed,
// no fs code, no IPC), mirroring the existing theme toggle pattern.
export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 2.0;
export const ZOOM_STEP = 0.1;
export const DEFAULT_ZOOM = 1.0;

const BASE_FONT_SIZE_PX = 16;

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function getZoom(): number {
  const stored = Number(localStorage.getItem("zoom"));
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_ZOOM;
  return clamp(stored);
}

export function applyZoom(zoom: number): void {
  document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * zoom}px`;
}

export function setZoom(zoom: number): void {
  const clamped = clamp(zoom);
  localStorage.setItem("zoom", String(clamped));
  applyZoom(clamped);
}
