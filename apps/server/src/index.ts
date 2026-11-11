import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { createApp, SERVER_PORT } from "./app.js";
import { parseResumeWithClaude } from "./resume.js";
import { createStore } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const app = createApp({
  store: createStore(path.join(dataDir, "draftline.db")),
  parseResume: parseResumeWithClaude,
  isAiConfigured: () =>
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
});

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: SERVER_PORT }, () => {
  console.log(`Draftline API running on http://127.0.0.1:${SERVER_PORT}`);
});
