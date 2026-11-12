/**
 * Database tables and queries for job discovery (Phase 7), merged into the
 * main store by store.ts.
 *
 * Tables:
 *   discovery_sources   company job boards to check
 *   discovered_jobs     postings that passed the user's filters, with scores,
 *                       whether they were saved, dismissed or seen, and whether
 *                       they were already listed when their board was added
 *   discovery_settings  one row: filters, AI on/off, and the last run
 *   position_searches   searches by role across companies (search.ts)
 *   search_runs         when each search last used each source, for limits
 *   search_settings     one row: which search sources to use, and their keys
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  BoardKind,
  DiscoveredJob,
  DiscoveryPreferences,
  DiscoverySource,
  JobAlert,
  PositionSearch,
  SearchProvider,
  SearchProvidersInput,
} from "@draftline/shared";
import type { BoardJob } from "./boards.js";
import { DEFAULT_SEARCH_SETTINGS, type SearchSettings } from "./search.js";

const DEFAULT_PREFERENCES: DiscoveryPreferences = {
  keywords: [],
  exclude: [],
  locations: [],
  useAi: true,
  refreshMinutes: 15,
};

const JOB_COLUMNS = `id, source_id AS sourceId, url, title, company, location,
  posted_at AS postedAt, first_seen_at AS firstSeenAt, rule_score AS ruleScore,
  matched_skills AS matchedSkills, ai_score AS aiScore, ai_reason AS aiReason,
  status, job_id AS jobId, baseline, seen_at AS seenAt, via`;

type JobRow = Omit<DiscoveredJob, "matchedSkills" | "baseline"> & {
  matchedSkills: string;
  baseline: number;
};
const toJob = ({ matchedSkills, baseline, ...row }: JobRow): DiscoveredJob => ({
  ...row,
  matchedSkills: JSON.parse(matchedSkills) as string[],
  baseline: baseline === 1,
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
      job_id TEXT,
      baseline INTEGER NOT NULL DEFAULT 0,
      seen_at TEXT,
      via TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS position_searches (
      id TEXT PRIMARY KEY,
      position TEXT NOT NULL,
      location TEXT NOT NULL,
      last_run_at TEXT,
      last_error TEXT,
      UNIQUE (position, location)
    );
    CREATE TABLE IF NOT EXISTS search_runs (
      search_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (search_id, provider)
    );
    CREATE TABLE IF NOT EXISTS search_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discovery_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      preferences TEXT NOT NULL,
      last_run_at TEXT,
      last_summary TEXT NOT NULL DEFAULT ''
    );
  `);

  // Tables made before live tracking lack these columns; adding them keeps data.
  const columns = new Set(
    (db.prepare("PRAGMA table_info(discovered_jobs)").all() as unknown as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("baseline")) {
    db.exec("ALTER TABLE discovered_jobs ADD COLUMN baseline INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("seen_at")) db.exec("ALTER TABLE discovered_jobs ADD COLUMN seen_at TEXT");
  if (!columns.has("via")) db.exec("ALTER TABLE discovered_jobs ADD COLUMN via TEXT NOT NULL DEFAULT ''");
  if (!columns.has("last_seen_at")) db.exec("ALTER TABLE discovered_jobs ADD COLUMN last_seen_at TEXT");

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
      baseline = false,
      via = "",
    ): boolean {
      const now = new Date().toISOString();
      const existing = db
        .prepare("SELECT description FROM discovered_jobs WHERE url = ?")
        .get(job.url) as unknown as { description: string } | undefined;
      if (!existing) {
        db.prepare(
          `INSERT INTO discovered_jobs (id, source_id, url, title, company, location, description,
             posted_at, first_seen_at, rule_score, matched_skills, baseline, via, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), sourceId, job.url, job.title, job.company, job.location, job.description,
          job.postedAt, now, job.ruleScore, JSON.stringify(job.matchedSkills),
          baseline ? 1 : 0, via, now,
        );
        return true;
      }
      const changed = existing.description !== job.description;
      db.prepare(
        `UPDATE discovered_jobs SET title = ?, company = ?, location = ?, description = ?,
           posted_at = ?, rule_score = ?, matched_skills = ?, last_seen_at = ?,
           ai_score = CASE WHEN ? THEN NULL ELSE ai_score END,
           ai_reason = CASE WHEN ? THEN '' ELSE ai_reason END
         WHERE url = ?`,
      ).run(
        job.title, job.company, job.location, job.description, job.postedAt, job.ruleScore,
        JSON.stringify(job.matchedSkills), now, changed ? 1 : 0, changed ? 1 : 0, job.url,
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

    // --- Position searches ---

    listSearches(): PositionSearch[] {
      return db
        .prepare(
          `SELECT s.id, s.position, s.location, s.last_run_at AS lastRunAt, s.last_error AS lastError,
             (SELECT COUNT(*) FROM discovered_jobs d WHERE d.source_id = s.id AND d.status != 'dismissed') AS jobCount
           FROM position_searches s ORDER BY s.position COLLATE NOCASE`,
        )
        .all() as unknown as PositionSearch[];
    },

    /** Adds a search, or returns the existing one for the same role and place. */
    addSearch(position: string, location: string): PositionSearch {
      db.prepare(
        `INSERT INTO position_searches (id, position, location) VALUES (?, ?, ?)
         ON CONFLICT (position, location) DO NOTHING`,
      ).run(randomUUID(), position, location);
      return this.listSearches().find((s) => s.position === position && s.location === location)!;
    },

    /** Removes a search and its unsaved jobs. Saved jobs stay in Applications. */
    removeSearch(id: string): boolean {
      db.prepare("DELETE FROM discovered_jobs WHERE source_id = ? AND status != 'saved'").run(id);
      db.prepare("DELETE FROM search_runs WHERE search_id = ?").run(id);
      return Number(db.prepare("DELETE FROM position_searches WHERE id = ?").run(id).changes) > 0;
    },

    recordSearchResult(id: string, error: string | null): void {
      db.prepare("UPDATE position_searches SET last_run_at = ?, last_error = ? WHERE id = ?").run(
        new Date().toISOString(),
        error,
        id,
      );
    },

    /** When this search last used this source, or null if never. */
    getSearchRun(searchId: string, provider: SearchProvider): string | null {
      const row = db
        .prepare("SELECT last_at AS lastAt FROM search_runs WHERE search_id = ? AND provider = ?")
        .get(searchId, provider) as unknown as { lastAt: string } | undefined;
      return row?.lastAt ?? null;
    },

    setSearchRun(searchId: string, provider: SearchProvider): void {
      db.prepare(
        `INSERT INTO search_runs (search_id, provider, last_at) VALUES (?, ?, ?)
         ON CONFLICT (search_id, provider) DO UPDATE SET last_at = excluded.last_at`,
      ).run(searchId, provider, new Date().toISOString());
    },

    /**
     * Settings saved in the app, or null if never saved. Keys here win over
     * .env; see resolveSearchSettings in search.ts.
     */
    getSavedSearchSettings(): SearchSettings | null {
      const row = db.prepare("SELECT data FROM search_settings WHERE id = 1").get() as unknown as
        | { data: string }
        | undefined;
      if (!row) return null;
      const saved = JSON.parse(row.data) as Partial<SearchSettings>;
      return {
        ...DEFAULT_SEARCH_SETTINGS,
        ...saved,
        adzuna: { ...DEFAULT_SEARCH_SETTINGS.adzuna, ...saved.adzuna },
        brave: { ...DEFAULT_SEARCH_SETTINGS.brave, ...saved.brave },
      };
    },

    /**
     * Saves source settings. A blank key keeps the saved one. Keys from .env
     * are never saved here.
     */
    saveSearchSettings(input: SearchProvidersInput): void {
      const previous = this.getSavedSearchSettings() ?? DEFAULT_SEARCH_SETTINGS;
      const settings: SearchSettings = {
        remotive: input.remotive,
        arbeitnow: input.arbeitnow,
        adzuna: {
          enabled: input.adzuna.enabled,
          country: input.adzuna.country,
          appId: input.adzuna.appId || previous.adzuna.appId,
          appKey: input.adzuna.appKey || previous.adzuna.appKey,
        },
        brave: {
          enabled: input.brave.enabled,
          apiKey: input.brave.apiKey || previous.brave.apiKey,
        },
      };
      db.prepare(
        `INSERT INTO search_settings (id, data) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      ).run(JSON.stringify(settings));
    },

    /** True when the same job (title and company) is already listed under another address. */
    isDuplicate(title: string, company: string, url: string): boolean {
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM discovered_jobs WHERE lower(title) = lower(?) AND lower(company) = lower(?) AND url != ? LIMIT 1",
          )
          .get(title, company, url),
      );
    },

    /**
     * Search results come and go between runs, so unsaved ones are kept until
     * no search has returned them for this many days.
     */
    pruneStaleSearchJobs(days: number): void {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(
        `DELETE FROM discovered_jobs WHERE status != 'saved' AND last_seen_at < ?
           AND source_id IN (SELECT id FROM position_searches)`,
      ).run(cutoff);
    },

    /** New jobs that appeared after `since`, for desktop notifications. */
    alertsSince(since: string): JobAlert[] {
      return db
        .prepare(
          `SELECT id, title, company, location, url FROM discovered_jobs
           WHERE status = 'new' AND baseline = 0 AND first_seen_at > ?
           ORDER BY first_seen_at DESC LIMIT 20`,
        )
        .all(since) as unknown as JobAlert[];
    },

    /** New jobs found after their board was added that the user hasn't seen. */
    countUnseen(): number {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM discovered_jobs WHERE baseline = 0 AND seen_at IS NULL AND status != 'dismissed'",
        )
        .get() as unknown as { n: number };
      return row.n;
    },

    markAllSeen(): void {
      db.prepare("UPDATE discovered_jobs SET seen_at = ? WHERE seen_at IS NULL").run(
        new Date().toISOString(),
      );
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
