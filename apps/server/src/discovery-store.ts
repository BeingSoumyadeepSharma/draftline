/**
 * Database tables and queries for job discovery (Phase 7), merged into the
 * main store by store.ts.
 *
 * Tables:
 *   discovery_sources   company job boards to check
 *   discovered_jobs     postings that passed the user's filters, with scores
 *                       and whether they were saved or dismissed
 *   discovery_settings  one row: filters, AI on/off, and the last run
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  BoardKind,
  DiscoveredJob,
  DiscoveryPreferences,
  DiscoverySource,
} from "@draftline/shared";
import type { BoardJob } from "./boards.js";

const DEFAULT_PREFERENCES: DiscoveryPreferences = {
  keywords: [],
  exclude: [],
  locations: [],
  useAi: true,
};

const JOB_COLUMNS = `id, source_id AS sourceId, url, title, company, location,
  posted_at AS postedAt, first_seen_at AS firstSeenAt, rule_score AS ruleScore,
  matched_skills AS matchedSkills, ai_score AS aiScore, ai_reason AS aiReason,
  status, job_id AS jobId`;

type JobRow = Omit<DiscoveredJob, "matchedSkills"> & { matchedSkills: string };
const toJob = ({ matchedSkills, ...row }: JobRow): DiscoveredJob => ({
  ...row,
  matchedSkills: JSON.parse(matchedSkills) as string[],
});

export function createDiscoveryStore(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      last_fetched_at TEXT,
      last_error TEXT,
      job_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (kind, slug)
    );
    CREATE TABLE IF NOT EXISTS discovered_jobs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL,
      posted_at TEXT,
      first_seen_at TEXT NOT NULL,
      rule_score INTEGER NOT NULL,
      matched_skills TEXT NOT NULL,
      ai_score INTEGER,
      ai_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      job_id TEXT
    );
    CREATE TABLE IF NOT EXISTS discovery_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      preferences TEXT NOT NULL,
      last_run_at TEXT,
      last_summary TEXT NOT NULL DEFAULT ''
    );
  `);

  const settingsRow = () =>
    db.prepare("SELECT preferences, last_run_at AS lastRunAt, last_summary AS lastSummary FROM discovery_settings WHERE id = 1").get() as unknown as
      | { preferences: string; lastRunAt: string | null; lastSummary: string }
      | undefined;

  return {
    getDiscoveryPreferences(): DiscoveryPreferences {
      const row = settingsRow();
      return row ? { ...DEFAULT_PREFERENCES, ...JSON.parse(row.preferences) } : DEFAULT_PREFERENCES;
    },

    saveDiscoveryPreferences(preferences: DiscoveryPreferences): void {
      db.prepare(
        `INSERT INTO discovery_settings (id, preferences) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET preferences = excluded.preferences`,
      ).run(JSON.stringify(preferences));
    },

    getDiscoveryRun(): { lastRunAt: string | null; lastSummary: string } {
      const row = settingsRow();
      return { lastRunAt: row?.lastRunAt ?? null, lastSummary: row?.lastSummary ?? "" };
    },

    saveDiscoveryRun(summary: string): void {
      db.prepare(
        `INSERT INTO discovery_settings (id, preferences, last_run_at, last_summary)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET last_run_at = excluded.last_run_at,
           last_summary = excluded.last_summary`,
      ).run(JSON.stringify(DEFAULT_PREFERENCES), new Date().toISOString(), summary);
    },

    listSources(): DiscoverySource[] {
      return db
        .prepare(
          `SELECT id, kind, slug, label, url, last_fetched_at AS lastFetchedAt,
             last_error AS lastError, job_count AS jobCount
           FROM discovery_sources ORDER BY label COLLATE NOCASE`,
        )
        .all() as unknown as DiscoverySource[];
    },

    /** Adds a board, or returns the existing one with the same site and company. */
    addSource(kind: BoardKind, slug: string, url: string): DiscoverySource {
      db.prepare(
        `INSERT INTO discovery_sources (id, kind, slug, label, url) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, slug) DO NOTHING`,
      ).run(randomUUID(), kind, slug, slug.charAt(0).toUpperCase() + slug.slice(1), url);
      return this.listSources().find((s) => s.kind === kind && s.slug === slug)!;
    },

    /** Removes a board and its unsaved postings. Saved jobs stay in Applications. */
    removeSource(id: string): boolean {
      db.prepare("DELETE FROM discovered_jobs WHERE source_id = ? AND status != 'saved'").run(id);
      return Number(db.prepare("DELETE FROM discovery_sources WHERE id = ?").run(id).changes) > 0;
    },

    recordSourceResult(
      id: string,
      result: { label?: string; jobCount?: number; error: string | null },
    ): void {
      db.prepare(
        `UPDATE discovery_sources SET last_fetched_at = ?, last_error = ?,
           label = COALESCE(?, label), job_count = COALESCE(?, job_count) WHERE id = ?`,
      ).run(new Date().toISOString(), result.error, result.label ?? null, result.jobCount ?? null, id);
    },

    /**
     * Saves a posting from a board. Returns true when it's new. A changed
     * description drops the old AI score so it can be ranked again.
     */
    upsertDiscovered(
      sourceId: string,
      job: BoardJob & { ruleScore: number; matchedSkills: string[] },
    ): boolean {
      const existing = db
        .prepare("SELECT description FROM discovered_jobs WHERE url = ?")
        .get(job.url) as unknown as { description: string } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO discovered_jobs (id, source_id, url, title, company, location, description,
             posted_at, first_seen_at, rule_score, matched_skills)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), sourceId, job.url, job.title, job.company, job.location, job.description,
          job.postedAt, new Date().toISOString(), job.ruleScore, JSON.stringify(job.matchedSkills),
        );
        return true;
      }
      const changed = existing.description !== job.description;
      db.prepare(
        `UPDATE discovered_jobs SET title = ?, company = ?, location = ?, description = ?,
           posted_at = ?, rule_score = ?, matched_skills = ?,
           ai_score = CASE WHEN ? THEN NULL ELSE ai_score END,
           ai_reason = CASE WHEN ? THEN '' ELSE ai_reason END
         WHERE url = ?`,
      ).run(
        job.title, job.company, job.location, job.description, job.postedAt, job.ruleScore,
        JSON.stringify(job.matchedSkills), changed ? 1 : 0, changed ? 1 : 0, job.url,
      );
      return false;
    },

    /** Forgets unsaved postings a board no longer lists (filled or closed). */
    removeUnlisted(sourceId: string, listedUrls: string[]): void {
      const keep = new Set(listedUrls);
      const rows = db
        .prepare("SELECT id, url FROM discovered_jobs WHERE source_id = ? AND status != 'saved'")
        .all(sourceId) as unknown as Array<{ id: string; url: string }>;
      for (const row of rows) {
        if (!keep.has(row.url)) db.prepare("DELETE FROM discovered_jobs WHERE id = ?").run(row.id);
      }
    },

    /** The shortlist: everything not dismissed, best first. */
    listDiscovered(): DiscoveredJob[] {
      return (
        db
          .prepare(
            `SELECT ${JOB_COLUMNS} FROM discovered_jobs WHERE status != 'dismissed'
             ORDER BY ai_score IS NULL, ai_score DESC, rule_score DESC, first_seen_at DESC`,
          )
          .all() as unknown as JobRow[]
      ).map(toJob);
    },

    /** New postings the AI hasn't ranked, most promising by rule score first. */
    unrankedDiscovered(limit: number): Array<DiscoveredJob & { description: string }> {
      return (
        db
          .prepare(
            `SELECT ${JOB_COLUMNS}, description FROM discovered_jobs
             WHERE status = 'new' AND ai_score IS NULL
             ORDER BY rule_score DESC, first_seen_at DESC LIMIT ?`,
          )
          .all(limit) as unknown as Array<JobRow & { description: string }>
      ).map((row) => ({ ...toJob(row), description: row.description }));
    },

    getDiscovered(id: string): (DiscoveredJob & { description: string }) | null {
      const row = db
        .prepare(`SELECT ${JOB_COLUMNS}, description FROM discovered_jobs WHERE id = ?`)
        .get(id) as unknown as (JobRow & { description: string }) | undefined;
      return row ? { ...toJob(row), description: row.description } : null;
    },

    setAiScore(id: string, score: number, reason: string): void {
      db.prepare("UPDATE discovered_jobs SET ai_score = ?, ai_reason = ? WHERE id = ?").run(score, reason, id);
    },

    setDiscoveredStatus(id: string, status: DiscoveredJob["status"], jobId: string | null = null): void {
      const params: SQLInputValue[] = [status, jobId, id];
      db.prepare("UPDATE discovered_jobs SET status = ?, job_id = COALESCE(?, job_id) WHERE id = ?").run(...params);
    },
  };
}
