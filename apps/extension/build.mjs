/**
 * Builds the extension into dist/. It bundles the service worker, content script
 * and side panel with esbuild, and copies manifest.json, the panel's HTML and
 * the icons.
 * `--watch` rebuilds on every change. Load dist/ in chrome://extensions.
 */
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
copyFileSync("src/sidepanel/index.html", "dist/sidepanel.html");
cpSync("icons", "dist/icons", { recursive: true });

const options = {
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    sidepanel: "src/sidepanel/main.tsx",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
