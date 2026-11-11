import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AnswerInputSchema,
  ProfileSchema,
  type ApiError,
  type Profile,
  type ResumeParseResult,
  type Status,
} from "@draftline/shared";
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
]);

type Deps = {
  store: Store;
  parseResume: (pdf: Buffer) => Promise<Profile>;
  isAiConfigured: () => boolean;
};

export function createApp({ store, parseResume, isAiConfigured }: Deps) {
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
    c.json<Status>({ aiConfigured: isAiConfigured() }),
  );

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
    bodyLimit({
      maxSize: MAX_RESUME_BYTES,
      onError: (c) => c.json(fail("Resume must be under 10 MB"), 413),
    }),
    async (c) => {
      if (!isAiConfigured()) {
        return c.json(
          fail("Add ANTHROPIC_API_KEY to .env and restart the app."),
          503,
        );
      }

      const body = await c.req.parseBody().catch(() => null);
      const file = body?.file;
      if (!(file instanceof File)) {
        return c.json(fail("Choose a PDF file to import"), 400);
      }

      const pdf = Buffer.from(await file.arrayBuffer());
      if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return c.json(fail("That file isn't a PDF"), 400);
      }

      try {
        const profile = await parseResume(pdf);
        return c.json<ResumeParseResult>({ profile });
      } catch (error) {
        if (error instanceof ResumeParseError) {
          return c.json(fail(error.message), error.status);
        }
        throw error;
      }
    },
  );

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
