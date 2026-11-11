/**
 * Content script: runs inside Greenhouse and Lever pages (see the matches in
 * manifest.json). It can read and change the page but doesn't call the local
 * server. It answers two messages from the side panel:
 *   scan   describe the form's fields and the job
 *   fill   put the chosen values into the form
 *
 * How the extension fits together:
 *   sidepanel/main.tsx  --messages-->  content.ts
 *                                        |-- detect.ts  reads the page
 *                                        `-- fill.ts    writes to the page
 *   match.ts (rules, no AI) runs in the side panel to decide what goes where.
 */
import {
  adapterFor,
  canonicalJobUrl,
  detectFields,
  jobFromDocument,
  jobFromWorkdayApi,
  workdayJobApiUrl,
} from "./detect";
import { fillField } from "./fill";
import { checkForConfirmation, isSubmitControl, rememberSubmission } from "./submission";
import type {
  ContentMessage,
  FillResponse,
  PageChangedMessage,
  PageJob,
  ScanResponse,
} from "./types";

// Fetched job details, keyed by address, so each is loaded once per page.
const fetchedJobs = new Map<string, Promise<PageJob | null>>();

/**
 * Lever's apply page shows only the job title, so the description is read
 * from the posting page at the same address without "/apply".
 */
function fetchLeverPosting(): Promise<PageJob | null> {
  const postingUrl = location.href.replace(/\/apply\/?(?=$|[?#])/, "");
  if (postingUrl === location.href) return Promise.resolve(null);
  if (!fetchedJobs.has(postingUrl)) {
    fetchedJobs.set(
      postingUrl,
      fetch(postingUrl, { credentials: "same-origin" })
        .then((response) => (response.ok ? response.text() : ""))
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, "text/html");
          return jobFromDocument(doc, location.hostname, postingUrl);
        })
        .catch(() => null),
    );
  }
  return fetchedJobs.get(postingUrl)!;
}

/**
 * Workday's application pages don't show the job, so it's read from
 * Workday's public job-details address on the same site.
 */
function fetchWorkdayJob(): Promise<PageJob | null> {
  const api = workdayJobApiUrl(location.href);
  if (!api) return Promise.resolve(null);
  const postingUrl = location.href.replace(/\/apply(\/.*)?$/, "");
  if (!fetchedJobs.has(api)) {
    fetchedJobs.set(
      api,
      fetch(api, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => jobFromWorkdayApi(document, data, postingUrl))
        .catch(() => null),
    );
  }
  return fetchedJobs.get(api)!;
}

async function readJob(): Promise<PageJob | null> {
  const onPage = jobFromDocument(document, location.hostname, canonicalJobUrl(location.href));
  if (onPage) return onPage;
  switch (adapterFor(location.hostname)?.id) {
    case "Lever":
      return fetchLeverPosting();
    case "Workday":
      return fetchWorkdayJob();
    default:
      return null;
  }
}

// --- Noticing submissions (Phase 6) ---

// The job on this page, kept ready so a submit click can record it at once,
// before the site navigates away.
let currentJob: PageJob | null = null;
const refreshCurrentJob = () => {
  if (detectFields(document, location.hostname)) {
    void readJob().then((job) => (currentJob = job ?? currentJob));
  }
};
refreshCurrentJob();

const onPossibleSubmit = (target: EventTarget | null) => {
  if (!(target instanceof Element) || !detectFields(document, location.hostname)) return;
  if (isSubmitControl(target)) void rememberSubmission(currentJob, location.href);
};
document.addEventListener("click", (event) => onPossibleSubmit(event.target), true);
document.addEventListener("submit", (event) => onPossibleSubmit(event.submitter ?? null), true);

// A confirmation can be a new page or the same page changing; check both.
const checkConfirmation = () =>
  void checkForConfirmation(document.body?.innerText ?? "", location.hostname);
checkConfirmation();

/**
 * Multi-step forms (Workday, LinkedIn) swap fields without loading a new
 * page. When the set of fields changes, tell the side panel to rescan.
 */
let lastFieldKeys = "";
let changeTimer: ReturnType<typeof setTimeout> | undefined;
new MutationObserver(() => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    checkConfirmation();
    refreshCurrentJob();
    const keys = (detectFields(document, location.hostname) ?? [])
      .map((field) => field.descriptor.key)
      .join("|");
    if (keys === lastFieldKeys) return;
    const firstReport = lastFieldKeys === "";
    lastFieldKeys = keys;
    // The panel scans on its own when it opens; only later changes matter.
    if (firstReport && !keys) return;
    chrome.runtime
      .sendMessage({ type: "page-changed" } satisfies PageChangedMessage)
      .catch(() => {
        // No side panel open: nothing to tell.
      });
  }, 700);
}).observe(document.documentElement, { childList: true, subtree: true });

// Applications can be embedded in an iframe. Only the frame holding the form
// replies, so the side panel gets a single answer.
chrome.runtime.onMessage.addListener(
  (message: ContentMessage, _sender, sendResponse) => {
    const fields = detectFields(document, location.hostname);
    if (!fields) return false;

    if (message.type === "scan") {
      void readJob().then((job) =>
        sendResponse({
          site: adapterFor(location.hostname)!.id,
          fields: fields.map((field) => field.descriptor),
          job,
        } satisfies ScanResponse),
      );
      return true;
    }

    void (async () => {
      const results = [];
      for (const { key, value } of message.fields) {
        const field = fields.find((f) => f.descriptor.key === key);
        results.push(
          field
            ? await fillField(field, value, message.files)
            : { key, ok: false, reason: "This field is no longer on the page" },
        );
      }
      sendResponse({ results } satisfies FillResponse);
    })();
    return true;
  },
);
