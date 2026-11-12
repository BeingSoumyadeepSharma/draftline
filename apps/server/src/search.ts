/**
 * Position search: finds jobs by role ("Backend Engineer", "Milan") across
 * many companies, alongside the company boards in discovery.ts.
 *
 * Sources, all called only as often as each allows:
 *   Remotive   remote jobs; free, no key. Asks for at most 4 calls a day,
 *              a link back, and its name shown. Its jobs are 24 hours behind.
 *   Arbeitnow  Europe, mostly Germany; free, no key, updated hourly. Has no
 *              search, so its latest jobs are read and matched here.
 *   Adzuna     a job search engine covering about 20 countries; needs a free
 *              key from developer.adzuna.com.
 *   Brave      web search limited to Greenhouse, Lever and Ashby postings at
 *              any company (the jobs Draftline can autofill); needs a key from
 *              brave.com/search/api. Each result is then read from its board.
 * LinkedIn and Indeed have no public search API and forbid scraping, so they
 * aren't sources.
 *
 * Sources match loosely, so every result's title is checked against the
 * position here before it's kept.
 */
import {
  ADZUNA_COUNTRIES,
  type KeySource,
  type PositionSearch,
  type SearchProvider,
  type SearchProvidersView,
} from "@draftline/shared";
import { fetchPosting, getJson, htmlToText, type BoardJob } from "./boards.js";

/** A posting found by a search, with where it came from. */
export type SearchHit = BoardJob & { via: string };

export const PROVIDER_LABELS: Record<SearchProvider, string> = {
  remotive: "Remotive",
  arbeitnow: "Arbeitnow",
  adzuna: "Adzuna",
  brave: "Web search",
};

/** The shortest gap between calls to each source, in minutes, per search. */
export const PROVIDER_MIN_MINUTES: Record<SearchProvider, number> = {
  remotive: 360, // Remotive asks for at most 4 calls a day.
  arbeitnow: 60, // Updates hourly.
  adzuna: 60, // Free plan: about 250 calls a day.
  brave: 360, // Free plan: about 2,000 searches a month.
};

/** Saved source settings, including keys. Never sent to a browser. */
export type SearchSettings = {
  remotive: boolean;
  arbeitnow: boolean;
  adzuna: { enabled: boolean; country: string | null; appId: string; appKey: string };
  brave: { enabled: boolean; apiKey: string };
};

/** Starting values before anything is saved in the app. Keys come from resolveSearchSettings. */
export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  remotive: true,
  arbeitnow: true,
  adzuna: { enabled: false, country: null, appId: "", appKey: "" },
  brave: { enabled: false, apiKey: "" },
};

/** The .env variables read as a fallback for keys not saved in the app. */
export type SearchEnv = Partial<
  Record<"ADZUNA_APP_ID" | "ADZUNA_APP_KEY" | "ADZUNA_COUNTRY" | "BRAVE_SEARCH_API_KEY", string>
>;

/** The settings in effect, and where each key came from. */
export type ResolvedSearchSettings = SearchSettings & {
  keyFrom: { adzuna: KeySource; brave: KeySource };
};

/**
 * Works out the settings in effect. For each key, and Adzuna's country, a
 * value saved in the app (the database) wins; otherwise the .env value is
 * used. Values from .env are never written to the database.
 *
 * On/off: once settings are saved in the app, its switches are respected.
 * Before that, a source whose key is in .env is switched on, so adding a key
 * to .env is enough to start using it.
 */
export function resolveSearchSettings(
  saved: SearchSettings | null,
  env: SearchEnv,
): ResolvedSearchSettings {
  const base = saved ?? DEFAULT_SEARCH_SETTINGS;
  const fromEnv = (name: keyof SearchEnv) => env[name]?.trim() ?? "";

  const adzunaSaved = Boolean(base.adzuna.appId && base.adzuna.appKey);
  const adzunaEnv = Boolean(fromEnv("ADZUNA_APP_ID") && fromEnv("ADZUNA_APP_KEY"));
  const envCountry = fromEnv("ADZUNA_COUNTRY").toLowerCase();
  const braveSaved = Boolean(base.brave.apiKey);
  const braveEnv = Boolean(fromEnv("BRAVE_SEARCH_API_KEY"));

  return {
    remotive: base.remotive,
    arbeitnow: base.arbeitnow,
    adzuna: {
      enabled: saved ? base.adzuna.enabled : adzunaEnv,
      country:
        base.adzuna.country ??
        ((ADZUNA_COUNTRIES as readonly string[]).includes(envCountry) ? envCountry : null),
      appId: adzunaSaved ? base.adzuna.appId : fromEnv("ADZUNA_APP_ID"),
      appKey: adzunaSaved ? base.adzuna.appKey : fromEnv("ADZUNA_APP_KEY"),
    },
    brave: {
      enabled: saved ? base.brave.enabled : braveEnv,
      apiKey: braveSaved ? base.brave.apiKey : fromEnv("BRAVE_SEARCH_API_KEY"),
    },
    keyFrom: {
      adzuna: adzunaSaved ? "saved" : adzunaEnv ? "env" : null,
      brave: braveSaved ? "saved" : braveEnv ? "env" : null,
    },
  };
}

