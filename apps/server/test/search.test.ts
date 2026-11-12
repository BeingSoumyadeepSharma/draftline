/**
 * Tests for position search: matching titles to a role, each source (fake
 * responses shaped like the real APIs; Adzuna and Brave from their docs),
 * call limits, de-duplication, and keeping keys out of the browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE } from "@draftline/shared";
import { createApp } from "../src/app.js";
import { runDiscovery } from "../src/discovery.js";
import { buildFacts } from "../src/jobs.js";
import { DEFAULT_SEARCH_SETTINGS, readyProviders, resolveSearchSettings, titleMatchesPosition } from "../src/search.js";
import { createStore } from "../src/store.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("titleMatchesPosition", () => {
  it("matches the same role in different words", () => {
    expect(titleMatchesPosition("Senior Back-end Developer", "Backend Engineer")).toBe(true);
    expect(titleMatchesPosition("Backend Software Engineer (m/f/d)", "backend engineer")).toBe(true);
    expect(titleMatchesPosition("Data Scientist II", "Data Scientist")).toBe(true);
  });

  it("rejects other roles that share a word", () => {
    expect(titleMatchesPosition("Tier III Service Desk Engineer", "Backend Engineer")).toBe(false);
    expect(titleMatchesPosition("Backend Team Recruiter", "Backend Engineer")).toBe(false);
    expect(titleMatchesPosition("Inside Sales Contractor", "Backend Engineer")).toBe(false);
    expect(titleMatchesPosition("Data Engineer", "Data Scientist")).toBe(false);
  });
});

/** A fake network with every source, shaped like the real responses. */
function fakeSources(calls: string[] = []) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split("?")[0]!);
    if (url.startsWith("https://remotive.com/api/remote-jobs")) {
      return json({
        "0-legal-notice": "…",
        jobs: [
          { url: "https://remotive.com/remote-jobs/dev/1", title: "Senior Backend Engineer", company_name: "Acme", candidate_required_location: "Europe", description: "<p>Go and Postgres</p>", publication_date: "2026-11-10T09:00:00" },
          { url: "https://remotive.com/remote-jobs/sales/2", title: "Inside Sales Contractor", company_name: "Credit Co", candidate_required_location: "Worldwide", description: "Sell", publication_date: "2026-11-10T09:00:00" },
        ],
      });
    }
    if (url.startsWith("https://www.arbeitnow.com/api/job-board-api")) {
      const page = new URL(url).searchParams.get("page");
      return json({
        data:
          page === "1"
            ? [
                { url: "https://www.arbeitnow.com/jobs/a", title: "Backend Developer (m/w/d)", company_name: "Berlin GmbH", location: "Berlin", remote: false, description: "<p>TypeScript</p>", created_at: 1794434433 },
                { url: "https://www.arbeitnow.com/jobs/b", title: "Backend Engineer", company_name: "Milano Srl", location: "Milan", remote: false, description: "Go", created_at: 1794434433 },
                // The same job Remotive lists: should be skipped as a duplicate.
                { url: "https://www.arbeitnow.com/jobs/c", title: "Senior Backend Engineer", company_name: "Acme", location: "Remote", remote: true, description: "Go", created_at: 1794434433 },
              ]
            : [],
      });
    }
    if (url.startsWith("https://api.adzuna.com/v1/api/jobs/it/search/1")) {
      const params = new URL(url).searchParams;
      if (params.get("app_key") !== "secret-adzuna") return json({ exception: "AUTH_FAIL" }, 401);
      return json({
        results: [
          { title: "<strong>Backend</strong> <strong>Engineer</strong>", description: "Build APIs in Milan", created: "2026-11-11T08:00:00Z", redirect_url: "https://www.adzuna.it/details/1", company: { display_name: "Rossi SpA" }, location: { display_name: "Milano, Lombardia" } },
        ],
      });
    }
    if (url.startsWith("https://api.search.brave.com/res/v1/web/search")) {
      const token = (init?.headers as Record<string, string>)["X-Subscription-Token"];
      if (token !== "secret-brave") return json({ error: {} }, 401);
      return json({
        web: {
          results: [
            { url: "https://job-boards.greenhouse.io/gitlab/jobs/123" },
            { url: "https://www.indeed.com/viewjob?jk=abc" },
          ],
        },
      });
    }
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/123")) {
      return json({
        absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/123",
        title: "Backend Engineer, Verify",
        company_name: "GitLab",
        location: { name: "Remote, EMEA" },
        content: "&lt;p&gt;Ruby and Go&lt;/p&gt;",
        first_published: "2026-11-09T10:00:00Z",
      });
    }
    return json({}, 404);
  });
}

