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
        },
        accent: {
          DEFAULT: "#7c9cff",
        },
      },
    },
  },
  plugins: [],
};
