/**
 * Web app server. `pnpm dev` runs Vite's dev server; `pnpm start` (used by the
 * Docker image) serves the production build with `vite preview`. Both listen
 * on port 5173 and forward /api requests to the local server on port 8787, so
 * the browser sees one origin.
 *
 * Both bind to 127.0.0.1 only. In Docker, HOST is 0.0.0.0 so the port can be
 * forwarded, and compose.yaml publishes it on 127.0.0.1 only.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.HOST ?? "127.0.0.1";
const proxy = {
  "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  server: { host, port: 5173, strictPort: true, proxy },
  preview: { host, port: 5173, strictPort: true, proxy },
});
