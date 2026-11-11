/**
 * Tests for job discovery: reading each board's public API (with fake
 * responses shaped like the real ones), filters, scoring, AI ranking, a full
 * refresh, and the discovery API. No network or AI provider is used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE, type DiscoveryPreferences } from "@draftline/shared";
import { createApp } from "./app.js";
import { decodeEntities, fetchBoard, htmlToText, parseBoardUrl, type BoardJob } from "./boards.js";
import { AI_BATCH, mentions, passesPreferences, rankWithAi, ruleScore, runDiscovery } from "./discovery.js";
import { buildFacts } from "./jobs.js";
import { createStore } from "./store.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const longText = (topic: string) => `${topic}. `.repeat(30);

/** A fake network with one board per site, shaped like each real API. */
function fakeBoards(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    for (const [part, respond] of Object.entries(overrides)) {
      if (url.includes(part)) return respond();
    }
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs")) {
      return json({
        jobs: [
          {
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
            title: "Senior TypeScript Engineer",
            company_name: "Acme",
            location: { name: "Milan, Italy" },
            content: "&lt;p&gt;We use TypeScript and Postgres &amp;amp; love tests.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Ship weekly&lt;/li&gt;&lt;/ul&gt;",
            first_published: "2026-11-01T10:00:00Z",
          },
          {
            absolute_url: "https://job-boards.greenhouse.io/acme/jobs/2",
            title: "Sales Manager",
            company_name: "Acme",
            location: { name: "Milan, Italy" },
            content: "&lt;p&gt;Sell things.&lt;/p&gt;",
          },
        ],
      });
    }
    if (url.startsWith("https://api.lever.co/v0/postings/initech")) {
      return json([
        {
          hostedUrl: "https://jobs.lever.co/initech/abc",
          text: "Backend Engineer",
          categories: { location: "Remote, Europe" },
          descriptionPlain: "Build APIs in Go.",
          lists: [{ text: "Requirements", content: "<li>Postgres</li><li>Kubernetes</li>" }],
          additionalPlain: "Equal opportunity employer.",
          createdAt: 1786469891368,
        },
      ]);
    }
    if (url.startsWith("https://api.ashbyhq.com/posting-api/job-board/globex")) {
      return json({
        jobs: [
          { title: "Platform Engineer", location: "Berlin", isRemote: true, isListed: true, jobUrl: "https://jobs.ashbyhq.com/globex/1", descriptionPlain: longText("Kubernetes and TypeScript"), publishedAt: "2026-10-01T00:00:00Z" },
          { title: "Hidden Engineer", location: "Berlin", isListed: false, jobUrl: "https://jobs.ashbyhq.com/globex/2", descriptionPlain: "x" },
        ],
      });
    }
    return json({ error: "not found" }, 404);
  });
}

const job = (overrides: Partial<BoardJob> = {}): BoardJob => ({
  url: "https://x.com/1",
  title: "Senior Engineer",
  company: "X",
  location: "Milan, Italy",
  description: "TypeScript and Postgres",
  postedAt: null,
  ...overrides,
});

const allPrefs: DiscoveryPreferences = { keywords: [], exclude: [], locations: [], useAi: true };

describe("reading board addresses", () => {
  it("accepts each site's board address and nothing else", () => {
    expect(parseBoardUrl("https://job-boards.greenhouse.io/gitlab")).toMatchObject({ kind: "greenhouse", slug: "gitlab" });
    expect(parseBoardUrl("boards.greenhouse.io/figma/jobs/123")).toMatchObject({ kind: "greenhouse", slug: "figma" });
    expect(parseBoardUrl("jobs.lever.co/palantir")).toMatchObject({ kind: "lever", slug: "palantir" });
    expect(parseBoardUrl("https://jobs.ashbyhq.com/notion/1fc3")).toMatchObject({ kind: "ashby", slug: "notion" });
    expect(parseBoardUrl("https://evil.example.com/acme")).toBeNull();
    expect(parseBoardUrl("https://jobs.lever.co/")).toBeNull();
    expect(parseBoardUrl("not a url at all")).toBeNull();
  });
});

