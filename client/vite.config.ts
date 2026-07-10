import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is built into ../agent/public so the daemon serves it same-origin.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../agent/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});
