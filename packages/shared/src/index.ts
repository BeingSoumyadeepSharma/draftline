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

export type Status = { aiConfigured: boolean };
export type ResumeParseResult = { profile: Profile };
export type ApiError = { error: string };
