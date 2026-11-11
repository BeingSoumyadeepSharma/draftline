/**
 * Server entry point. Loads .env, opens the SQLite database in data/, connects
 * the AI service to the HTTP app, and starts listening.
 *
 * It binds to 127.0.0.1 only, so nothing outside this computer can reach it.
 * Run it with `pnpm dev` from the project root (together with the web app).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { createAi } from "./ai.js";
import { createApp, SERVER_PORT } from "./app.js";
import { discoveryDeps, runDiscovery } from "./discovery.js";
import { createStore } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: path.join(root, ".env"), quiet: true });

const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

const store = createStore(path.join(dataDir, "draftline.db"));

const ai = createAi(store);
const hasEnvClaudeKey = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const app = createApp({ store, ai, hasEnvClaudeKey });

// Job discovery refreshes once a day while the server runs: checked hourly,
// and soon after startup in case the computer was off at the usual time.
const DAY_MS = 24 * 60 * 60 * 1000;
function refreshDiscoveryIfDue() {
  const { lastRunAt } = store.getDiscoveryRun();
  if (store.listSources().length === 0) return;
  if (lastRunAt && Date.now() - Date.parse(lastRunAt) < DAY_MS) return;
  runDiscovery(store, discoveryDeps(store, ai, hasEnvClaudeKey))
    .then((summary) => console.log(`Job discovery: ${summary}`))
    .catch((error) => console.error("Job discovery failed:", error));
}
setTimeout(refreshDiscoveryIfDue, 15_000);
setInterval(refreshDiscoveryIfDue, 60 * 60 * 1000);

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: SERVER_PORT }, () => {
  console.log(`Draftline API running on http://127.0.0.1:${SERVER_PORT}`);
});
