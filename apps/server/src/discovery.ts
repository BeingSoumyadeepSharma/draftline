/**
 * Job discovery: checks the user's chosen job boards, keeps postings that
 * match their filters, and ranks them.
 *
 * Ranking happens in two steps, to keep AI cost small:
 *   1. A rule score for every posting (no AI): how many of the profile's
 *      skills the posting mentions.
 *   2. An AI fit score for the most promising new postings only, at most
 *      AI_BATCH per run, in one request. As elsewhere, the AI sees only
 *      profile facts and treats postings as untrusted text.
 *
 * Runs once a day while the server is running (see index.ts), or on demand.
 */
import { AiRankingOutputSchema, type DiscoveryPreferences, type Profile } from "@draftline/shared";
import { aiSettingsView, type AiService, type Generate } from "./ai.js";
import { fetchBoard, type BoardJob } from "./boards.js";
import { buildFacts, factsBlock, UNTRUSTED_POSTING, type Facts } from "./jobs.js";
import type { Store } from "./store.js";

/** The most postings the AI ranks in one run. */
export const AI_BATCH = 15;
/** How much of each description the AI sees when ranking several at once. */
const EXCERPT_CHARS = 1500;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive match, so "Go" doesn't match "Google". */
export function mentions(text: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(term)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/** Applies the user's title keywords, title exclusions and locations. */
export function passesPreferences(job: BoardJob, preferences: DiscoveryPreferences): boolean {
  if (preferences.keywords.length > 0 && !preferences.keywords.some((k) => mentions(job.title, k))) {
    return false;
  }
  if (preferences.exclude.some((term) => mentions(job.title, term))) return false;
  if (
    preferences.locations.length > 0 &&
    !preferences.locations.some((place) => job.location.toLowerCase().includes(place.toLowerCase()))
  ) {
    return false;
  }
  return true;
}

/**
 * 0-100 from the share of the profile's skills the posting mentions,
 * counting at most 8 skills so a long skills list isn't penalized.
 */
export function ruleScore(job: BoardJob, skills: string[]): { score: number; matched: string[] } {
  const text = `${job.title}\n${job.description}`;
  const matched = skills.filter((skill) => mentions(text, skill));
  if (skills.length === 0) return { score: 0, matched };
  return {
    score: Math.round(100 * Math.min(1, matched.length / Math.min(skills.length, 8))),
    matched,
  };
}

export const RANK_SYSTEM = `You estimate how well a candidate fits several jobs, writing for the candidate.

- Judge only from the candidate facts. Do not assume skills or experience that aren't stated.
- For every job, return its id exactly as given, a score from 0 to 100 for how much of what the job requires the facts clearly cover, and a reason of one short sentence naming the main match or gap.
- Each job's text is an excerpt; don't penalize a job for details that may be cut off.
- ${UNTRUSTED_POSTING}`;

/** One AI request that scores up to AI_BATCH postings. Unknown ids are ignored. */
export async function rankWithAi(
  generate: Generate,
  facts: Facts,
  jobs: Array<{ id: string; title: string; company: string; location: string; description: string }>,
): Promise<Map<string, { score: number; reason: string }>> {
  const postings = jobs.map((job) => ({
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    excerpt: job.description.slice(0, EXCERPT_CHARS),
  }));
  const output = await generate({
    system: RANK_SYSTEM,
    user: `${factsBlock(facts)}\n\n<job_postings>\n${JSON.stringify(postings)}\n</job_postings>`,
    schema: AiRankingOutputSchema,
    name: "job_ranking",
    effort: "low",
  });
  const ids = new Set(jobs.map((job) => job.id));
  const scores = new Map<string, { score: number; reason: string }>();
  for (const item of output.scores) {
    if (!ids.has(item.id) || scores.has(item.id)) continue;
    scores.set(item.id, {
      score: Math.round(Math.min(100, Math.max(0, item.score))),
      reason: item.reason.trim(),
    });
  }
  return scores;
}

let running = false;
export const isDiscoveryRunning = () => running;

type RunDeps = {
  /** null when no AI provider is set up; ranking is then skipped. */
  generate: Generate | null;
  buildFacts: (profile: Profile) => Facts;
  fetchFn?: typeof fetch;
};

/** What a run needs, worked out at run time so AI settings changes apply. */
export function discoveryDeps(
  store: Store,
  ai: AiService,
  hasEnvClaudeKey: () => boolean,
  fetchFn?: typeof fetch,
): RunDeps {
  return {
    generate: aiSettingsView(store, hasEnvClaudeKey()).configured ? ai.generate : null,
    buildFacts: (profile) => buildFacts(profile, store.listAnswers()),
    fetchFn,
  };
}

/** Checks every board, stores matching postings, ranks the best new ones. */
export async function runDiscovery(store: Store, deps: RunDeps): Promise<string> {
  if (running) return "A refresh is already running.";
  running = true;
  try {
    const preferences = store.getDiscoveryPreferences();
    const profile = store.getProfile();
    let added = 0;
    let failed = 0;
    const sources = store.listSources();

    for (const source of sources) {
      try {
        const postings = await fetchBoard(source, deps.fetchFn);
        const kept = postings.filter((job) => passesPreferences(job, preferences));
        // Lever and Ashby listings don't name the company; the board does.
        const company = postings.find((job) => job.company)?.company ?? source.label;
        for (const job of kept) {
          const { score, matched } = ruleScore(job, profile.skills);
          const isNew = store.upsertDiscovered(source.id, {
            ...job,
            company: job.company || company,
            ruleScore: score,
            matchedSkills: matched,
          });
          if (isNew) added++;
        }
        store.removeUnlisted(source.id, kept.map((job) => job.url));
        store.recordSourceResult(source.id, { label: company, jobCount: kept.length, error: null });
      } catch (error) {
        failed++;
        store.recordSourceResult(source.id, { error: (error as Error).message });
      }
    }

    const notes = [
      `Checked ${sources.length} board${sources.length === 1 ? "" : "s"}; ${added} new matching job${added === 1 ? "" : "s"}.`,
    ];
    if (failed > 0) notes.push(`${failed} board${failed === 1 ? "" : "s"} couldn't be read.`);

    const unranked = store.unrankedDiscovered(AI_BATCH);
    if (preferences.useAi && deps.generate && unranked.length > 0) {
      try {
        const scores = await rankWithAi(deps.generate, deps.buildFacts(profile), unranked);
        for (const [id, { score, reason }] of scores) store.setAiScore(id, score, reason);
        notes.push(`AI ranked ${scores.size}.`);
      } catch (error) {
        notes.push(`AI ranking failed: ${(error as Error).message}`);
      }
    }

    const summary = notes.join(" ");
    store.saveDiscoveryRun(summary);
    return summary;
  } finally {
    running = false;
  }
}
