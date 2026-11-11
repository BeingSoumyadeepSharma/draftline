/**
 * Reads public company job boards through each site's public listing API:
 *   Greenhouse  boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true
 *   Lever       api.lever.co/v0/postings/<company>?mode=json
 *   Ashby       api.ashbyhq.com/posting-api/job-board/<org>
 *
 * The user pastes a board's address (like jobs.lever.co/palantir); only the
 * company name is taken from it, and requests go to these fixed API hosts,
 * so a pasted address can't make the server fetch anything else.
 * No personal data is sent: these are plain reads of public listings.
 */
import type { BoardKind } from "@draftline/shared";

const SLUG = /^[A-Za-z0-9._-]{1,100}$/;
const TIMEOUT_MS = 30_000;

export type BoardSource = { kind: BoardKind; slug: string };

/** A posting as read from a board, before Draftline's filters. */
export type BoardJob = {
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  postedAt: string | null;
};

/** Turns a pasted board address into the site and company it names. */
export function parseBoardUrl(input: string): (BoardSource & { url: string }) | null {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (!slug || !SLUG.test(slug)) return null;

  const host = url.hostname.toLowerCase();
  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    return { kind: "greenhouse", slug, url: `https://job-boards.greenhouse.io/${slug}` };
  }
  if (host === "jobs.lever.co") {
    return { kind: "lever", slug, url: `https://jobs.lever.co/${slug}` };
  }
  if (host === "jobs.ashbyhq.com") {
    return { kind: "ashby", slug, url: `https://jobs.ashbyhq.com/${slug}` };
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text from posting HTML, keeping paragraphs and list items apart. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<li[^>]*>/gi, "\n- ")
      // A list item already starts on its own line, so </li> adds nothing.
      .replace(/<\/(p|div|ul|ol|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getJson(url: string, fetchFn: typeof fetch, name: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Couldn't reach this job board. Check your connection.");
  }
  if (response.status === 404) throw new Error(`No public job board found for "${name}".`);
  if (!response.ok) throw new Error(`The job board returned an error (${response.status}).`);
  return response.json();
}

type GreenhouseResponse = {
  jobs?: Array<{
    absolute_url: string;
    title: string;
    company_name?: string;
    location?: { name?: string };
    content?: string;
    first_published?: string;
    updated_at?: string;
  }>;
};

type LeverResponse = Array<{
  hostedUrl: string;
  text: string;
  categories?: { location?: string };
  descriptionPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  additionalPlain?: string;
  createdAt?: number;
}>;

type AshbyResponse = {
  jobs?: Array<{
    title: string;
    location?: string;
    isRemote?: boolean;
    isListed?: boolean;
    jobUrl: string;
    descriptionPlain?: string;
    publishedAt?: string;
  }>;
};

/** Reads every current posting on one board. */
export async function fetchBoard(
  source: BoardSource,
  fetchFn: typeof fetch = fetch,
): Promise<BoardJob[]> {
  const slug = encodeURIComponent(source.slug);

  if (source.kind === "greenhouse") {
    const data = (await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      fetchFn,
      source.slug,
    )) as GreenhouseResponse;
    return (data.jobs ?? []).map((job) => ({
      url: job.absolute_url,
      title: job.title,
      company: job.company_name ?? "",
      location: job.location?.name ?? "",
      // Greenhouse escapes the HTML itself, so it's decoded twice.
      description: htmlToText(decodeEntities(job.content ?? "")),
      postedAt: job.first_published ?? job.updated_at ?? null,
    }));
  }

  if (source.kind === "lever") {
    const data = (await getJson(
      `https://api.lever.co/v0/postings/${slug}?mode=json`,
      fetchFn,
      source.slug,
    )) as LeverResponse;
    return data.map((job) => ({
      url: job.hostedUrl,
      title: job.text,
      company: "",
      location: job.categories?.location ?? "",
      // Lever splits a posting into an intro, titled lists and a closing.
      description: [
        job.descriptionPlain ?? "",
        ...(job.lists ?? []).map((list) => `${list.text}\n${htmlToText(list.content)}`),
        job.additionalPlain ?? "",
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n\n"),
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    }));
  }

  const data = (await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`,
    fetchFn,
    source.slug,
  )) as AshbyResponse;
  return (data.jobs ?? [])
    .filter((job) => job.isListed !== false)
    .map((job) => ({
      url: job.jobUrl,
      title: job.title,
      company: "",
      location: [job.location, job.isRemote ? "Remote" : ""].filter(Boolean).join(" · "),
      description: (job.descriptionPlain ?? "").trim(),
      postedAt: job.publishedAt ?? null,
    }));
}
