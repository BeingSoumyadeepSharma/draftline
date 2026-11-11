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
} & Tracking;

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
} & Tracking;

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

// --- Application tracking (Phase 6) ---

export const APPLICATION_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
] as const;
export const ApplicationStatusSchema = z.enum(APPLICATION_STATUSES);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** Statuses that still need a nudge, so their follow-up dates count. */
export const ACTIVE_STATUSES: readonly ApplicationStatus[] = ["applied", "interviewing"];

/** A date with no time, like "2026-11-18". */
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-18");

/** Changes from the tracker. Leaving a field out keeps it as it is. */
export const TrackingUpdateSchema = z.object({
  status: ApplicationStatusSchema.optional(),
  followUpAt: DateOnlySchema.nullable().optional(),
  notes: z.string().max(10_000).optional(),
});
export type TrackingUpdate = z.infer<typeof TrackingUpdateSchema>;

/** Sent when the user marks a job applied, or the extension sees it happen. */
export const MarkAppliedSchema = z.object({
  url: z
    .string()
    .max(2000)
    .refine((url) => /^https?:\/\//.test(url), "Invalid job URL"),
  title: z.string().max(300).default(""),
  company: z.string().max(300).default(""),
  source: z.enum(["detected", "manual"]),
});
export type MarkApplied = z.infer<typeof MarkAppliedSchema>;

export type Tracking = {
  status: ApplicationStatus;
  appliedAt: string | null;
  followUpAt: string | null;
  notes: string;
};

/** One line in a job's timeline. */
export type JobEvent = { at: string; text: string };

// --- Job discovery (Phase 7) ---

export const BOARD_KINDS = ["greenhouse", "lever", "ashby"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

/** A company job board Draftline checks for new jobs. */
export type DiscoverySource = {
  id: string;
  kind: BoardKind;
  slug: string;
  /** The company's name, from the board when it gives one. */
  label: string;
  url: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  jobCount: number;
};

const termList = z.array(z.string().trim().min(1).max(100)).max(30);

/** What to keep from each board. Empty lists don't filter anything. */
export const DiscoveryPreferencesSchema = z.object({
  /** At least one must appear in the job title. */
  keywords: termList,
  /** None may appear in the job title. */
  exclude: termList,
  /** At least one must appear in the job's location. */
  locations: termList,
  /** Whether to ask the AI to score the most promising new jobs. */
  useAi: z.boolean(),
});
export type DiscoveryPreferences = z.infer<typeof DiscoveryPreferencesSchema>;

export const AddSourceSchema = z.object({ url: z.string().trim().min(1).max(500) });

export type DiscoveredJob = {
  id: string;
  sourceId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  postedAt: string | null;
  firstSeenAt: string;
  /** 0-100 from how many profile skills the posting mentions. No AI. */
  ruleScore: number;
  matchedSkills: string[];
  /** 0-100 AI fit estimate, for the jobs it was asked to rank. */
  aiScore: number | null;
  aiReason: string;
  status: "new" | "saved" | "dismissed";
  /** The tracker's job, once saved to Applications. */
  jobId: string | null;
};

export type DiscoveryState = {
  preferences: DiscoveryPreferences;
  sources: DiscoverySource[];
  jobs: DiscoveredJob[];
  lastRunAt: string | null;
  lastRunSummary: string;
  running: boolean;
};

/** What the model returns when ranking several jobs at once, before checks. */
export const AiRankingOutputSchema = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number(), reason: z.string() })),
});
