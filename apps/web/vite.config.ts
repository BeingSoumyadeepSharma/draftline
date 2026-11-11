/**
 * Dev server for the web app. It binds to 127.0.0.1 only, and forwards /api
 * requests to the local server on port 8787, so the browser sees one origin.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