/** Settings for the browser: never the keys themselves. */
export function searchProvidersView(settings: ResolvedSearchSettings): SearchProvidersView {
  return {
    remotive: settings.remotive,
    arbeitnow: settings.arbeitnow,
    adzuna: {
      enabled: settings.adzuna.enabled,
      country: settings.adzuna.country,
      hasKey: settings.keyFrom.adzuna !== null,
      keyFrom: settings.keyFrom.adzuna,
    },
    brave: {
      enabled: settings.brave.enabled,
      hasKey: settings.keyFrom.brave !== null,
      keyFrom: settings.keyFrom.brave,
    },
  };
}

/** Sources that are switched on and have what they need. */
export function readyProviders(settings: SearchSettings): SearchProvider[] {
  const ready: SearchProvider[] = [];
  if (settings.remotive) ready.push("remotive");
  if (settings.arbeitnow) ready.push("arbeitnow");
  if (settings.adzuna.enabled && settings.adzuna.country && settings.adzuna.appId && settings.adzuna.appKey) {
    ready.push("adzuna");
  }
  if (settings.brave.enabled && settings.brave.apiKey) ready.push("brave");
  return ready;
}

// --- Matching titles to the position ---

/** Words that say nothing about the role itself. */
const IGNORED = new Set([
  "senior", "sr", "junior", "jr", "lead", "staff", "principal", "mid", "level",
  "i", "ii", "iii", "iv", "the", "and", "of", "for", "with", "in", "a", "an",
  "remote", "hybrid", "m", "f", "d", "w", "x",
]);

/** Words for the same kind of role; any one of them matches the others. */
const ROLE_WORDS = new Set(["engineer", "developer", "programmer", "dev", "swe"]);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[-‐–]/g, "") // "Back-end" and "backend" are the same word.
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word && !IGNORED.has(word));

/**
 * True when a title is the same role as the position: every specific word of
 * the position appears, and if it names a role word ("engineer"), the title
 * has one too. Seniority words are ignored; exclude them in preferences.
 * "Backend Engineer" matches "Senior Back-end Developer", not "Service Desk Engineer".
 */
export function titleMatchesPosition(title: string, position: string): boolean {
  const wanted = words(position);
  if (wanted.length === 0) return false;
  const have = new Set(words(title));
  const specific = wanted.filter((word) => !ROLE_WORDS.has(word));
  const needsRole = wanted.some((word) => ROLE_WORDS.has(word));
  if (!specific.every((word) => have.has(word))) return false;
  return !needsRole || [...have].some((word) => ROLE_WORDS.has(word));
}

// --- The sources ---

type RemotiveResponse = {
  jobs?: Array<{
    url: string;
    title: string;
    company_name: string;
    candidate_required_location?: string;
    description?: string;
    publication_date?: string;
  }>;
};

async function searchRemotive(search: PositionSearch, fetchFn: typeof fetch): Promise<SearchHit[]> {
  const data = (await getJson(
    `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(search.position)}&limit=100`,
    fetchFn,
    "Remotive",
  )) as RemotiveResponse;
  return (data.jobs ?? []).map((job) => ({
    url: job.url,
    title: job.title,
    company: job.company_name,
    location: ["Remote", job.candidate_required_location].filter(Boolean).join(" · "),
    description: htmlToText(job.description ?? ""),
    // Remotive gives a time without a zone; it's UTC.
    postedAt: job.publication_date ? `${job.publication_date.replace(/Z$/, "")}Z` : null,
    via: "Remotive",
  }));
}

type ArbeitnowResponse = {
  data?: Array<{
    url: string;
    title: string;
    company_name: string;
    location?: string;
    remote?: boolean;
    description?: string;
    created_at?: number;
  }>;
};