describe("position search runs", () => {
  let store: ReturnType<typeof createStore>;
  const deps = { generate: null, buildFacts: (p: typeof EMPTY_PROFILE) => buildFacts(p, []) };

  beforeEach(() => {
    store = createStore(":memory:");
    store.addSearch("Backend Engineer", "");
  });

  it("collects matching jobs from the keyless sources, without duplicates", async () => {
    await runDiscovery(store, { ...deps, fetchFn: fakeSources() });
    const jobs = store.listDiscovered();
    expect(jobs.map((j) => [j.title, j.via]).sort()).toEqual([
      ["Backend Developer (m/w/d)", "Arbeitnow"],
      ["Backend Engineer", "Arbeitnow"],
      ["Senior Backend Engineer", "Remotive"],
    ]);
    expect(jobs.find((j) => j.via === "Remotive")!.postedAt).toBe("2026-11-10T09:00:00Z");
    // A search's first results are its starting list, so they don't alert.
    expect(jobs.every((j) => j.baseline)).toBe(true);
    expect(store.listSearches()[0]).toMatchObject({ jobCount: 3, lastError: null });
  });

  it("filters Arbeitnow by the search's location, which it can't do itself", async () => {
    store.removeSearch(store.listSearches()[0]!.id);
    store.addSearch("Backend Engineer", "Milan");
    await runDiscovery(store, { ...deps, fetchFn: fakeSources() });
    const fromArbeitnow = store.listDiscovered().filter((j) => j.via === "Arbeitnow");
    expect(fromArbeitnow.map((j) => j.company)).toEqual(["Milano Srl"]);
  });

  it("respects each source's call limit between checks", async () => {
    const calls: string[] = [];
    const fetchFn = fakeSources(calls);
    await runDiscovery(store, { ...deps, fetchFn });
    await runDiscovery(store, { ...deps, fetchFn });
    // Remotive: at most every 6 hours. Arbeitnow: hourly. Neither again yet.
    expect(calls.filter((c) => c.includes("remotive")).length).toBe(1);
    expect(calls.filter((c) => c.includes("arbeitnow")).length).toBe(2); // two pages, once
  });

  it("uses Adzuna and web search once keys are saved, reading web results from their boards", async () => {
    store.saveSearchSettings({
      remotive: false,
      arbeitnow: false,
      adzuna: { enabled: true, country: "it", appId: "id-1", appKey: "secret-adzuna" },
      brave: { enabled: true, apiKey: "secret-brave" },
    });
    await runDiscovery(store, { ...deps, fetchFn: fakeSources() });
    const jobs = store.listDiscovered();
    expect(jobs.map((j) => [j.title, j.company, j.via]).sort((a, b) => a[2]!.localeCompare(b[2]!))).toEqual([
      ["Backend Engineer", "Rossi SpA", "Adzuna"],
      ["Backend Engineer, Verify", "GitLab", "Web search"],
    ]);
    expect(jobs.find((j) => j.via === "Web search")!.url).toBe("https://job-boards.greenhouse.io/gitlab/jobs/123");
  });

  it("records a failing source without stopping the others", async () => {
    store.saveSearchSettings({
      remotive: true,
      arbeitnow: false,
      adzuna: { enabled: true, country: "it", appId: "id-1", appKey: "wrong" },
      brave: { enabled: false, apiKey: "" },
    });
    const summary = await runDiscovery(store, { ...deps, fetchFn: fakeSources() });
    expect(summary).toContain("1 search source failed");
    expect(store.listSearches()[0]!.lastError).toContain("Adzuna");
    expect(store.listDiscovered().map((j) => j.via)).toEqual(["Remotive"]);
  });

  it("only uses sources that are on and have their keys", () => {
    expect(readyProviders(DEFAULT_SEARCH_SETTINGS)).toEqual(["remotive", "arbeitnow"]);
    expect(
      readyProviders({ ...DEFAULT_SEARCH_SETTINGS, adzuna: { enabled: true, country: "it", appId: "", appKey: "" } }),
    ).toEqual(["remotive", "arbeitnow"]);
  });
});

