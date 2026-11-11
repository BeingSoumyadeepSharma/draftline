/**
 * Every read and write to the SQLite database (data/draftline.db), using
 * Node's built-in node:sqlite module.
 *
 * Tables (created on startup if missing):
 *   profile      one row: the whole profile as JSON
 *   answers      saved answers to common application questions
 *   resume_file  one row: the PDF the extension attaches
 *   jobs         jobs the user has opened, with any saved AI fit analysis
 *   ai_settings  one row: the chosen AI provider, address, model and key
 *
 * Single-row tables use id = 1. node:sqlite returns plain records, so results
 * are cast to the app's types with `as unknown as`.
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  EMPTY_PROFILE,
  ProfileSchema,
  type AiProvider,
  type AiSettingsInput,
  type Answer,
  type AnswerCategory,
  type JobAnalysis,
  type JobInput,
  type AnswerInput,
  type Profile,
  type ResumeFileMeta,
} from "@draftline/shared";

const STARTER_QUESTIONS: ReadonlyArray<[AnswerCategory, string]> = [
  ["work_authorization", "Are you legally authorized to work in this country?"],
  ["work_authorization", "Will you now or in the future require visa sponsorship?"],
  ["compensation", "What are your salary expectations?"],
  ["demographics", "Gender"],
  ["demographics", "Race / ethnicity"],
  ["demographics", "Veteran status"],
  ["demographics", "Disability status"],
  ["logistics", "What is your notice period or earliest start date?"],
  ["logistics", "Are you willing to relocate?"],
  ["logistics", "Are you open to hybrid or on-site work?"],
  ["general", "How did you hear about this role?"],
];

export type AiConfig = {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
};

/** A saved job as stored: analysis is JSON text. */
export type JobRow = {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  analysis: string | null;
  analyzedAt: string | null;
};

const JOB_COLUMNS =
  "id, url, title, company, location, description, analysis, analyzed_at AS analyzedAt";

export type Store = ReturnType<typeof createStore>;

