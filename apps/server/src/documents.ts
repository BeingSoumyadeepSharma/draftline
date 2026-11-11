/**
 * Phase 4 AI features: a tailored resume and a cover letter for one job.
 *
 * Tailoring never rewrites the user's experience. The AI only chooses which
 * existing bullets, projects and skills to show, in what order, by id; the
 * PDF is then built from the profile's own wording (see pdf.ts). The one
 * piece of new text in a resume is the summary, which must cite its facts.
 *
 * As in jobs.ts, everything the AI returns is checked afterwards: unknown ids
 * are dropped, every role stays on the resume (hiding jobs would leave gaps),
 * and skills must come from the profile's own list.
 */
import {
  CoverLetterOutputSchema,
  TailoredResumeOutputSchema,
  type CoverLetter,
  type JobInput,
  type Profile,
  type Source,
  type TailoredResume,
} from "@draftline/shared";
import type { Generate } from "./ai.js";
import { factsBlock, postingBlock, UNTRUSTED_POSTING, type Facts } from "./jobs.js";

/** Bullets kept for a role the AI left out or left empty. */
const DEFAULT_BULLETS_PER_ROLE = 3;

export const TAILOR_SYSTEM = `You tailor a resume to one job by choosing from the candidate's existing material. You never write new experience.

- Use only ids from the candidate facts. Copy them exactly.
- Include every role, in the order given. For each, choose the bullets most relevant to this job (usually 2 to 5) and order them most relevant first.
- Choose the projects that help this application, if any.
- skills: choose and order the relevant skills, copied exactly from the Skills fact.
- summary: two or three sentences in the first person or in resume style, written only from the facts, aimed at this job. Put the ids of the facts it uses in summarySourceIds.
- note: one sentence telling the candidate what you emphasized, or what the job wants that the facts don't show.
- ${UNTRUSTED_POSTING}`;

export const COVER_LETTER_SYSTEM = `You draft the body of a cover letter for the candidate, who will edit it before sending.

- Use only the candidate facts. Never invent employers, titles, dates, numbers, skills, or achievements.
- Write three or four short paragraphs: why this role, the most relevant evidence from the facts, and a brief close. No greeting or sign-off; those are added separately.
- Connect specific facts to specific points in the posting. Keep it plain and specific, without flattery or filler.
- Put the id of every fact you used in sourceIds.
- note: one sentence on what the candidate should add in their own words, such as personal reasons for wanting this job.
- ${UNTRUSTED_POSTING}`;

type Draft<T> = { content: T; sources: Source[]; note: string };

const sameText = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Makes a tailored resume consistent with the profile: known ids only, bullets
 * under their own role, every role present, skills from the profile's list.
 * Also used on the user's own edits before rendering.
 */
export function cleanTailoredResume(
  profile: Profile,
  draft: TailoredResume,
): TailoredResume {
  const chosen = new Map<string, string[]>();
  for (const { roleId, bulletIds } of draft.roles) {
    const role = profile.experience.find((r) => r.id === roleId);
    if (!role || chosen.has(roleId)) continue;
    const own = new Set(role.bullets.map((b) => b.id));
    chosen.set(roleId, [...new Set(bulletIds.filter((id) => own.has(id)))]);
  }

  const roles = profile.experience.map((role) => {
    const bulletIds = chosen.get(role.id);
    // A role the AI dropped stays on the resume with its first few bullets.
    return {
      roleId: role.id,
      bulletIds:
        bulletIds ??
        role.bullets.slice(0, DEFAULT_BULLETS_PER_ROLE).map((b) => b.id),
    };
  });

  const projectIds = [
    ...new Set(
      draft.projectIds.filter((id) => profile.projects.some((p) => p.id === id)),
    ),
  ];

  const skills: string[] = [];
  for (const skill of draft.skills) {
    const own = profile.skills.find((s) => sameText(s, skill));
    if (own && !skills.includes(own)) skills.push(own);
  }

  return { summary: draft.summary.trim(), roles, projectIds, skills };
}

export async function tailorResume(
  generate: Generate,
  facts: Facts,
  profile: Profile,
  job: JobInput,
): Promise<Draft<TailoredResume>> {
  const output = await generate({
    system: TAILOR_SYSTEM,
    user: `${factsBlock(facts)}\n\n${postingBlock(job)}`,
    schema: TailoredResumeOutputSchema,
    name: "tailored_resume",
    effort: "high",
  });

  const content = cleanTailoredResume(profile, output);
  const sources = facts.resolve(output.summarySourceIds);
  const notes = [output.note.trim()];
  if (content.summary && sources.length === 0) {
    notes.push("The summary doesn't cite anything from your profile, so check it carefully.");
  }
  return { content, sources, note: notes.filter(Boolean).join(" ") };
}

export async function draftCoverLetter(
  generate: Generate,
  facts: Facts,
  job: JobInput,
): Promise<Draft<CoverLetter>> {
  const output = await generate({
    system: COVER_LETTER_SYSTEM,
    user: `${factsBlock(facts)}\n\n${postingBlock(job)}`,
    schema: CoverLetterOutputSchema,
    name: "cover_letter",
    effort: "high",
  });

  const body = output.paragraphs
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  const sources = facts.resolve(output.sourceIds);
  const notes = [output.note.trim()];
  if (body && sources.length === 0) {
    notes.push("This letter doesn't cite anything from your profile, so check it carefully.");
  }
  return { content: { body }, sources, note: notes.filter(Boolean).join(" ") };
}
