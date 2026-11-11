/**
 * Decides, with fixed rules and no AI, what each field should get: a profile
 * value, a saved answer, the resume, or nothing ("needs you"). Runs in the side
 * panel.
 *
 * The rules prefer leaving a field for the user over guessing. Sensitive
 * questions can only be filled from the user's own saved answers.
 */
import type { Answer, Profile } from "@draftline/shared";
import { intentsOf } from "@draftline/shared/questions";
import type { FieldDescriptor } from "./types";

export type Decision =
  | { status: "ready"; value: string; source: string; note?: string }
  /** A likely match the user must opt in to. Unticked by default. */
  | { status: "confirm"; value: string; source: string; note: string }
  /** canDraft: no rule or saved answer covers it, so AI may suggest a draft. */
  | { status: "needs_you"; reason: string; canDraft?: boolean }
  | { status: "skip"; reason: string };

export type MatchData = {
  profile: Profile;
  answers: Answer[];
  resumeName: string | null;
};

export const RESUME_VALUE = "__resume__";

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();


/** Finds the option a saved value refers to, or null if unclear. */
export function pickOption(value: string, options: string[]): string | null {
  const target = normalize(value);
  if (!target) return null;
  const exact = options.filter((option) => normalize(option) === target);
  if (exact.length === 1) return exact[0]!;
  const prefixed = options.filter((option) =>
    normalize(option).startsWith(`${target} `),
  );
  return prefixed.length === 1 ? prefixed[0]! : null;
}

const words = (text: string) => normalize(text).split(" ").filter(Boolean);

/**
 * Sites word places differently ("Milan, Italy" vs "Milano, Milan, Italy"),
 * so a location matches on its city and country words rather than exact text.
 * Returns null unless exactly one choice fits.
 */
export function pickLocation(saved: string, options: string[]): string | null {
  // No prefix matching here: "Milan" must not pick "Milan, Tennessee".
  const exact = options.filter((option) => normalize(option) === normalize(saved));
  if (exact.length === 1) return exact[0]!;
  const parts = saved.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const needed = [
    ...words(parts[0]!),
    ...(parts.length > 1 ? words(parts[parts.length - 1]!) : []),
  ];
  const fits = options.filter((option) => {
    const present = new Set(words(option));
    return needed.every((word) => present.has(word));
  });
  return fits.length === 1 ? fits[0]! : null;
}

export const isLocationLabel = (label: string) =>
  /\blocation\b|\bcity\b/i.test(label);

function linkFor(profile: Profile, host: string, label: RegExp): string {
  const { links } = profile.contact;
  const found =
    links.find((l) => l.url.toLowerCase().includes(host)) ??
    links.find((l) => label.test(l.label.toLowerCase()));
  return found?.url ?? "";
}

function portfolioLink(profile: Profile): string {
  const { links } = profile.contact;
  const found =
    links.find((l) => /portfolio|website|personal/.test(l.label.toLowerCase())) ??
    links.find((l) => !/linkedin\.com|github\.com/.test(l.url.toLowerCase()));
  return found?.url ?? "";
}

function currentRole(profile: Profile) {
  const role = profile.experience[0];
  return role && /present|current|now/i.test(role.endDate) ? role : undefined;
}

/**
 * Rules are anchored on purpose: "What name would you prefer us to use?"
 * must not be treated as a request for the applicant's name.
 */
const PROFILE_RULES: ReadonlyArray<
  [RegExp, string, (profile: Profile) => string]
> = [
  [/^(legal )?first name$|^given name$/, "First name", (p) => p.contact.fullName.trim().split(/\s+/)[0] ?? ""],
  [/^(legal )?last name$|^family name$|^surname$/, "Last name", (p) => p.contact.fullName.trim().split(/\s+/).slice(1).join(" ")],
  [/^(your |full |legal |full legal )?name$/, "Full name", (p) => p.contact.fullName],
  [/^(your )?e ?mail( address)?$/, "Email", (p) => p.contact.email],
  [/^(phone|mobile|cell)( number)?$/, "Phone", (p) => p.contact.phone],
  [/^(current )?location\b|^city$/, "Location", (p) => p.contact.location],
  [/linkedin/, "LinkedIn", (p) => linkFor(p, "linkedin.com", /linkedin/)],
  [/github/, "GitHub", (p) => linkFor(p, "github.com", /github/)],
  [/portfolio|personal (web)?site|^website\b/, "Portfolio", portfolioLink],
  [/^current (company|employer)$/, "Current company", (p) => currentRole(p)?.company ?? ""],
  [/^current (job )?title$/, "Current title", (p) => currentRole(p)?.title ?? ""],
];

function withOptions(
  field: FieldDescriptor,
  value: string,
  source: string,
  makeConfirm?: string,
): Decision {
  let filled = value;
  if (field.options.length > 0) {
    const option = pickOption(value, field.options);
    if (!option) {
      return {
        status: "needs_you",
        reason: `Your saved answer "${value}" doesn't match the choices here`,
      };
    }
    filled = option;
  }
  if (makeConfirm) {
    return { status: "confirm", value: filled, source, note: makeConfirm };
  }
  return { status: "ready", value: filled, source, note: field.note };
}

export function matchField(field: FieldDescriptor, data: MatchData): Decision {
  if (field.currentValue) return { status: "skip", reason: "Already filled" };

  // Consent and acknowledgement boxes are always the applicant's own decision.
  if (field.kind === "checkbox") {
    return { status: "needs_you", reason: "Tick this yourself" };
  }

  const label = normalize(field.label);

  if (field.kind === "file") {
    if (/resume|\bcv\b/.test(label)) {
      return data.resumeName
        ? { status: "ready", value: RESUME_VALUE, source: data.resumeName }
        : { status: "needs_you", reason: "No resume file saved in Draftline" };
    }
    return { status: "needs_you", reason: "Attach this file yourself" };
  }

  const intents = intentsOf(field.label);
  if (intents.length > 1) {
    return {
      status: "needs_you",
      reason: "This question covers more than one topic",
    };
  }
  if (intents.length === 1) {
    const saved = data.answers.find((answer) => {
      const theirs = intentsOf(answer.question);
      return theirs.length === 1 && theirs[0] === intents[0];
    });
    if (!saved?.answer.trim()) {
      return { status: "needs_you", reason: "No saved answer yet" };
    }
    // An answer about "this country" may not hold for a job in a named one.
    const placeSpecific =
      (intents[0] === "work_auth" || intents[0] === "sponsorship") &&
      !/\b(this|the) country\b/.test(label);
    return withOptions(
      field,
      saved.answer,
      "Saved answer",
      placeSpecific ? "Check this applies to this job's country" : undefined,
    );
  }

  const exact = data.answers.find(
    (answer) => normalize(answer.question) === label && answer.answer.trim(),
  );
  if (exact) return withOptions(field, exact.answer, "Saved answer");

  for (const [pattern, source, read] of PROFILE_RULES) {
    if (!pattern.test(label)) continue;
    const value = read(data.profile).trim();
    if (!value) return { status: "needs_you", reason: `${source} is missing from your profile` };
    return withOptions(field, value, source);
  }

  return {
    status: "needs_you",
    reason: "No saved answer for this question",
    canDraft: true,
  };
}
