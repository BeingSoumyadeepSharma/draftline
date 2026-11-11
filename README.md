# Draftline

A job application assistant that runs on your own machine. Phase 1 covers your profile, resume import, and saved answers.

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
