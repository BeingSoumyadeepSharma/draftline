# Draftline

A job application assistant that runs on your own machine. Phase 1 covers your profile, resume import, and saved answers.

## Run it

Requires Node 20.19 or later and pnpm.

```bash
pnpm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY
pnpm dev
```

Open http://127.0.0.1:5173.

Your profile is stored in `data/draftline.db`. That folder and `.env` are ignored by git. Resume import sends the PDF to the Claude API.

## Layout

- `apps/web`: React app
- `apps/server`: local API, SQLite storage, Claude calls
- `packages/shared`: schemas and types used by both

## Checks

```bash
pnpm test
pnpm typecheck
```
