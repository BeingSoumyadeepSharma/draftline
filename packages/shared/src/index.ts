/**
 * Shared types and validation schemas, used by the server, the web app and the
 * Chrome extension so all three agree on the shape of the data.
 *
 * The zod schemas do two jobs:
 *   - The server validates every incoming request against them.
 *   - Some are handed to the AI provider as the exact JSON shape it must reply
 *     with (ResumeExtractionSchema, JobAnalysisOutputSchema,
 *     AnswerDraftOutputSchema). They avoid min/max limits on purpose, because
 *     AI structured-output modes don't accept them.
 *
 * Sections: profile, saved answers, AI provider settings, API payloads,
 * jobs and AI drafts.
 */
import { z } from "zod";

// --- Profile ---
const LinkSchema = z.object({ label: z.string(), url: z.string() });

const ContactSchema = z.object({
  fullName: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  links: z.array(LinkSchema),
});

/**
 * What Claude extracts from a resume. Missing values are empty strings so the
 * model has no reason to guess. Stored records add ids (see ProfileSchema),
 * which later phases use to trace generated text back to a source fact.
 */
export const ResumeExtractionSchema = z.object({
  contact: ContactSchema,
  summary: z.string(),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      bullets: z.array(z.string()),
    }),
  ),
  education: z.array(
    z.object({
      school: z.string(),
      degree: z.string(),
      field: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      details: z.string(),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      description: z.string(),
    }),
  ),
  certifications: z.array(
    z.object({ name: z.string(), issuer: z.string(), date: z.string() }),
  ),
  skills: z.array(z.string()),
});
export type ResumeExtraction = z.infer<typeof ResumeExtractionSchema>;

const BulletSchema = z.object({ id: z.string(), text: z.string() });

export const ProfileSchema = z.object({
  contact: ContactSchema,
  summary: z.string(),
  experience: z.array(
    z.object({
      id: z.string(),
      company: z.string(),
      title: z.string(),
      location: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      bullets: z.array(BulletSchema),
    }),
  ),
  education: z.array(
    z.object({
      id: z.string(),
      school: z.string(),
      degree: z.string(),
      field: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      details: z.string(),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      description: z.string(),
    }),
  ),
  certifications: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      issuer: z.string(),
      date: z.string(),
    }),
  ),
  skills: z.array(z.string()),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const EMPTY_PROFILE: Profile = {
  contact: { fullName: "", email: "", phone: "", location: "", links: [] },
  summary: "",
  experience: [],
  education: [],
  projects: [],
  certifications: [],
  skills: [],
};

// --- Saved answers ---
export const ANSWER_CATEGORIES = [
  "work_authorization",
  "compensation",
  "demographics",
  "logistics",
  "general",
] as const;

export const AnswerCategorySchema = z.enum(ANSWER_CATEGORIES);
export type AnswerCategory = z.infer<typeof AnswerCategorySchema>;

/** Answers in these categories must only ever come from what the user saved. */
export const SENSITIVE_CATEGORIES: readonly AnswerCategory[] = [
  "work_authorization",
  "compensation",
  "demographics",
];

export const AnswerInputSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string(),
  category: AnswerCategorySchema,
});
export type AnswerInput = z.infer<typeof AnswerInputSchema>;
export type Answer = AnswerInput & { id: string };

// --- AI provider settings ---
export const AI_PROVIDERS = ["anthropic", "openai_compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** API keys may only travel over HTTPS, unless the model runs on this machine. */
function isSafeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export const AiSettingsInputSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    baseUrl: z.string().trim(),
    model: z.string().trim(),
    /** Blank keeps the saved key, as long as the destination hasn't changed. */
    apiKey: z.string().trim(),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "openai_compatible") return;
    if (!isSafeBaseUrl(value.baseUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Base URL must use https, or http on localhost",
      });
    }
    if (!value.model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "Enter a model name",
      });
    }
  });
export type AiSettingsInput = z.infer<typeof AiSettingsInputSchema>;

/** What the browser may see. The API key itself never leaves the server. */
export type AiSettingsView = {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  configured: boolean;
};

// --- Extension and API payloads ---
/** Derived from the public key in apps/extension/manifest.json. */
export const EXTENSION_ID = "nlonealbggknmcmnccjjbgndhmfnoipm";

export type ResumeFileMeta = { name: string; uploadedAt: string };
export type ResumeFilePayload = { name: string; base64: string };

export type Status = { aiConfigured: boolean };
export type ResumeParseResult = { profile: Profile };
export type ApiError = { error: string };

// --- Jobs and AI drafts (Phase 3) ---

