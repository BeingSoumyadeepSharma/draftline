import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AiSettingsInputSchema,
  AnswerInputSchema,
  EXTENSION_ID,
  ProfileSchema,
  type AiSettingsView,
  type ApiError,
  type Profile,
  type ResumeFileMeta,
  type ResumeFilePayload,
  type ResumeParseResult,
  type Status,
} from "@draftline/shared";
import { aiSettingsView } from "./ai.js";
import { ResumeParseError } from "./resume.js";
import type { Store } from "./store.js";

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
  parseResume: (pdf: Buffer) => Promise<Profile>;
  hasEnvClaudeKey: () => boolean;
};

export function createApp({ store, parseResume, hasEnvClaudeKey }: Deps) {
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

  app.get("/api/status", (c) =>
    c.json<Status>({ aiConfigured: aiView().configured }),
  );

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
        const profile = await parseResume(upload.pdf);
        return c.json<ResumeParseResult>({ profile });
      } catch (error) {
        if (error instanceof ResumeParseError) {
          return c.json(fail(error.message), error.status);
        }
        throw error;
      }
    },
  );

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

  app.onError((error, c) => {
    console.error(error);
    return c.json(fail("Something went wrong on the server"), 500);
  });

  return app;
}
