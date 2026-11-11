/**
 * The local HTTP API, built with Hono. Only two callers are allowed: the web
 * app (through Vite's proxy) and Draftline's own Chrome extension.
 *
 * Route groups:
 *   /api/status, /api/settings/ai   whether AI is set up, and its settings
 *   /api/profile                    the profile, as one JSON document
 *   /api/resume/*                   resume import (AI) and the stored PDF
 *   /api/jobs/*                     job fit analysis and answer drafts (AI),
 *                                   and tailored resume / cover letter PDFs
 *   /api/jobs/:id/tracking, ...     application status, follow-ups, timeline
 *   /api/discovery/*                job boards to watch and the ranked shortlist
 *   /api/answers                    saved answers to common questions
 *
 * createApp receives its dependencies (database, AI service) as arguments, so
 * tests can pass an in-memory database and a fake AI.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AddSourceSchema,
  AiSettingsInputSchema,
  CoverLetterSchema,
  DiscoveryPreferencesSchema,
  DocumentKindSchema,
  DraftRequestSchema,
  JobInputSchema,
  MarkAppliedSchema,
  AnswerInputSchema,
  EXTENSION_ID,
  ProfileSchema,
  type AiSettingsView,
  type ApiError,
  TailoredResumeSchema,
  TrackingUpdateSchema,
  type AnswerDraft,
  type DiscoveryState,
  type DocumentKind,
  type JobDocuments,
  type JobEvent,
  type JobListItem,
  type JobRecord,
  type ResumeFileMeta,
  type ResumeFilePayload,
  type ResumeParseResult,
  type Status,
} from "@draftline/shared";
import { aiSettingsView, type AiService } from "./ai.js";
import { AiError } from "./ai-error.js";
import { fetchBoard, parseBoardUrl } from "./boards.js";
import { discoveryDeps, isDiscoveryRunning, runDiscovery } from "./discovery.js";
import { cleanTailoredResume, draftCoverLetter, tailorResume } from "./documents.js";
import { analyzeJob, buildFacts, draftAnswers } from "./jobs.js";
import { documentFileName, renderCoverLetter, renderResume } from "./pdf.js";
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
  /** For tests: replaces the network when reading job boards. */
  fetchBoards?: typeof fetch;
};