export const JobInputSchema = z.object({
  url: z
    .string()
    .max(2000)
    .refine((url) => /^https?:\/\//.test(url), "Invalid job URL"),
  title: z.string().max(300),
  company: z.string().max(300),
  location: z.string().max(300),
  description: z.string().min(200).max(60_000),
});
export type JobInput = z.infer<typeof JobInputSchema>;

/** A fact from the profile or saved answers that AI output can cite. */
export type Source = { id: string; label: string; text: string };

export type JobAnalysis = {
  summary: string;
  mustHaves: string[];
  niceToHaves: string[];
  /** 0-100: how much of the must-haves the profile clearly covers. */
  score: number;
  verdict: string;
  strengths: Array<{ point: string; sources: Source[] }>;
  gaps: string[];
};

export type JobRecord = {
  id: string;
  url: string;
  title: string;
  company: string;
  location: string;
  analysis: JobAnalysis | null;
  analyzedAt: string | null;
};

export const QuestionInputSchema = z.object({
  key: z.string().min(1).max(500),
  label: z.string().min(1).max(1000),
  kind: z.enum(["text", "textarea", "select", "radio"]),
  options: z.array(z.string().max(500)).max(300),
  maxLength: z.number().int().positive().nullable(),
});
export type QuestionInput = z.infer<typeof QuestionInputSchema>;

export const DraftRequestSchema = z.object({
  questions: z.array(QuestionInputSchema).min(1).max(40),
});

export type AnswerDraft = {
  key: string;
  /** Empty when the profile doesn't support an answer. */
  answer: string;
  sources: Source[];
  note: string;
  /** Non-empty answer that cites no known fact. */
  unsupported: boolean;
  tooLong: boolean;
};

/** What the model returns for a job analysis, before ids are resolved. */
export const JobAnalysisOutputSchema = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  summary: z.string(),
  mustHaves: z.array(z.string()),
  niceToHaves: z.array(z.string()),
  score: z.number(),
  verdict: z.string(),
  strengths: z.array(
    z.object({ point: z.string(), sourceIds: z.array(z.string()) }),
  ),
  gaps: z.array(z.string()),
});

/** What the model returns for answer drafts, before checks. */
export const AnswerDraftOutputSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      answer: z.string(),
      sourceIds: z.array(z.string()),
      note: z.string(),
    }),
  ),
});

// --- Tailored documents (Phase 4) ---

export const DOCUMENT_KINDS = ["resume", "cover_letter"] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/**
 * A tailored resume is a selection from the profile, stored as ids, never as
 * copied text: which roles, which of their bullets in what order, which
 * projects and skills, plus a summary written for this job. The PDF is built
 * from the profile's own wording, so nothing in it can be invented.
 */
export const TailoredResumeSchema = z.object({
  summary: z.string().max(3000),
  roles: z
    .array(z.object({ roleId: z.string(), bulletIds: z.array(z.string()).max(50) }))
    .max(50),
  projectIds: z.array(z.string()).max(50),
  skills: z.array(z.string().max(200)).max(200),
});
export type TailoredResume = z.infer<typeof TailoredResumeSchema>;

/** A cover letter body: paragraphs separated by blank lines. */
export const CoverLetterSchema = z.object({ body: z.string().max(12_000) });
export type CoverLetter = z.infer<typeof CoverLetterSchema>;

type DocumentState = {
  /** Approved documents have a stored PDF the extension can attach. */
  status: "draft" | "approved";
  /** Profile facts the AI said it used, for the summary or letter. */
  sources: Source[];
  note: string;
  updatedAt: string;
  approvedAt: string | null;
};
export type ResumeDocument = DocumentState & { content: TailoredResume };
export type CoverLetterDocument = DocumentState & { content: CoverLetter };
export type JobDocuments = {
  resume: ResumeDocument | null;
  coverLetter: CoverLetterDocument | null;
};

/** One row in the web app's list of applications. */
export type JobListItem = {
  id: string;
  url: string;
  title: string;
  company: string;
  score: number | null;
  resumeStatus: "draft" | "approved" | null;
  coverLetterStatus: "draft" | "approved" | null;
  updatedAt: string;
};

/** What the model returns when tailoring a resume, before checks. */
export const TailoredResumeOutputSchema = z.object({
  summary: z.string(),
  summarySourceIds: z.array(z.string()),
  roles: z.array(z.object({ roleId: z.string(), bulletIds: z.array(z.string()) })),
  projectIds: z.array(z.string()),
  skills: z.array(z.string()),
  note: z.string(),
});

/** What the model returns when drafting a cover letter, before checks. */
export const CoverLetterOutputSchema = z.object({
  paragraphs: z.array(z.string()),
  sourceIds: z.array(z.string()),
  note: z.string(),
});