describe("posting text", () => {
  it("decodes entities and keeps list items apart", () => {
    expect(decodeEntities("A &amp; B &#39;C&#39; &#x2014;")).toBe("A & B 'C' —");
    expect(htmlToText("<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Hello & welcome\n\n- One\n- Two",
    );
  });
});

describe("fetchBoard", () => {
  it("reads Greenhouse, decoding its escaped HTML", async () => {
    const jobs = await fetchBoard({ kind: "greenhouse", slug: "acme" }, fakeBoards());
    expect(jobs[0]).toMatchObject({
      title: "Senior TypeScript Engineer",
      company: "Acme",
      location: "Milan, Italy",
      postedAt: "2026-11-01T10:00:00Z",
    });
    expect(jobs[0]!.description).toContain("TypeScript and Postgres & love tests.");
    expect(jobs[0]!.description).toContain("- Ship weekly");
  });

  it("reads Lever, joining its description parts", async () => {
    const [first] = await fetchBoard({ kind: "lever", slug: "initech" }, fakeBoards());
    expect(first!.description).toContain("Build APIs in Go.");
    expect(first!.description).toContain("Requirements\n- Postgres");
    expect(first!.location).toBe("Remote, Europe");
  });

  it("reads Ashby, skipping unlisted jobs and noting remote ones", async () => {
    const jobs = await fetchBoard({ kind: "ashby", slug: "globex" }, fakeBoards());
    expect(jobs.map((j) => j.title)).toEqual(["Platform Engineer"]);
    expect(jobs[0]!.location).toBe("Berlin · Remote");
  });

  it("explains a board that doesn't exist", async () => {
    await expect(fetchBoard({ kind: "lever", slug: "nobody" }, fakeBoards())).rejects.toThrow(
      'No public job board found for "nobody"',
    );
  });
});

describe("filters and scores", () => {
  it("matches whole words only", () => {
    expect(mentions("We love Go and Rust", "go")).toBe(true);
    expect(mentions("Google Cloud", "go")).toBe(false);
    expect(mentions("C++ experience", "C++")).toBe(true);
  });

  it("applies keywords, exclusions and locations", () => {
    const prefs = { ...allPrefs, keywords: ["engineer"], exclude: ["senior"], locations: ["italy", "remote"] };
    expect(passesPreferences(job({ title: "Engineer" }), prefs)).toBe(true);
    expect(passesPreferences(job({ title: "Senior Engineer" }), prefs)).toBe(false);
    expect(passesPreferences(job({ title: "Designer" }), prefs)).toBe(false);
    expect(passesPreferences(job({ title: "Engineer", location: "Austin, TX" }), prefs)).toBe(false);
    expect(passesPreferences(job({ title: "Engineer", location: "Remote, US" }), prefs)).toBe(true);
    expect(passesPreferences(job(), allPrefs)).toBe(true);
  });

  it("scores by the share of skills mentioned", () => {
    expect(ruleScore(job(), ["TypeScript", "Postgres", "Rust", "Go"])).toEqual({
      score: 50,
      matched: ["TypeScript", "Postgres"],
    });
    expect(ruleScore(job(), []).score).toBe(0);
  });
});

describe("rankWithAi", () => {
  it("keeps only known jobs, clamps scores, and marks postings untrusted", async () => {
    const generate = vi.fn(async () => ({
      scores: [
        { id: "a", score: 140, reason: "Strong TypeScript match" },
        { id: "made-up", score: 90, reason: "?" },
      ],
    }));
    const scores = await rankWithAi(generate as never, buildFacts(EMPTY_PROFILE, []), [
      { id: "a", title: "Engineer", company: "X", location: "", description: "y".repeat(5000) },
    ]);
    expect([...scores]).toEqual([["a", { score: 100, reason: "Strong TypeScript match" }]]);
    const request = (generate.mock.calls[0] as unknown as [{ system: string; user: string }])[0];
    expect(request.system).toContain("untrusted");
    // Each posting is cut to an excerpt so many fit in one request.
    expect(request.user.length).toBeLessThan(3000);
  });
});

describe("runDiscovery", () => {
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    store = createStore(":memory:");
    store.saveProfile({ ...EMPTY_PROFILE, skills: ["TypeScript", "Postgres", "Kubernetes"] });
  });

  it("stores matching postings from every board and ranks the best with AI", async () => {
    store.addSource("greenhouse", "acme", "https://job-boards.greenhouse.io/acme");
    store.addSource("lever", "initech", "https://jobs.lever.co/initech");
    store.addSource("ashby", "globex", "https://jobs.ashbyhq.com/globex");
    store.saveDiscoveryPreferences({ ...allPrefs, keywords: ["engineer"] });
    const generate = vi.fn(async ({ user }: { user: string }) => {
      const ids = [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]!);
      return { scores: ids.map((id, i) => ({ id, score: 90 - i * 10, reason: "fit" })) };
    });

    const summary = await runDiscovery(store, {
      generate: generate as never,
      buildFacts: (p) => buildFacts(p, []),
      fetchFn: fakeBoards(),
    });

    expect(summary).toContain("3 new matching jobs");
    const jobs = store.listDiscovered();
    expect(jobs.map((j) => j.title).sort()).toEqual([
      "Backend Engineer",
      "Platform Engineer",
      "Senior TypeScript Engineer",
    ]);
    expect(jobs.every((j) => j.aiScore !== null)).toBe(true);
    // Lever and Ashby don't name the company, so the board's name is used.
    expect(jobs.find((j) => j.title === "Backend Engineer")!.company).toBe("Initech");
    expect(store.listSources().every((s) => s.lastError === null)).toBe(true);
  });

  it("asks the AI about at most one batch of postings per run", async () => {
    store.addSource("ashby", "big", "https://jobs.ashbyhq.com/big");
    const many = Array.from({ length: AI_BATCH + 5 }, (_, i) => ({
      title: `Engineer ${i}`, location: "Remote", isListed: true, jobUrl: `https://jobs.ashbyhq.com/big/${i}`, descriptionPlain: "TypeScript",
    }));
    const generate = vi.fn(async ({ user }: { user: string }) => ({
      scores: [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => ({ id: m[1]!, score: 50, reason: "" })),
    }));
    await runDiscovery(store, {
      generate: generate as never,
      buildFacts: (p) => buildFacts(p, []),
      fetchFn: fakeBoards({ "job-board/big": () => json({ jobs: many }) }),
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.listDiscovered().filter((j) => j.aiScore !== null)).toHaveLength(AI_BATCH);
  });

  it("records a board that fails without stopping the others, and skips AI when off", async () => {
    store.addSource("lever", "nobody", "https://jobs.lever.co/nobody");
    store.addSource("lever", "initech", "https://jobs.lever.co/initech");
    store.saveDiscoveryPreferences({ ...allPrefs, useAi: false });
    const generate = vi.fn();

    const summary = await runDiscovery(store, {
      generate: generate as never,
      buildFacts: (p) => buildFacts(p, []),
      fetchFn: fakeBoards(),
    });

    expect(summary).toContain("1 board couldn't be read");
    expect(generate).not.toHaveBeenCalled();
    expect(store.listSources().find((s) => s.slug === "nobody")!.lastError).toContain("No public job board");
    expect(store.listDiscovered()).toHaveLength(1);
  });

  it("forgets postings a board stops listing, but keeps saved ones", async () => {
    const source = store.addSource("ashby", "globex", "https://jobs.ashbyhq.com/globex");
    const deps = { generate: null, buildFacts: (p: typeof EMPTY_PROFILE) => buildFacts(p, []) };
    await runDiscovery(store, { ...deps, fetchFn: fakeBoards() });
    const [found] = store.listDiscovered();
    store.setDiscoveredStatus(found!.id, "saved", "job-1");

    await runDiscovery(store, { ...deps, fetchFn: fakeBoards({ "job-board/globex": () => json({ jobs: [] }) }) });
    expect(store.listDiscovered().map((j) => j.status)).toEqual(["saved"]);
    expect(store.listSources()[0]!.id).toBe(source.id);
  });
});

