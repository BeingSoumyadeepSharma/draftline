import { adapterFor, detectFields } from "./detect";
import { fillField } from "./fill";
import type { ContentMessage, FillResponse, ScanResponse } from "./types";

// Applications can be embedded in an iframe. Only the frame holding the form
// replies, so the side panel gets a single answer.
chrome.runtime.onMessage.addListener(
  (message: ContentMessage, _sender, sendResponse) => {
    const fields = detectFields(document, location.hostname);
    if (!fields) return false;

    if (message.type === "scan") {
      sendResponse({
        site: adapterFor(location.hostname)!.id,
        fields: fields.map((field) => field.descriptor),
      } satisfies ScanResponse);
      return false;
    }

    void (async () => {
      const results = [];
      for (const { key, value } of message.fields) {
        const field = fields.find((f) => f.descriptor.key === key);
        results.push(
          field
            ? await fillField(field, value, message.resume)
            : { key, ok: false, reason: "This field is no longer on the page" },
        );
      }
      sendResponse({ results } satisfies FillResponse);
    })();
    return true;
  },
);