export function createStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resume_file (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      data BLOB NOT NULL,
      uploaded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      analysis TEXT,
      analyzed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL
    );
  `);

  const readAiConfig = (): AiConfig | null => {
    const row = db
      .prepare(
        "SELECT provider, base_url AS baseUrl, model, api_key AS apiKey FROM ai_settings WHERE id = 1",
      )
      .get() as unknown as AiConfig | undefined;
    return row ?? null;
  };

  const answerCount = db.prepare("SELECT COUNT(*) AS n FROM answers").get() as unknown as {
    n: number;
  };
  if (answerCount.n === 0) {
    const insert = db.prepare(
      "INSERT INTO answers (id, question, answer, category, position) VALUES (?, ?, '', ?, ?)",
    );
    db.exec("BEGIN");
    try {
      STARTER_QUESTIONS.forEach(([category, question], index) => {
        insert.run(randomUUID(), question, category, index);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    /** The saved profile, or an empty one before the first save. */
    getProfile(): Profile {
      const row = db.prepare("SELECT data FROM profile WHERE id = 1").get() as unknown as
        | { data: string }
        | undefined;
      return row ? ProfileSchema.parse(JSON.parse(row.data)) : EMPTY_PROFILE;
    },

    /** Replaces the whole profile. */
    saveProfile(profile: Profile): void {
      db.prepare(
        `INSERT INTO profile (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(profile), new Date().toISOString());
    },

    getResumeMeta(): ResumeFileMeta | null {
      const row = db
        .prepare(
          "SELECT name, uploaded_at AS uploadedAt FROM resume_file WHERE id = 1",
        )
        .get() as unknown as ResumeFileMeta | undefined;
      return row ?? null;
    },

    getResumeFile(): { name: string; data: Uint8Array } | null {
      const row = db
        .prepare("SELECT name, data FROM resume_file WHERE id = 1")
        .get() as unknown as { name: string; data: Uint8Array } | undefined;
      return row ?? null;
    },

    saveResumeFile(name: string, data: Buffer): ResumeFileMeta {
      const uploadedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO resume_file (id, name, data, uploaded_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, data = excluded.data,
           uploaded_at = excluded.uploaded_at`,
      ).run(name, data, uploadedAt);
      return { name, uploadedAt };
    },

    /** The saved AI settings, including the key. Never send this to a browser. */
    getAiConfig: readAiConfig,

    saveAiConfig(input: AiSettingsInput): AiConfig {
      const previous = readAiConfig();
      const isClaude = input.provider === "anthropic";
      const baseUrl = isClaude ? "" : input.baseUrl.replace(/\/+$/, "");
      // A saved key must never be sent to a destination the user just changed.
      const sameDestination =
        previous?.provider === input.provider && previous.baseUrl === baseUrl;
      const config: AiConfig = {
        provider: input.provider,
        baseUrl,
        model: isClaude ? "" : input.model,
        apiKey: input.apiKey || (sameDestination ? previous.apiKey : ""),
      };
      db.prepare(
        `INSERT INTO ai_settings (id, provider, base_url, model, api_key)
         VALUES (1, @provider, @baseUrl, @model, @apiKey)
         ON CONFLICT (id) DO UPDATE SET provider = excluded.provider,
           base_url = excluded.base_url, model = excluded.model,
           api_key = excluded.api_key`,
      ).run(config as unknown as Record<string, SQLInputValue>);
      return config;
    },

    findJobByUrl(url: string): JobRow | null {
      const row = db
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE url = ?`)
        .get(url) as unknown as JobRow | undefined;
      return row ?? null;
    },

    getJob(id: string): JobRow | null {
      const row = db
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`)
        .get(id) as unknown as JobRow | undefined;
      return row ?? null;
    },

    /** Saves the job. A changed description clears any earlier analysis. */
    upsertJob(input: JobInput): JobRow {
      const now = new Date().toISOString();
      const existing = this.findJobByUrl(input.url);
      if (!existing) {
        db.prepare(
          `INSERT INTO jobs (id, url, title, company, location, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), input.url, input.title, input.company, input.location, input.description, now, now);
      } else if (existing.description !== input.description) {
        db.prepare(
          `UPDATE jobs SET title = ?, company = ?, location = ?, description = ?,
             analysis = NULL, analyzed_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(input.title, input.company, input.location, input.description, now, existing.id);
      }
      return this.findJobByUrl(input.url)!;
    },

    saveJobAnalysis(
      id: string,
      details: { title: string; company: string; location: string },
      analysis: JobAnalysis,
    ): JobRow {
      const now = new Date().toISOString();
      // Keep what the page showed; fill gaps from the AI's reading.
      db.prepare(
        `UPDATE jobs SET
           title = CASE WHEN title = '' THEN ? ELSE title END,
           company = CASE WHEN company = '' THEN ? ELSE company END,
           location = CASE WHEN location = '' THEN ? ELSE location END,
           analysis = ?, analyzed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(details.title, details.company, details.location, JSON.stringify(analysis), now, now, id);
      return this.getJob(id)!;
    },

    listAnswers(): Answer[] {
      return db
        .prepare(
          "SELECT id, question, answer, category FROM answers ORDER BY position",
        )
        .all() as unknown as Answer[];
    },

    /** Adds an answer at the end of the list. */
    createAnswer(input: AnswerInput): Answer {
      const answer = { id: randomUUID(), ...input };
      db.prepare(
        `INSERT INTO answers (id, question, answer, category, position)
         VALUES (@id, @question, @answer, @category,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM answers))`,
      ).run(answer as unknown as Record<string, SQLInputValue>);
      return answer;
    },

    updateAnswer(id: string, input: AnswerInput): Answer | null {
      const { changes } = db
        .prepare(
          "UPDATE answers SET question = @question, answer = @answer, category = @category WHERE id = @id",
        )
        .run({ id, ...input });
      return Number(changes) > 0 ? { id, ...input } : null;
    },

    deleteAnswer(id: string): boolean {
      return db.prepare("DELETE FROM answers WHERE id = ?").run(id).changes !== 0;
    },
  };
}
