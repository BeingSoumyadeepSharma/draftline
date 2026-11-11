/**
 * The local HTTP API, built with Hono. Only two callers are allowed: the web
 * app (through Vite's proxy) and Draftline's own Chrome extension.
 *
 * Route groups:
 *   /api/status, /api/settings/ai   whether AI is set up, and its settings
 *   /api/profile                    the profile, as one JSON document
 *   /api/resume/*                   resume import (AI) and the stored PDF
 *   /api/jobs/*                     job fit analysis and answer drafts (AI)
 *   /api/answers                    saved answers to common questions
 *
 * createApp receives its dependencies (database, AI service) as arguments, so
 * tests can pass an in-memory database and a fake AI.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AiSettingsInputSchema,
  DraftRequestSchema,
  JobInputSchema,
  AnswerInputSchema,
  EXTENSION_ID,
  ProfileSchema,
  type AiSettingsView,
  type ApiError,
  type AnswerDraft,
  type JobRecord,
  type ResumeFileMeta,
  type ResumeFilePayload,
  type ResumeParseResult,
  type Status,
} from "@draftline/shared";
import { aiSettingsView, type AiService } from "./ai.js";
import { AiError } from "./ai-error.js";
import { analyzeJob, buildFacts, draftAnswers } from "./jobs.js";
import type { JobRow, Store } from "./store.js";

export const SERVER_PORT = 8787;
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${SERVER_PORT}`,
  `localhost:${SERVER_PORT}`,
]);
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  `chrome-extension://${EXTENSION_ID}`,
]);

const resumeBodyLimit = bodyLimit({
  maxSize: MAX_RESUME_BYTES,
  onError: (c) => c.json({ error: "Resume must be under 10 MB" }, 413),
});

async function readPdfUpload(
  c: Context,
): Promise<{ name: string; pdf: Buffer } | { error: string }> {
  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file;
  if (!(file instanceof File)) return { error: "Choose a PDF file" };
  const pdf = Buffer.from(await file.arrayBuffer());
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { error: "That file isn't a PDF" };
  }
  return { name: file.name, pdf };
}

type Deps = {
  store: Store;
  ai: AiService;
  hasEnvClaudeKey: () => boolean;
};

export function createApp({ store, ai, hasEnvClaudeKey }: Deps) {
  const aiView = () => aiSettingsView(store, hasEnvClaudeKey());
  const app = new Hono();
  const fail = (error: string): ApiError => ({ error });

  // This API holds personal data on localhost, where any open website can try
  // to reach it. Checking Host stops DNS rebinding; checking Origin stops
  // cross-site requests.
  app.use("/api/*", async (c, next) => {
    const host = c.req.header("host");
    const origin = c.req.header("origin");
    if (!host || !ALLOWED_HOSTS.has(host)) {
      return c.json(fail("Host not allowed"), 403);
    }
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return c.json(fail("Origin not allowed"), 403);
    }
    await next();
  });

  // Whether an AI provider is ready. Both UIs use it to enable AI buttons.
  app.get("/api/status", (c) =>
    c.json<Status>({ aiConfigured: aiView().configured }),
  );

  // AI settings. The response never includes the API key itself.
  app.get("/api/settings/ai", (c) => c.json<AiSettingsView>(aiView()));

  app.put("/api/settings/ai", async (c) => {
    const parsed = AiSettingsInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        fail(parsed.error.issues[0]?.message ?? "Invalid settings"),
        400,
      );
    }
    store.saveAiConfig(parsed.data);
    return c.json<AiSettingsView>(aiView());
  });

  // The profile is always read and replaced as a whole.
  app.get("/api/profile", (c) => c.json(store.getProfile()));

  app.put("/api/profile", async (c) => {
    const parsed = ProfileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail("Invalid profile"), 400);
    store.saveProfile(parsed.data);
    return c.json(parsed.data);
  });

  // Returns a draft only. Nothing is stored until the user reviews and saves.
  app.post(
    "/api/resume/parse",
    resumeBodyLimit,
    async (c) => {
      if (!aiView().configured) {
        return c.json(fail("Set up an AI provider in AI settings first."), 503);
      }

      const upload = await readPdfUpload(c);
      if ("error" in upload) return c.json(fail(upload.error), 400);

      try {
        const profile = await ai.parseResume(upload.pdf);
        return c.json<ResumeParseResult>({ profile });
      } catch (error) {
        if (error instanceof AiError) {
          return c.json(fail(error.message), error.status);
        }
        throw error;
      }
    },
  );

  // The resume PDF the extension attaches to applications.
  app.get("/api/resume/meta", (c) =>
    c.json<ResumeFileMeta | null>(store.getResumeMeta()),
  );

  app.get("/api/resume/file", (c) => {
    const file = store.getResumeFile();
    if (!file) return c.json(fail("No resume file saved"), 404);
    return c.json<ResumeFilePayload>({
      name: file.name,
      base64: Buffer.from(file.data).toString("base64"),
    });
  });

  app.put("/api/resume/file", resumeBodyLimit, async (c) => {
    const upload = await readPdfUpload(c);
    if ("error" in upload) return c.json(fail(upload.error), 400);
    return c.json<ResumeFileMeta>(
      store.saveResumeFile(upload.name, upload.pdf),
    );
  });

  // --- Jobs: fit analysis and answer drafts ---

  // Database row to API shape: the stored analysis JSON is parsed here.
  const toRecord = (row: JobRow): JobRecord => ({
    id: row.id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    analysis: row.analysis ? JSON.parse(row.analysis) : null,
    analyzedAt: row.analyzedAt,
  });

  const jsonBodyLimit = bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json(fail("Request is too large"), 413),
  });

  const aiFailure = (c: Context, error: unknown) => {
    if (error instanceof AiError) return c.json(fail(error.message), error.status);
    throw error;
  };

  // The saved job for a page URL, so the panel can show an earlier analysis
  // without paying for a new one.
  app.get("/api/jobs/lookup", (c) => {
    const row = store.findJobByUrl(c.req.query("url") ?? "");
    return c.json<JobRecord | null>(row ? toRecord(row) : null);
  });

  // Saves the job and returns the cached analysis, or runs one when asked.
  app.post("/api/jobs/analyze", jsonBodyLimit, async (c) => {
    const parsed = JobInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(fail("Draftline couldn't read enough of the job description."), 400);
    }
    if (!aiView().configured) {
      return c.json(fail("Set up an AI provider in AI settings first."), 503);
    }
    const row = store.upsertJob(parsed.data);
    // Drafting answers needs the job saved, but not a fit check.
    if (c.req.query("save_only") === "1") {
      return c.json<JobRecord>(toRecord(row));
    }
    if (row.analysis && c.req.query("refresh") !== "1") {
      return c.json<JobRecord>(toRecord(row));
    }
    try {
      const result = await analyzeJob(
        ai.generate,
        buildFacts(store.getProfile(), store.listAnswers()),
        parsed.data,
      );
      return c.json<JobRecord>(
        toRecord(store.saveJobAnalysis(row.id, result, result.analysis)),
      );
    } catch (error) {
      return aiFailure(c, error);
    }
  });

  // Drafts answers to the form's open questions. jobs.ts refuses sensitive
  // ones and checks every draft before it's returned.
  app.post("/api/jobs/:id/answers", jsonBodyLimit, async (c) => {
    const row = store.getJob(c.req.param("id"));
    if (!row) return c.json(fail("Job not found"), 404);
    const parsed = DraftRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail("Invalid questions"), 400);
    if (!aiView().configured) {
      return c.json(fail("Set up an AI provider in AI settings first."), 503);
    }
    try {
      const answers = await draftAnswers(
        ai.generate,
        buildFacts(store.getProfile(), store.listAnswers()),
        row,
        parsed.data.questions,
      );
      return c.json<{ answers: AnswerDraft[] }>({ answers });
    } catch (error) {
      return aiFailure(c, error);
    }
  });

  // --- Saved answers: list, add, edit, delete ---
  app.get("/api/answers", (c) => c.json(store.listAnswers()));

  app.post("/api/answers", async (c) => {
    const parsed = AnswerInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json(fail("Invalid answer"), 400);
    return c.json(store.createAnswer(parsed.data), 201);
  });

  app.put("/api/answers/:id", async (c) => {
    const parsed = AnswerInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json(fail("Invalid answer"), 400);
    const updated = store.updateAnswer(c.req.param("id"), parsed.data);
    return updated ? c.json(updated) : c.json(fail("Answer not found"), 404);
  });

  app.delete("/api/answers/:id", (c) =>
    store.deleteAnswer(c.req.param("id"))
      ? c.body(null, 204)
      : c.json(fail("Answer not found"), 404),
  );

  // Anything unexpected: log the details here, show the user a plain message.
  app.onError((error, c) => {
    console.error(error);
    return c.json(fail("Something went wrong on the server"), 500);
  });

  return app;
}