export function createApp({ store, ai, hasEnvClaudeKey, fetchBoards }: Deps) {
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
    status: row.status,
    appliedAt: row.appliedAt,
    followUpAt: row.followUpAt,
    notes: row.notes,
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
    const row = store.upsertJob(parsed.data);
    // Saving a job (for tracking, drafts and documents) needs no AI.
    if (c.req.query("save_only") === "1") {
      return c.json<JobRecord>(toRecord(row));
    }
    if (!aiView().configured) {
      return c.json(fail("Set up an AI provider in AI settings first."), 503);
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

  // --- Tailored documents (Phase 4) ---
  // Flow: generate a draft with AI, let the user edit and preview it, then
  // approve it, which stores the PDF the extension attaches for this job.

  app.get("/api/jobs", (c) => c.json<JobListItem[]>(store.listJobs()));

  app.get("/api/jobs/:id", (c) => {
    const row = store.getJob(c.req.param("id"));
    return row ? c.json<JobRecord>(toRecord(row)) : c.json(fail("Job not found"), 404);
  });

  app.get("/api/jobs/:id/documents", (c) => {
    if (!store.getJob(c.req.param("id"))) return c.json(fail("Job not found"), 404);
    return c.json<JobDocuments>(store.getDocuments(c.req.param("id")));
  });

  /** Reads :id and :kind; `error` is the response to send when either is wrong. */
  type DocumentTarget =
    | { error: Response }
    | { error: null; row: JobRow; kind: DocumentKind };
  const documentTarget = (c: Context): DocumentTarget => {
    const row = store.getJob(c.req.param("id") ?? "");
    const kind = DocumentKindSchema.safeParse(c.req.param("kind"));
    if (!row) return { error: c.json(fail("Job not found"), 404) };
    if (!kind.success) return { error: c.json(fail("Unknown document type"), 400) };
    return { error: null, row, kind: kind.data };
  };

  // Builds the PDF from the current draft and the current profile.
  const renderDocument = async (row: JobRow, kind: DocumentKind) => {
    const profile = store.getProfile();
    const documents = store.getDocuments(row.id);
    if (kind === "resume") {
      if (!documents.resume) return null;
      return {
        pdf: await renderResume(profile, cleanTailoredResume(profile, documents.resume.content)),
        fileName: documentFileName(profile.contact.fullName, "Resume", row.company),
      };
    }
    if (!documents.coverLetter) return null;
    return {
      pdf: await renderCoverLetter(profile, row.company, documents.coverLetter.content),
      fileName: documentFileName(profile.contact.fullName, "Cover letter", row.company),
    };
  };

  // Asks the AI for a new draft, replacing any earlier draft or approval.
  app.post("/api/jobs/:id/documents/:kind/generate", async (c) => {
    const target = documentTarget(c);
    if (target.error) return target.error;
    if (!aiView().configured) {
      return c.json(fail("Set up an AI provider in AI settings first."), 503);
    }
    const profile = store.getProfile();
    const facts = buildFacts(profile, store.listAnswers());
    try {
      const draft =
        target.kind === "resume"
          ? await tailorResume(ai.generate, facts, profile, target.row)
          : await draftCoverLetter(ai.generate, facts, target.row);
      store.saveDocumentDraft(target.row.id, target.kind, draft);
      return c.json<JobDocuments>(store.getDocuments(target.row.id));
    } catch (error) {
      return aiFailure(c, error);
    }
  });

  // Saves the user's edits to a draft.
  app.put("/api/jobs/:id/documents/:kind", jsonBodyLimit, async (c) => {
    const target = documentTarget(c);
    if (target.error) return target.error;
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    let content;
    if (target.kind === "resume") {
      const parsed = TailoredResumeSchema.safeParse(body?.content);
      if (!parsed.success) return c.json(fail("Invalid resume"), 400);
      content = cleanTailoredResume(store.getProfile(), parsed.data);
    } else {
      const parsed = CoverLetterSchema.safeParse(body?.content);
      if (!parsed.success) return c.json(fail("Invalid cover letter"), 400);
      content = parsed.data;
    }
    if (!store.updateDocumentContent(target.row.id, target.kind, content)) {
      return c.json(fail("Create this document first"), 404);
    }
    return c.json<JobDocuments>(store.getDocuments(target.row.id));
  });

  // Shows the current draft as a PDF, without approving it.
  app.get("/api/jobs/:id/documents/:kind/preview", async (c) => {
    const target = documentTarget(c);
    if (target.error) return target.error;
    const rendered = await renderDocument(target.row, target.kind);
    if (!rendered) return c.json(fail("Create this document first"), 404);
    return c.body(new Uint8Array(rendered.pdf), 200, {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(rendered.fileName)}`,
    });
  });

  // Approving stores the PDF; the extension attaches it to this job's form.
  app.post("/api/jobs/:id/documents/:kind/approve", async (c) => {
    const target = documentTarget(c);
    if (target.error) return target.error;
    const rendered = await renderDocument(target.row, target.kind);
    if (!rendered) return c.json(fail("Create this document first"), 404);
    store.approveDocument(target.row.id, target.kind, rendered.fileName, rendered.pdf);
    return c.json<JobDocuments>(store.getDocuments(target.row.id));
  });

  // The approved PDF, for the extension to attach.
  app.get("/api/jobs/:id/documents/:kind/file", (c) => {
    const target = documentTarget(c);
    if (target.error) return target.error;
    const file = store.getApprovedFile(target.row.id, target.kind);
    if (!file) return c.json(fail("This document isn't approved yet"), 404);
    return c.json<ResumeFilePayload>({
      name: file.name,
      base64: Buffer.from(file.data).toString("base64"),
    });
  });

  // --- Application tracking (Phase 6) ---

  // Status, follow-up date and notes, from the tracker or the side panel.
  app.patch("/api/jobs/:id/tracking", jsonBodyLimit, async (c) => {
    const parsed = TrackingUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(fail(parsed.error.issues[0]?.message ?? "Invalid change"), 400);
    }
    const row = store.updateTracking(c.req.param("id"), parsed.data);
    return row ? c.json<JobRecord>(toRecord(row)) : c.json(fail("Job not found"), 404);
  });

  // Called by the "Mark as applied" button, and by the extension when it sees
  // a site's confirmation page after the user submitted.
  app.post("/api/jobs/applied", jsonBodyLimit, async (c) => {
    const parsed = MarkAppliedSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail("Invalid job"), 400);
    return c.json<JobRecord>(toRecord(store.markApplied(parsed.data)));
  });

  app.get("/api/jobs/:id/events", (c) => {
    if (!store.getJob(c.req.param("id"))) return c.json(fail("Job not found"), 404);
    return c.json<JobEvent[]>(store.listEvents(c.req.param("id")));
  });

  // How many follow-ups are due today or overdue, for the extension's badge.
  app.get("/api/tracker/due", (c) => c.json({ count: store.countDueFollowUps() }));

  // --- Job discovery (Phase 7) ---

  const discoveryState = (): DiscoveryState => {
    const run = store.getDiscoveryRun();
    return {
      preferences: store.getDiscoveryPreferences(),
      sources: store.listSources(),
      jobs: store.listDiscovered(),
      lastRunAt: run.lastRunAt,
      lastRunSummary: run.lastSummary,
      running: isDiscoveryRunning(),
    };
  };
  const refresh = () =>
    runDiscovery(store, discoveryDeps(store, ai, hasEnvClaudeKey, fetchBoards));

  app.get("/api/discovery", (c) => c.json<DiscoveryState>(discoveryState()));

  app.put("/api/discovery/preferences", jsonBodyLimit, async (c) => {
    const parsed = DiscoveryPreferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(fail("Invalid preferences"), 400);
    store.saveDiscoveryPreferences(parsed.data);
    return c.json<DiscoveryState>(discoveryState());
  });

  // Adds a company's job board after checking that it can be read, then
  // refreshes so its jobs appear straight away.
  app.post("/api/discovery/sources", jsonBodyLimit, async (c) => {
    const parsed = AddSourceSchema.safeParse(await c.req.json().catch(() => null));
    const board = parsed.success ? parseBoardUrl(parsed.data.url) : null;
    if (!board) {
      return c.json(
        fail("Paste a Greenhouse, Lever or Ashby job board address, like jobs.lever.co/company."),
        400,
      );
    }
    try {
      await fetchBoard(board, fetchBoards);
    } catch (error) {
      return c.json(fail((error as Error).message), 400);
    }
    store.addSource(board.kind, board.slug, board.url);
    await refresh();
    return c.json<DiscoveryState>(discoveryState());
  });

  app.delete("/api/discovery/sources/:id", (c) =>
    store.removeSource(c.req.param("id"))
      ? c.json<DiscoveryState>(discoveryState())
      : c.json(fail("Board not found"), 404),
  );

  app.post("/api/discovery/refresh", async (c) => {
    await refresh();
    return c.json<DiscoveryState>(discoveryState());
  });

  // Copies a posting into Applications, where the tracker and extension use it.
  app.post("/api/discovery/jobs/:id/save", (c) => {
    const found = store.getDiscovered(c.req.param("id"));
    if (!found) return c.json(fail("Job not found"), 404);
    const job = store.upsertJob({
      url: found.url,
      title: found.title,
      company: found.company,
      location: found.location,
      description: found.description,
    });
    store.setDiscoveredStatus(found.id, "saved", job.id);
    return c.json({ jobId: job.id, state: discoveryState() });
  });

  app.post("/api/discovery/jobs/:id/dismiss", (c) => {
    if (!store.getDiscovered(c.req.param("id"))) return c.json(fail("Job not found"), 404);
    store.setDiscoveredStatus(c.req.param("id"), "dismissed");
    return c.json<DiscoveryState>(discoveryState());
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
