/**
 * Tests for application tracking: upgrading an older database, status rules
 * and follow-up dates, marking jobs applied, and the tracker API.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { addDays, createStore, today } from "./store.js";

const job = {
  url: "https://jobs.example.com/1",
  title: "Engineer",
  company: "Acme",
  location: "Remote",
  description: "Build things. ".repeat(30),
};

describe("upgrading a database from before tracking", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(path.join(tmpdir(), "draftline-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the tracking columns and keeps existing jobs", () => {
    const file = path.join(dir, "draftline.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      company TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
      analysis TEXT, analyzed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.prepare(
      "INSERT INTO jobs VALUES ('j1', 'https://x.com/1', 'Old job', 'Old Co', '', 'desc', NULL, NULL, 'then', 'then')",
    ).run();
    old.close();

    const store = createStore(file);
    const row = store.getJob("j1")!;
    expect(row).toMatchObject({ title: "Old job", status: "saved", appliedAt: null, notes: "" });
    // Opening it again must not try to add the columns twice.
    expect(() => createStore(file)).not.toThrow();
  });
});

describe("tracking rules", () => {
  let store: ReturnType<typeof createStore>;
  let id: string;
  beforeEach(() => {
    store = createStore(":memory:");
    id = store.upsertJob(job).id;
  });

  it("stamps the date and sets a follow-up a week out when applied", () => {
    const row = store.updateTracking(id, { status: "applied" })!;
    expect(row.status).toBe("applied");
    expect(row.appliedAt).not.toBeNull();
    expect(row.followUpAt).toBe(addDays(today(), 7));
    expect(store.listEvents(id)[0]!.text).toBe("Status changed from Saved to Applied");
  });

  it("clears the follow-up on a final status, unless one is given", () => {
    store.updateTracking(id, { status: "applied" });
    expect(store.updateTracking(id, { status: "rejected" })!.followUpAt).toBeNull();
    const offer = store.updateTracking(id, { status: "offer", followUpAt: "2030-01-01" })!;
    expect(offer.followUpAt).toBe("2030-01-01");
  });

  it("keeps notes and logs follow-up changes", () => {
    store.updateTracking(id, { notes: "Spoke to Maria", followUpAt: "2030-02-02" });
    const row = store.getJob(id)!;
    expect(row.notes).toBe("Spoke to Maria");
    expect(store.listEvents(id)[0]!.text).toBe("Follow-up set for 2030-02-02");
  });

  it("marks an unseen job applied by creating it", () => {
    const row = store.markApplied({
      url: "https://new.example.com/9",
      title: "New role",
      company: "NewCo",
      source: "detected",
    });
    expect(row).toMatchObject({ title: "New role", status: "applied" });
    expect(store.listEvents(row.id).map((e) => e.text)).toContain(
      "Submission detected on the site's confirmation page",
    );
  });

  it("doesn't move a job back to Applied once it's further along", () => {
    store.updateTracking(id, { status: "interviewing" });
    const row = store.markApplied({ url: job.url, title: "", company: "", source: "manual" });
    expect(row.status).toBe("interviewing");
  });

  it("counts follow-ups due on a date, for active applications only", () => {
    store.updateTracking(id, { status: "applied", followUpAt: "2026-01-10" });
    const other = store.upsertJob({ ...job, url: "https://jobs.example.com/2" }).id;
    store.updateTracking(other, { status: "rejected", followUpAt: "2026-01-01" });
    expect(store.countDueFollowUps("2026-01-09")).toBe(0);
    expect(store.countDueFollowUps("2026-01-10")).toBe(1);
  });
});

describe("tracker API", () => {
  const HOST = { host: "127.0.0.1:8787" };
  const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
  let store: ReturnType<typeof createStore>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = createStore(":memory:");
    app = createApp({
      store,
      ai: { parseResume: vi.fn(), generate: vi.fn() as never },
      hasEnvClaudeKey: () => true,
    });
  });

  it("updates tracking and rejects bad dates", async () => {
    const { id } = store.upsertJob(job);
    const bad = await app.request(`/api/jobs/${id}/tracking`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ followUpAt: "next week" }),
    });
    expect(bad.status).toBe(400);

    const good = await app.request(`/api/jobs/${id}/tracking`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "interviewing" }),
    });
    expect((await good.json()).status).toBe("interviewing");

    const events = await (await app.request(`/api/jobs/${id}/events`, { headers: HOST })).json();
    expect(events[0].text).toContain("Interviewing");
  });

  it("marks a job applied and reports due follow-ups", async () => {
    const res = await app.request("/api/jobs/applied", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: job.url, title: "Engineer", source: "manual" }),
    });
    const record = await res.json();
    expect(record.status).toBe("applied");

    store.updateTracking(record.id, { followUpAt: today() });
    const due = await (await app.request("/api/tracker/due", { headers: HOST })).json();
    expect(due).toEqual({ count: 1 });
  });
});
