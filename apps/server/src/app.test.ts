/**
 * API tests. Each runs createApp against an in-memory database and a fake AI,
 * so no network, AI provider or real data is involved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PROFILE,
  EXTENSION_ID,
  type Answer,
  type Profile,
} from "@draftline/shared";
import { createApp } from "./app.js";
import { AiError } from "./ai-error.js";
import { extractionToProfile } from "./resume.js";
import { createStore } from "./store.js";

const HOST = { host: "127.0.0.1:8787" };
const JSON_HEADERS = { ...HOST, "content-type": "application/json" };

const draft: Profile = {
  ...EMPTY_PROFILE,
  contact: { ...EMPTY_PROFILE.contact, fullName: "Test Person" },
};

function pdfForm(bytes = "%PDF-1.7 fake") {
  const form = new FormData();
  form.set("file", new File([bytes], "resume.pdf"));
  return form;
}

describe("api", () => {
  let store: ReturnType<typeof createStore>;
  let parseResume: ReturnType<typeof vi.fn<(pdf: Buffer) => Promise<Profile>>>;
  let generate: ReturnType<typeof vi.fn>;
  let aiConfigured: boolean;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = createStore(":memory:");
    parseResume = vi.fn(async () => draft);
    generate = vi.fn();
    aiConfigured = true;
    app = createApp({
      store,
      ai: { parseResume, generate: generate as never },
      hasEnvClaudeKey: () => aiConfigured,
    });
  });

  const saveAi = (body: object) =>
    app.request("/api/settings/ai", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  const compatible = {
    provider: "openai_compatible",
    baseUrl: "https://api.example.com/v1/",
    model: "some-model",
    apiKey: "secret-key",
  };

  it("never returns a saved API key to the browser", async () => {
    const res = await saveAi(compatible);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret-key");
    expect(JSON.parse(text)).toMatchObject({ hasApiKey: true, configured: true });
    expect(store.getAiConfig()?.baseUrl).toBe("https://api.example.com/v1");
  });

  it("keeps the key when left blank for the same destination", async () => {
    await saveAi(compatible);
    await saveAi({ ...compatible, model: "other-model", apiKey: "" });
    expect(store.getAiConfig()).toMatchObject({
      model: "other-model",
      apiKey: "secret-key",
    });
  });

  it("drops the key when the destination changes", async () => {
    await saveAi(compatible);
    await saveAi({
      ...compatible,
      baseUrl: "https://other.example.com/v1",
      apiKey: "",
    });
    expect(store.getAiConfig()?.apiKey).toBe("");
  });

  it("allows http only for a model on this machine", async () => {
    const remote = await saveAi({ ...compatible, baseUrl: "http://api.example.com/v1" });
    expect(remote.status).toBe(400);

    const local = await saveAi({
      ...compatible,
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
    });
    expect(local.status).toBe(200);
  });

  it("requires a model for compatible APIs", async () => {
    const res = await saveAi({ ...compatible, model: " " });
    expect(res.status).toBe(400);
  });

  it("counts a keyless local provider as configured", async () => {
    aiConfigured = false;
    await saveAi({
      ...compatible,
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
    });
    const res = await app.request("/api/status", { headers: HOST });
    expect(await res.json()).toEqual({ aiConfigured: true });
  });

  it("rejects unknown hosts and cross-site origins", async () => {
    const badHost = await app.request("/api/profile", {
      headers: { host: "evil.example:8787" },
    });
    expect(badHost.status).toBe(403);

    const badOrigin = await app.request("/api/profile", {
      method: "PUT",
      headers: { ...JSON_HEADERS, origin: "https://evil.example" },
      body: JSON.stringify(draft),
    });
    expect(badOrigin.status).toBe(403);
    expect(store.getProfile()).toEqual(EMPTY_PROFILE);
  });

  it("allows the web app's origin", async () => {
    const res = await app.request("/api/profile", {
      headers: { ...HOST, origin: "http://127.0.0.1:5173" },
    });
    expect(res.status).toBe(200);
  });

  const job = {
    url: "https://jobs.example.com/1",
    title: "Engineer",
    company: "Acme",
    location: "Remote",
    description: "We need someone who builds payment systems. ".repeat(10),
  };
  const analysisOutput = {
    title: "Engineer",
    company: "Acme",
    location: "Remote",
    summary: "Build payments.",
    mustHaves: ["Payments"],
    niceToHaves: [],
    score: 140,
    verdict: "Good fit.",
    strengths: [{ point: "Payments work", sourceIds: ["summary", "made-up"] }],
    gaps: [],
  };
  const analyze = (refresh = false) =>
    app.request(`/api/jobs/analyze${refresh ? "?refresh=1" : ""}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(job),
    });

  it("analyzes a job once and returns the saved result after", async () => {
    store.saveProfile({ ...draft, summary: "I build payment systems." });
    generate.mockResolvedValue(analysisOutput);

    const first = await analyze();
    expect(first.status).toBe(200);
    const record = await first.json();
    expect(record.analysis.score).toBe(100);
    expect(record.analysis.strengths[0].sources.map((s: { id: string }) => s.id)).toEqual([
      "summary",
    ]);

    await analyze();
    expect(generate).toHaveBeenCalledTimes(1);
    await analyze(true);
    expect(generate).toHaveBeenCalledTimes(2);

    const lookup = await app.request(
      `/api/jobs/lookup?url=${encodeURIComponent(job.url)}`,
      { headers: HOST },
    );
    expect((await lookup.json()).id).toBe(record.id);
  });

  it("refuses to analyze without enough description or an AI provider", async () => {
    const short = await app.request("/api/jobs/analyze", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...job, description: "Too short" }),
    });
    expect(short.status).toBe(400);

    aiConfigured = false;
    expect((await analyze()).status).toBe(503);
    expect(generate).not.toHaveBeenCalled();

    // Saving the job for tracking needs no AI provider.
    const saved = await app.request("/api/jobs/analyze?save_only=1", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(job),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).status).toBe("saved");
  });

  it("passes AI failures through with their status", async () => {
    generate.mockRejectedValue(new AiError("Rate limited", 429));
    const res = await analyze();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Rate limited");
  });

  it("drafts answers for a saved job", async () => {
    generate.mockResolvedValueOnce(analysisOutput);
    const { id } = await (await analyze()).json();
    generate.mockResolvedValueOnce({
      answers: [{ key: "q1", answer: "I build payments.", sourceIds: [], note: "" }],
    });

    const res = await app.request(`/api/jobs/${id}/answers`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        questions: [
          { key: "q1", label: "Tell us about you", kind: "textarea", options: [], maxLength: null },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).answers[0]).toMatchObject({
      key: "q1",
      answer: "I build payments.",
      unsupported: true,
    });
  });

  it("allows only Draftline's own extension", async () => {
    const own = await app.request("/api/profile", {
      headers: { ...HOST, origin: `chrome-extension://${EXTENSION_ID}` },
    });
    expect(own.status).toBe(200);

    const other = await app.request("/api/profile", {
      headers: { ...HOST, origin: "chrome-extension://abcdefghijklmnop" },
    });
    expect(other.status).toBe(403);
  });

  it("stores a resume file and returns it for attaching", async () => {
    const empty = await app.request("/api/resume/meta", { headers: HOST });
    expect(await empty.json()).toBeNull();

    const bytes = "%PDF-1.7 fake";
    const saved = await app.request("/api/resume/file", {
      method: "PUT",
      headers: HOST,
      body: pdfForm(bytes),
    });
    expect(saved.status).toBe(200);

    const file = await app.request("/api/resume/file", { headers: HOST });
    const payload = (await file.json()) as { name: string; base64: string };
    expect(payload.name).toBe("resume.pdf");
    expect(Buffer.from(payload.base64, "base64").toString()).toBe(bytes);
  });

  it("refuses to store a file that is not a PDF", async () => {
    const res = await app.request("/api/resume/file", {
      method: "PUT",
      headers: HOST,
      body: pdfForm("not a pdf"),
    });
    expect(res.status).toBe(400);
  });

  it("saves a valid profile and rejects an invalid one", async () => {
    const saved = await app.request("/api/profile", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(draft),
    });
    expect(saved.status).toBe(200);
    expect(store.getProfile().contact.fullName).toBe("Test Person");

    const invalid = await app.request("/api/profile", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ contact: {} }),
    });
    expect(invalid.status).toBe(400);
  });

  it("returns an imported resume as a draft without saving it", async () => {
    const res = await app.request("/api/resume/parse", {
      method: "POST",
      headers: HOST,
      body: pdfForm(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).profile.contact.fullName).toBe("Test Person");
    expect(store.getProfile()).toEqual(EMPTY_PROFILE);
  });

  it("rejects files that are not PDFs without calling Claude", async () => {
    const res = await app.request("/api/resume/parse", {
      method: "POST",
      headers: HOST,
      body: pdfForm("not a pdf"),
    });
    expect(res.status).toBe(400);
    expect(parseResume).not.toHaveBeenCalled();
  });

  it("explains when no AI provider is configured", async () => {
    aiConfigured = false;
    const res = await app.request("/api/resume/parse", {
      method: "POST",
      headers: HOST,
      body: pdfForm(),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("AI settings");
  });

  it("passes import failures through with their status", async () => {
    parseResume.mockRejectedValue(new AiError("Too many requests", 429));
    const res = await app.request("/api/resume/parse", {
      method: "POST",
      headers: HOST,
      body: pdfForm(),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too many requests");
  });

  it("seeds blank starter answers once", async () => {
    const answers = store.listAnswers();
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => a.answer === "")).toBe(true);
  });

  it("creates, updates, and deletes answers", async () => {
    const created = await app.request("/api/answers", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        question: "Favorite language?",
        answer: "TypeScript",
        category: "general",
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as Answer;

    const updated = await app.request(`/api/answers/${id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        question: "Favorite language?",
        answer: "Go",
        category: "general",
      }),
    });
    expect(((await updated.json()) as Answer).answer).toBe("Go");

    const deleted = await app.request(`/api/answers/${id}`, {
      method: "DELETE",
      headers: HOST,
    });
    expect(deleted.status).toBe(204);
    expect(store.listAnswers().some((a) => a.id === id)).toBe(false);
  });

  it("rejects a blank question", async () => {
    const res = await app.request("/api/answers", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ question: "  ", answer: "", category: "general" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("extractionToProfile", () => {
  it("gives every role and bullet a unique id and keeps the text", () => {
    const profile = extractionToProfile({
      ...EMPTY_PROFILE,
      experience: [
        {
          company: "Acme",
          title: "Engineer",
          location: "",
          startDate: "2020",
          endDate: "Present",
          bullets: ["Shipped A", "Shipped B"],
        },
      ],
      education: [],
      projects: [],
      certifications: [],
    });
    const role = profile.experience[0]!;
    expect(role.bullets.map((b) => b.text)).toEqual(["Shipped A", "Shipped B"]);
    const ids = [role.id, ...role.bullets.map((b) => b.id)];
    expect(new Set(ids).size).toBe(3);
  });
});
