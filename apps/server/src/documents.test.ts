/**
 * Tests for tailored documents: the checks applied to AI tailoring, the PDFs
 * built from it (read back with unpdf), and the generate, edit, approve and
 * attach flow through the API. Uses a fake AI and an in-memory database.
 */
import { extractText } from "unpdf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE, type Profile } from "@draftline/shared";
import { createApp } from "./app.js";
import { cleanTailoredResume, draftCoverLetter, tailorResume } from "./documents.js";
import { buildFacts } from "./jobs.js";
import { renderCoverLetter, renderResume } from "./pdf.js";
import { createStore } from "./store.js";

const profile: Profile = {
  ...EMPTY_PROFILE,
  contact: {
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+39 000",
    location: "Milano, Italy",
    links: [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }],
  },
  experience: [
    {
      id: "r1",
      company: "Acme",
      title: "Engineer",
      location: "Milano",
      startDate: "2020",
      endDate: "Present",
      bullets: [
        { id: "b1", text: "Built a payments platform" },
        { id: "b2", text: "Ran the hiring loop" },
        { id: "b3", text: "Cut cloud costs by 30%" },
      ],
    },
    {
      id: "r2",
      company: "Initech",
      title: "Intern",
      location: "",
      startDate: "2019",
      endDate: "2020",
      bullets: [{ id: "b4", text: "Wrote internal tools" }],
    },
  ],
  projects: [{ id: "p1", name: "Ledger", url: "", description: "Open-source accounting" }],
  education: [
    { id: "e1", school: "Politecnico di Milano", degree: "MSc", field: "Computer Science", startDate: "2017", endDate: "2019", details: "" },
  ],
  skills: ["TypeScript", "Postgres", "Kubernetes"],
};

const job = {
  url: "https://jobs.example.com/1",
  title: "Payments Engineer",
  company: "Example",
  location: "Remote",
  description: "Build payment systems with TypeScript. ".repeat(10),
};

const pdfText = async (pdf: Buffer) =>
  (await extractText(new Uint8Array(pdf), { mergePages: true })).text;

describe("cleanTailoredResume", () => {
  it("keeps only real ids, under their own role, and restores dropped roles", () => {
    const cleaned = cleanTailoredResume(profile, {
      summary: " Hi ",
      roles: [{ roleId: "r1", bulletIds: ["b3", "b1", "b4", "fake", "b3"] }],
      projectIds: ["p1", "nope"],
      skills: ["typescript", "Rust", "Postgres"],
    });
    expect(cleaned.roles).toEqual([
      { roleId: "r1", bulletIds: ["b3", "b1"] },
      { roleId: "r2", bulletIds: ["b4"] },
    ]);
    expect(cleaned.projectIds).toEqual(["p1"]);
    expect(cleaned.skills).toEqual(["TypeScript", "Postgres"]);
    expect(cleaned.summary).toBe("Hi");
  });
});

describe("AI drafts", () => {
  const facts = buildFacts(profile, []);

  it("flags a resume summary that cites nothing", async () => {
    const generate = vi.fn(async () => ({
      summary: "Payments engineer.",
      summarySourceIds: [],
      roles: [{ roleId: "r1", bulletIds: ["b1"] }],
      projectIds: [],
      skills: ["TypeScript"],
      note: "Emphasized payments.",
    }));
    const draft = await tailorResume(generate as never, facts, profile, job);
    expect(draft.note).toContain("Emphasized payments.");
    expect(draft.note).toContain("doesn't cite");
    const request = (generate.mock.calls[0] as unknown as [{ system: string }])[0];
    expect(request.system).toContain("never write new experience");
  });

  it("joins cover letter paragraphs and resolves sources", async () => {
    const generate = vi.fn(async () => ({
      paragraphs: ["First.", " ", "Second."],
      sourceIds: ["b1", "invented"],
      note: "Add why you like Example.",
    }));
    const draft = await draftCoverLetter(generate as never, facts, job);
    expect(draft.content.body).toBe("First.\n\nSecond.");
    expect(draft.sources.map((s) => s.id)).toEqual(["b1"]);
  });
});

