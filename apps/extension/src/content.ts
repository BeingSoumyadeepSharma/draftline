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
import { adapterFor, detectFields, jobFromDocument } from "./detect";
import { fillField } from "./fill";
import type {
  ContentMessage,
  FillResponse,
  PageJob,
  ScanResponse,
} from "./types";

let leverJob: Promise<PageJob | null> | null = null;

/**
 * Lever's apply page shows only the job title, so the description is read
 * from the posting page at the same address without "/apply".
 */
function fetchLeverPosting(): Promise<PageJob | null> {
  const postingUrl = location.href.replace(/\/apply\/?(?=$|[?#])/, "");
  if (postingUrl === location.href) return Promise.resolve(null);
  leverJob ??= fetch(postingUrl, { credentials: "same-origin" })
    .then((response) => (response.ok ? response.text() : ""))
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return jobFromDocument(doc, location.hostname, postingUrl);
    })
    .catch(() => null);
  return leverJob;
}

async function readJob(): Promise<PageJob | null> {
  const onPage = jobFromDocument(document, location.hostname, location.href);
  if (onPage) return onPage;
  if (adapterFor(location.hostname)?.id === "Lever") return fetchLeverPosting();
  return null;
}

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
