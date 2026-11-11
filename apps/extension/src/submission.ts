/**
 * Notices when the user submits an application, so the tracker can mark the
 * job Applied without being told. Draftline never submits; this only watches.
 *
 * Two things must both happen, a few minutes apart at most:
 *   1. The user clicks a submit-style button on a supported application form.
 *      The job is remembered in extension storage, because many sites load a
 *      new page after submitting.
 *   2. A page on the same site then shows confirmation wording such as
 *      "Thank you for applying".
 * Requiring both keeps a stray "thanks" elsewhere from marking anything.
 */
import type { PageJob } from "./types";

/** How long after the click a confirmation page still counts. */
const WINDOW_MS = 15 * 60 * 1000;
const STORAGE_KEY = "pendingSubmission";

export type PendingSubmission = {
  url: string;
  title: string;
  company: string;
  host: string;
  at: number;
};

/** Sent to the service worker, which records it with the local server. */
export type AppliedMessage = {
  type: "applied";
  url: string;
  title: string;
  company: string;
};

const SUBMIT_WORDING = /\b(submit|send)\b.*\b(application|applying)\b|^\s*submit\s*$|^\s*submit application\s*$/i;

/** True for a button that sends an application, judged by its type or words. */
export function isSubmitControl(element: Element): boolean {
  const control = element.closest("button, input[type='submit'], [role='button']");
  if (!control) return false;
  if (control.getAttribute("type") === "submit" && control.closest("form")) return true;
  const text = (
    control.textContent ||
    control.getAttribute("value") ||
    control.getAttribute("aria-label") ||
    ""
  ).trim();
  return SUBMIT_WORDING.test(text);
}

const CONFIRMATION_WORDING =
  /thank(s| you) for (applying|your application|submitting)|application (was |has been )?(submitted|received|sent)|we('ve| have) received your application|your application (was|has been) (sent|submitted|received)/i;

/** True when the page's text reads like an application confirmation. */
export const looksSubmitted = (text: string) => CONFIRMATION_WORDING.test(text);

export async function rememberSubmission(job: PageJob | null, href: string): Promise<void> {
  const pending: PendingSubmission = {
    url: job?.url ?? href,
    title: job?.title ?? "",
    company: job?.company ?? "",
    host: new URL(href).hostname,
    at: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: pending });
}

/**
 * If a recent submission on this site is waiting and the page now confirms
 * it, reports it once and forgets it.
 */
export async function checkForConfirmation(pageText: string, hostname: string): Promise<void> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
    | PendingSubmission
    | undefined;
  if (!stored) return;
  if (Date.now() - stored.at > WINDOW_MS) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return;
  }
  if (stored.host !== hostname || !looksSubmitted(pageText)) return;
  await chrome.storage.local.remove(STORAGE_KEY);
  await chrome.runtime
    .sendMessage({
      type: "applied",
      url: stored.url,
      title: stored.title,
      company: stored.company,
    } satisfies AppliedMessage)
    .catch(() => {});
}