describe("discovery API", () => {
  const HOST = { host: "127.0.0.1:8787" };
  const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
  let store: ReturnType<typeof createStore>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = createStore(":memory:");
    app = createApp({
      store,
      ai: { parseResume: vi.fn(), generate: vi.fn() as never },
      hasEnvClaudeKey: () => false,
      fetchBoards: fakeBoards(),
    });
  });

  const addSource = (url: string) =>
    app.request("/api/discovery/sources", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ url }) });

  it("adds a readable board and lists its jobs, rejecting others", async () => {
    expect((await addSource("https://example.com/careers")).status).toBe(400);
    const missing = await addSource("jobs.lever.co/nobody");
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("No public job board");

    const added = await (await addSource("https://jobs.ashbyhq.com/globex")).json();
    expect(added.sources).toHaveLength(1);
    expect(added.jobs.map((j: { title: string }) => j.title)).toEqual(["Platform Engineer"]);
  });

  it("saves a posting to Applications and dismisses another", async () => {
    await addSource("https://job-boards.greenhouse.io/acme");
    const state = await (await app.request("/api/discovery", { headers: HOST })).json();
    const [first, second] = state.jobs;

    const saved = await (await app.request(`/api/discovery/jobs/${first.id}/save`, { method: "POST", headers: HOST })).json();
    expect(store.getJob(saved.jobId)).toMatchObject({ title: first.title, status: "saved" });

    const after = await (await app.request(`/api/discovery/jobs/${second.id}/dismiss`, { method: "POST", headers: HOST })).json();
    expect(after.jobs.map((j: { id: string }) => j.id)).toEqual([first.id]);
  });

  it("saves preferences", async () => {
    const res = await app.request("/api/discovery/preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ keywords: ["engineer"], exclude: [], locations: ["Remote"], useAi: false }),
    });
    expect((await res.json()).preferences).toEqual({
      keywords: ["engineer"],
      exclude: [],
      locations: ["Remote"],
      useAi: false,
    });
  });
});
