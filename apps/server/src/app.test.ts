import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE, type Answer, type Profile } from "@draftline/shared";
import { createApp } from "./app.js";
import { extractionToProfile, ResumeParseError } from "./resume.js";
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
  let aiConfigured: boolean;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = createStore(":memory:");
    parseResume = vi.fn(async () => draft);
    aiConfigured = true;
    app = createApp({
      store,
      parseResume,
      isAiConfigured: () => aiConfigured,
    });
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

  it("explains when no API key is configured", async () => {
    aiConfigured = false;
    const res = await app.request("/api/resume/parse", {
      method: "POST",
      headers: HOST,
      body: pdfForm(),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("ANTHROPIC_API_KEY");
  });

  it("passes import failures through with their status", async () => {
    parseResume.mockRejectedValue(new ResumeParseError("Too many requests", 429));
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
