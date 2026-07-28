// Pre-paint theme application to avoid a flash of the wrong theme (FOUC).
//
// This runs as the very first import in main.tsx (before styles.css and before
// React mounts), so <html data-theme> is set before the stylesheet drives the
// first paint of body bg/text. A CSP-safe module (the renderer's CSP uses
// script-src 'self', which blocks inline <script> in index.html) — so the
// pre-paint hook lives here rather than as an inline script.
//
// Default dark: any value other than the literal "light" resolves to dark,
// which also covers first launch (no stored key) and corrupted values.
const stored = localStorage.getItem("theme");
document.documentElement.dataset.theme = stored === "light" ? "light" : "dark";
