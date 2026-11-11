import { z } from "zod";

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

/** Derived from the public key in apps/extension/manifest.json. */
export const EXTENSION_ID = "nlonealbggknmcmnccjjbgndhmfnoipm";

export type ResumeFileMeta = { name: string; uploadedAt: string };
export type ResumeFilePayload = { name: string; base64: string };

export type Status = { aiConfigured: boolean };
export type ResumeParseResult = { profile: Profile };
export type ApiError = { error: string };
