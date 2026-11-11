# Draftline

A job application assistant that runs on your own machine. It keeps your profile and saved answers, fills Greenhouse and Lever applications from them, and can use AI to check your fit for a job and draft answers to open questions. You review everything and submit applications yourself.

## Run it

Requires Node 24 or later (the project uses 26; run `nvm use`) and pnpm.

```bash
pnpm install
pnpm dev
```

Open http://127.0.0.1:5173 and choose an AI provider under **AI settings**. Draftline works with Claude and any API that follows OpenAI's chat completions format, including OpenAI, Gemini, OpenRouter, Groq, and Ollama.

Your profile and API key are stored in `data/draftline.db`, which is ignored by git. Importing a resume sends it to the provider you chose: Claude receives the PDF, and other providers receive its text.

## Install the Chrome extension

```bash
pnpm --filter @draftline/extension build
```

In Chrome, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. Click the Draftline toolbar icon on a Greenhouse or Lever application page to open the side panel. Reload any application page that was already open.

Draftline fills only the fields you leave ticked. It never submits an application.

## How the code fits together

```
Chrome extension (apps/extension)          Local server (apps/server, port 8787)
  side panel  ── fetch /api/... ──────────▶  app.ts      routes
     │                                       store.ts    SQLite database in data/
     │ messages                              ai.ts       picks the AI provider
     ▼                                       jobs.ts     fit check and drafts
  content script (inside the job page)       claude.ts / openai-compatible.ts
     detect.ts  reads the form and job              ▲
     fill.ts    fills the fields                     │ fetch /api/... (via Vite proxy)
                                             Web app (apps/web, port 5173)
                                               Profile, Saved answers, AI settings
```

- Rule-based filling (`apps/extension/src/match.ts`) runs without AI.
- AI calls always go through the local server, which holds the API key.
- Types and schemas shared by all three parts live in `packages/shared`.

Each source file starts with a comment explaining its job; start with
`apps/server/src/app.ts` and `apps/extension/src/content.ts`.

## Layout

- `apps/extension`: Chrome extension for Greenhouse and Lever
- `apps/web`: React app
- `apps/server`: local API, SQLite storage, Claude calls
- `packages/shared`: schemas and types used by both

## Checks

```bash
pnpm test
pnpm typecheck
```