describe("PDFs", () => {
  it("prints the chosen bullets in order and leaves the others out", async () => {
    const text = await pdfText(
      await renderResume(profile, {
        summary: "Payments engineer with TypeScript.",
        roles: [
          { roleId: "r1", bulletIds: ["b3", "b1"] },
          { roleId: "r2", bulletIds: [] },
        ],
        projectIds: [],
        skills: ["TypeScript"],
      }),
    );
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("ada@example.com");
    expect(text).toContain("Payments engineer with TypeScript.");
    expect(text.indexOf("Cut cloud costs")).toBeLessThan(text.indexOf("Built a payments"));
    expect(text).not.toContain("Ran the hiring loop");
    expect(text).toContain("Intern, Initech");
    expect(text).not.toContain("Ledger");
    expect(text).toContain("Politecnico di Milano");
  });

  it("builds a cover letter with greeting, paragraphs and sign-off", async () => {
    const text = await pdfText(
      await renderCoverLetter(profile, "Example", { body: "First paragraph.\n\nSecond paragraph." }, new Date("2026-11-11")),
    );
    expect(text).toContain("11 November 2026");
    expect(text).toContain("Dear Hiring Team at Example,");
    expect(text).toContain("Second paragraph.");
    expect(text).toContain("Sincerely,");
  });
});

describe("document API", () => {
  const HOST = { host: "127.0.0.1:8787" };
  const JSON_HEADERS = { ...HOST, "content-type": "application/json" };
  let store: ReturnType<typeof createStore>;
  let generate: ReturnType<typeof vi.fn>;
  let app: ReturnType<typeof createApp>;
  let jobId: string;

  beforeEach(() => {
    store = createStore(":memory:");
    store.saveProfile(profile);
    generate = vi.fn();
    app = createApp({
      store,
      ai: { parseResume: vi.fn(), generate: generate as never },
      hasEnvClaudeKey: () => true,
    });
    jobId = store.upsertJob(job).id;
  });

  const call = (path: string, method = "GET", body?: unknown) =>
    app.request(`/api/jobs/${jobId}/documents${path}`, {
      method,
      headers: body ? JSON_HEADERS : HOST,
      body: body ? JSON.stringify(body) : undefined,
    });

  it("goes from AI draft to edited, approved and attachable", async () => {
    generate.mockResolvedValue({
      summary: "Payments engineer.",
      summarySourceIds: ["b1"],
      roles: [{ roleId: "r1", bulletIds: ["b1", "b2"] }],
      projectIds: [],
      skills: ["TypeScript"],
      note: "",
    });

    const generated = await (await call("/resume/generate", "POST")).json();
    expect(generated.resume.status).toBe("draft");
    expect((await call("/resume/file")).status).toBe(404);

    const edited = await (
      await call("/resume", "PUT", {
        content: { ...generated.resume.content, roles: [{ roleId: "r1", bulletIds: ["b2"] }] },
      })
    ).json();
    expect(edited.resume.content.roles[0].bulletIds).toEqual(["b2"]);

    const preview = await call("/resume/preview");
    expect(preview.headers.get("content-type")).toBe("application/pdf");

    const approved = await (await call("/resume/approve", "POST")).json();
    expect(approved.resume.status).toBe("approved");

    const file = await (await call("/resume/file")).json();
    expect(file.name).toBe("Ada Lovelace - Resume - Example.pdf");
    const text = await pdfText(Buffer.from(file.base64, "base64"));
    expect(text).toContain("Ran the hiring loop");
    expect(text).not.toContain("Built a payments platform");

    const list = await (await app.request("/api/jobs", { headers: HOST })).json();
    expect(list[0]).toMatchObject({ id: jobId, resumeStatus: "approved", coverLetterStatus: null });
  });

  it("withdraws an approval when the draft is edited again", async () => {
    generate.mockResolvedValue({ paragraphs: ["Hello."], sourceIds: [], note: "" });
    await call("/cover_letter/generate", "POST");
    await call("/cover_letter/approve", "POST");
    expect((await call("/cover_letter/file")).status).toBe(200);

    await call("/cover_letter", "PUT", { content: { body: "Changed." } });
    expect((await call("/cover_letter/file")).status).toBe(404);
  });

  it("rejects unknown document types and missing drafts", async () => {
    expect((await call("/photo/generate", "POST")).status).toBe(400);
    expect((await call("/resume/approve", "POST")).status).toBe(404);
  });
});