/** Arbeitnow's two newest pages (600 jobs), read once per check for all searches. */
export async function fetchArbeitnow(fetchFn: typeof fetch): Promise<SearchHit[]> {
  const pages = await Promise.all(
    [1, 2].map((page) =>
      getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, fetchFn, "Arbeitnow"),
    ),
  );
  return (pages as ArbeitnowResponse[]).flatMap((page) =>
    (page.data ?? []).map((job) => ({
      url: job.url,
      title: job.title,
      company: job.company_name,
      location: [job.location, job.remote ? "Remote" : ""].filter(Boolean).join(" · "),
      description: htmlToText(job.description ?? ""),
      postedAt: job.created_at ? new Date(job.created_at * 1000).toISOString() : null,
      via: "Arbeitnow",
    })),
  );
}

type AdzunaResponse = {
  results?: Array<{
    title: string;
    description?: string;
    created?: string;
    redirect_url: string;
    company?: { display_name?: string };
    location?: { display_name?: string };
  }>;
};

/** Untested against the live API: it needs the user's key. Built from Adzuna's documentation. */
async function searchAdzuna(
  search: PositionSearch,
  settings: SearchSettings["adzuna"],
  fetchFn: typeof fetch,
): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    app_id: settings.appId,
    app_key: settings.appKey,
    what: search.position,
    results_per_page: "50",
    max_days_old: "14",
    sort_by: "date",
    "content-type": "application/json",
  });
  if (search.location && !/^remote$/i.test(search.location)) params.set("where", search.location);
  const data = (await getJson(
    `https://api.adzuna.com/v1/api/jobs/${settings.country}/search/1?${params}`,
    fetchFn,
    "Adzuna",
  )) as AdzunaResponse;
  return (data.results ?? []).map((job) => ({
    url: job.redirect_url,
    // Adzuna marks matched words with <strong>.
    title: htmlToText(job.title),
    company: job.company?.display_name ?? "",
    location: job.location?.display_name ?? "",
    description: htmlToText(job.description ?? ""),
    postedAt: job.created ?? null,
    via: "Adzuna",
  }));
}

type BraveResponse = { web?: { results?: Array<{ url: string }> } };

/** Untested against the live API: it needs the user's key. Built from Brave's documentation. */
async function searchBrave(
  search: PositionSearch,
  apiKey: string,
  fetchFn: typeof fetch,
  ashbyBoards: Map<string, Promise<BoardJob[]>>,
): Promise<SearchHit[]> {
  const query = [
    `"${search.position}"`,
    search.location,
    "(site:job-boards.greenhouse.io OR site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com)",
  ]
    .filter(Boolean)
    .join(" ");
  const data = (await getJson(
    `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: "20", freshness: "pw" })}`,
    fetchFn,
    "Brave Search",
    { headers: { "X-Subscription-Token": apiKey } },
  )) as BraveResponse;

  const hits: SearchHit[] = [];
  for (const result of data.web?.results ?? []) {
    // The search result only has a snippet; the board has the full posting.
    const posting = await fetchPosting(result.url, fetchFn, ashbyBoards);
    if (posting) hits.push({ ...posting, via: "Web search" });
  }
  return hits;
}

/** Shared within one check: Arbeitnow's listing and Ashby boards read for web results. */
export type SearchContext = {
  fetchFn: typeof fetch;
  arbeitnow?: Promise<SearchHit[]>;
  ashbyBoards: Map<string, Promise<BoardJob[]>>;
};

/** Runs one source for one search. Location filtering happens in the caller. */
export async function runProvider(
  provider: SearchProvider,
  search: PositionSearch,
  settings: SearchSettings,
  context: SearchContext,
): Promise<SearchHit[]> {
  switch (provider) {
    case "remotive":
      return searchRemotive(search, context.fetchFn);
    case "arbeitnow": {
      context.arbeitnow ??= fetchArbeitnow(context.fetchFn);
      const jobs = await context.arbeitnow;
      // Arbeitnow can't search, so its location filter is applied here.
      if (!search.location) return jobs;
      const place = search.location.toLowerCase();
      return jobs.filter((job) =>
        place === "remote"
          ? job.location.toLowerCase().includes("remote")
          : job.location.toLowerCase().includes(place),
      );
    }
    case "adzuna":
      return searchAdzuna(search, settings.adzuna, context.fetchFn);
    case "brave":
      return searchBrave(search, settings.brave.apiKey, context.fetchFn, context.ashbyBoards);
  }
}
