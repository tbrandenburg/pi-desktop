/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#0f0f11",
          panel: "#17171b",
          border: "rgba(255,255,255,0.08)",
          // Stronger divider for higher-contrast outlines/active states
          // (mirrors omnigent's --border-strong two-tier border system).
          borderStrong: "rgba(255,255,255,0.16)",
          // One shared hover/active wash instead of ad-hoc bg-white/5,
          // bg-white/8, bg-white/10 scattered per component.
          hover: "rgba(255,255,255,0.06)",
        },
        accent: {
          DEFAULT: "#7c9cff",
        },
      },
      // Single base radius, everything else derived — swap one value to
      // restyle every rounded corner in the app (omnigent's --radius-*
      // scale pattern).
      borderRadius: {
        sm: "6px",
        DEFAULT: "10px",
        lg: "10px",
        xl: "14px",
        "2xl": "18px",
      },
      fontFamily: {
        // Native OS UI font, no webfont load (matches both omnigent
        // projects' deliberate zero-webfont-for-UI strategy).
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      transitionTimingFunction: {
        // Slight overshoot for hover/press micro-interactions
        // (omnigent's --ease-otto).
        brand: "cubic-bezier(0.34, 1.4, 0.64, 1)",
      },
    },
  },
  plugins: [],
};
