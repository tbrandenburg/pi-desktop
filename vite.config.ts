import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [tailwindcss(), react()],
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
