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
import { discoveryDeps, isDiscoveryRunning, isRunDue, runDiscovery } from "./discovery.js";
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

// Job discovery checks the boards on the user's chosen interval (every 15
// minutes by default) while the server runs. A once-a-minute tick decides
// whether a check is due, so interval changes apply without a restart.
function refreshDiscoveryIfDue() {
  const { lastRunAt } = store.getDiscoveryRun();
  if (isDiscoveryRunning()) return;
  if (store.listSources().length === 0 && store.listSearches().length === 0) return;
  if (!isRunDue(lastRunAt, store.getDiscoveryPreferences().refreshMinutes)) return;
  runDiscovery(store, discoveryDeps(store, ai, hasEnvClaudeKey))
    .then((summary) => console.log(`Job discovery: ${summary}`))
    .catch((error) => console.error("Job discovery failed:", error));
}
setTimeout(refreshDiscoveryIfDue, 15_000);
setInterval(refreshDiscoveryIfDue, 60_000);

// Only this computer may connect. In Docker, HOST is 0.0.0.0 so the port can
// be forwarded, and compose.yaml publishes it on 127.0.0.1 only.
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, hostname, port: SERVER_PORT }, () => {
  console.log(`Draftline API running on http://${hostname}:${SERVER_PORT}`);
});