describe("position search API", () => {
  const HOST = { host: "127.0.0.1:8787" };
  const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp({
      store: createStore(":memory:"),
      ai: { parseResume: vi.fn(), generate: vi.fn() as never },
      hasEnvClaudeKey: () => false,
      fetchBoards: fakeSources(),
    });
  });

  it("adds a search and returns its jobs", async () => {
    const empty = await app.request("/api/discovery/searches", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ position: " ", location: "" }),
    });
    expect(empty.status).toBe(400);

    const state = await (
      await app.request("/api/discovery/searches", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ position: "Backend Engineer", location: "" }),
      })
    ).json();
    expect(state.searches).toHaveLength(1);
    expect(state.jobs.length).toBe(3);
    expect(state.nextRunAt).not.toBeNull();
  });

  it("never sends keys back, and keeps them when left blank", async () => {
    const save = (adzunaKey: string) =>
      app.request("/api/discovery/providers", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          remotive: true,
          arbeitnow: true,
          adzuna: { enabled: true, country: "it", appId: "id-1", appKey: adzunaKey },
          brave: { enabled: false, apiKey: "" },
        }),
      });
    const first = await (await save("secret-adzuna")).text();
    expect(first).not.toContain("secret-adzuna");
    const second = await (await save("")).json();
    expect(second.providers.adzuna).toEqual({ enabled: true, country: "it", hasKey: true, keyFrom: "saved" });

    const noCountry = await app.request("/api/discovery/providers", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        remotive: true,
        arbeitnow: true,
        adzuna: { enabled: true, country: null, appId: "", appKey: "" },
        brave: { enabled: false, apiKey: "" },
      }),
    });
    expect(noCountry.status).toBe(400);
  });
});

describe("keys from the database, then .env", () => {
  const env = {
    ADZUNA_APP_ID: "env-id",
    ADZUNA_APP_KEY: "env-key",
    ADZUNA_COUNTRY: "IT",
    BRAVE_SEARCH_API_KEY: "env-brave",
  };
  const saved = (adzunaKey: string, braveKey: string, enabled = true) => ({
    ...DEFAULT_SEARCH_SETTINGS,
    adzuna: { enabled, country: "gb", appId: adzunaKey ? "db-id" : "", appKey: adzunaKey },
    brave: { enabled, apiKey: braveKey },
  });

  it("uses .env keys, and switches their sources on, when nothing is saved", () => {
    const settings = resolveSearchSettings(null, env);
    expect(settings.adzuna).toEqual({ enabled: true, country: "it", appId: "env-id", appKey: "env-key" });
    expect(settings.brave).toEqual({ enabled: true, apiKey: "env-brave" });
    expect(settings.keyFrom).toEqual({ adzuna: "env", brave: "env" });
  });

  it("prefers keys and the country saved in the app", () => {
    const settings = resolveSearchSettings(saved("db-key", "db-brave"), env);
    expect(settings.adzuna).toMatchObject({ country: "gb", appId: "db-id", appKey: "db-key" });
    expect(settings.brave.apiKey).toBe("db-brave");
    expect(settings.keyFrom).toEqual({ adzuna: "saved", brave: "saved" });
  });

  it("falls back to .env for a key the app hasn't saved", () => {
    const settings = resolveSearchSettings(saved("", ""), env);
    expect(settings.adzuna).toMatchObject({ appId: "env-id", appKey: "env-key" });
    expect(settings.brave.apiKey).toBe("env-brave");
    expect(settings.keyFrom).toEqual({ adzuna: "env", brave: "env" });
  });

  it("keeps a source off once the user has switched it off in the app", () => {
    const settings = resolveSearchSettings(saved("", "", false), env);
    expect(readyProviders(settings)).toEqual(["remotive", "arbeitnow"]);
  });

  it("ignores an unknown country and has no keys without either", () => {
    const settings = resolveSearchSettings(null, { ADZUNA_COUNTRY: "xx" });
    expect(settings.adzuna.country).toBeNull();
    expect(settings.keyFrom).toEqual({ adzuna: null, brave: null });
  });

  it("searches with a .env key and never shows it or saves it", async () => {
    const store = createStore(":memory:");
    store.addSearch("Backend Engineer", "");
    const app = createApp({
      store,
      ai: { parseResume: vi.fn(), generate: vi.fn() as never },
      hasEnvClaudeKey: () => false,
      fetchBoards: fakeSources(),
      env: { ADZUNA_APP_ID: "id-1", ADZUNA_APP_KEY: "secret-adzuna", ADZUNA_COUNTRY: "it" },
    });
    const HOST = { host: "127.0.0.1:8787" };
    const response = await app.request("/api/discovery/refresh", { method: "POST", headers: HOST });
    const text = await response.text();
    expect(text).not.toContain("secret-adzuna");
    const state = JSON.parse(text);
    expect(state.providers.adzuna).toEqual({ enabled: true, country: "it", hasKey: true, keyFrom: "env" });
    expect(state.jobs.some((j: { via: string }) => j.via === "Adzuna")).toBe(true);
    expect(store.getSavedSearchSettings()).toBeNull();
  });
});
