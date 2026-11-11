/**
 * Reads the page. It finds the application form, turns each control into a
 * FieldDescriptor (label, kind, options, current value, character limit), and
 * reads the job description.
 *
 * Site-specific details live in the ADAPTERS list. Supporting a new site
 * starts with adding an adapter there.
 */
import type { FieldDescriptor, PageJob } from "./types";

export type DetectedField = {
  descriptor: FieldDescriptor;
  elements: HTMLElement[];
};

type Adapter = {
  id: string;
  hosts: RegExp;
  findForm: (doc: Document) => HTMLElement | null;
  /** A block holding one question, whose label or legend names its control. */
  fieldContainer?: string;
  /** Controls to ignore, such as search boxes or hidden helper inputs. */
  skip?: (element: HTMLElement) => boolean;
  /**
   * For questions answered by clicking buttons (Ashby's Yes/No): given the
   * question's hidden input, returns the buttons; otherwise null.
   */
  choiceButtons?: (element: HTMLElement) => HTMLElement[] | null;
  isSuggestBox?: (element: HTMLElement) => boolean;
};

/** Workday controls that look like fields but aren't part of the application. */
const WORKDAY_IGNORED = /search|keyword|utilityButton|navigation/i;

const ADAPTERS: Adapter[] = [
  {
    id: "Greenhouse",
    hosts: /(^|\.)greenhouse\.io$/,
    findForm: (doc) => {
      const firstName = doc.querySelector<HTMLElement>(
        "#first_name, input[name='first_name'], input[autocomplete='given-name']",
      );
      if (!firstName) return null;
      // Signed-in MyGreenhouse shows the form in a pop-up that may not be a <form>.
      return (
        firstName.closest<HTMLElement>("form, [role='dialog'], dialog") ??
        firstName.ownerDocument.body
      );
    },
  },
  {
    id: "Lever",
    hosts: /(^|\.)lever\.co$/,
    findForm: (doc) => doc.querySelector<HTMLElement>("#application-form"),
    isSuggestBox: (element) => element.classList.contains("location-input"),
  },
  {
    // Ashby renders the form with React and no <form> element.
    id: "Ashby",
    hosts: /(^|\.)ashbyhq\.com$/,
    findForm: (doc) => doc.querySelector<HTMLElement>(".ashby-application-form-container"),
    // Radio and checkbox groups sit in a fieldset inside a [data-field-path]
    // block, titled by a <label> rather than a <legend>.
    fieldContainer: ".ashby-application-form-field-entry, [data-field-path]",
    // The resume "autofill" box at the top asks Ashby to parse the file; the
    // Resume question further down is the one that matters.
    skip: (element) => Boolean(element.closest(".ashby-application-form-autofill-uploader")),
    choiceButtons: (element) => {
      const group = element.closest(".ashby-application-form-input-yesno");
      return group ? [...group.querySelectorAll<HTMLElement>("button")] : null;
    },
  },
  {
    // Workday's application spans several pages, each a set of fields marked
    // with data-automation-id. Untested on a live form: Workday needs an
    // account before the form appears.
    id: "Workday",
    hosts: /(^|\.)myworkdayjobs\.com$|(^|\.)myworkday\.com$/,
    findForm: (doc) => {
      const root =
        doc.querySelector<HTMLElement>("[data-automation-id='applyFlowPage']") ??
        doc.querySelector<HTMLElement>("main, [role='main']") ??
        doc.body;
      const hasFields = [
        ...root.querySelectorAll("input[data-automation-id], textarea[data-automation-id], button[aria-haspopup='listbox']"),
      ].some((el) => !WORKDAY_IGNORED.test(el.getAttribute("data-automation-id") ?? ""));
      return hasFields ? root : null;
    },
    fieldContainer: "[data-automation-id^='formField-'], fieldset",
    skip: (element) => WORKDAY_IGNORED.test(element.getAttribute("data-automation-id") ?? ""),
  },
  {
    // Only the Easy Apply pop-up, one step at a time. Untested on a live form:
    // LinkedIn needs the user's login.
    id: "LinkedIn",
    hosts: /(^|\.)linkedin\.com$/,
    findForm: (doc) => {
      const modal = doc.querySelector<HTMLElement>(
        ".jobs-easy-apply-modal, [data-test-modal-id='easy-apply-modal']",
      );
      return modal?.querySelector<HTMLElement>("form") ?? modal ?? null;
    },
    fieldContainer:
      ".fb-dash-form-element, .jobs-easy-apply-form-element, .jobs-easy-apply-form-section__grouping",
  },
];

export const adapterFor = (hostname: string) =>
  ADAPTERS.find((adapter) => adapter.hosts.test(hostname)) ?? null;

function cleanText(node: Element): string {
  const copy = node.cloneNode(true) as Element;
  copy
    .querySelectorAll(".required, [aria-hidden='true']")
    .forEach((el) => el.remove());
  return (copy.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\s*✱]+$/u, "")
    .trim();
}

function textOfIds(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id))
    .filter((el): el is HTMLElement => el !== null)
    .map(cleanText)
    .join(" ");
}

/** The label or legend of the question block around a control, if any. */
function containerLabel(element: HTMLElement, selector: string | undefined): string {
  if (!selector) return "";
  const container = element.closest(selector);
  const title = container?.querySelector(
    "legend, label, [data-automation-id='formLabel'], .ashby-application-form-question-title",
  );
  return title ? cleanText(title) : "";
}

function labelOf(element: HTMLElement, form: HTMLElement, adapter: Adapter): string {
  const doc = element.ownerDocument;

  // A file input's own label is the word "Attach"; the group names the field.
  if (element.getAttribute("type") === "file") {
    const group = element.closest("[role='group'][aria-labelledby]");
    const named = group && textOfIds(doc, group.getAttribute("aria-labelledby")!);
    if (named) return named;
  }

  // A radio or checkbox's own label is one option ("Yes"); the question is
  // the group's legend or the question block's label.
  const type = element.getAttribute("type");
  if (type === "radio" || type === "checkbox") {
    const legend = element.closest("fieldset")?.querySelector("legend");
    if (legend && cleanText(legend)) return cleanText(legend);
    const fromContainer = containerLabel(element, adapter.fieldContainer);
    if (fromContainer) return fromContainer;
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = textOfIds(doc, labelledBy);
    if (text) return text;
  }

  if (element.id) {
    const match = [...form.querySelectorAll("label")].find(
      (label) => label.htmlFor === element.id,
    );
    if (match) return cleanText(match);
  }

  const fromContainer = containerLabel(element, adapter.fieldContainer);
  if (fromContainer) return fromContainer;

  // Radio and checkbox groups are often named by their fieldset's legend.
  const legend = element.closest("fieldset")?.querySelector("legend");
  if (legend && cleanText(legend)) return cleanText(legend);

  const question = element.closest(".application-question");
  const leverLabel =
    question?.querySelector(".application-label .text") ??
    question?.querySelector(".application-label");
  if (leverLabel) return cleanText(leverLabel);

  const wrapping = element.closest("label");
  if (wrapping) return cleanText(wrapping);

  return (
    element.getAttribute("aria-label") ?? element.getAttribute("name") ?? ""
  );
}

function isSkipped(element: HTMLElement): boolean {
  const type = element.getAttribute("type");
  return (
    element.getAttribute("aria-hidden") === "true" ||
    (type !== null && ["hidden", "submit", "button", "reset", "image"].includes(type))
  );
}

const isRequired = (element: HTMLElement) =>
  element.hasAttribute("required") ||
  element.getAttribute("aria-required") === "true";

function comboboxValue(element: HTMLElement): string {
  const root = element.closest(".select__control");
  return root?.querySelector(".select__single-value")?.textContent?.trim() ?? "";
}

function optionText(input: HTMLInputElement): string {
  const wrapping = input.closest("label");
  if (wrapping && cleanText(wrapping)) return cleanText(wrapping);
  const byFor = input.id
    ? [...input.ownerDocument.querySelectorAll("label")].find((l) => l.htmlFor === input.id)
    : undefined;
  return (byFor && cleanText(byFor)) || input.value;
}

/** A list-style dropdown's button shows a placeholder until something is chosen. */
const listboxValue = (button: HTMLElement) => {
  const text = cleanText(button);
  return /^(select one|select|choose…?|-+)$/i.test(text) ? "" : text;
};

/** Reads the application form into a list of fields, in page order. */
export function detectFields(doc: Document, hostname: string): DetectedField[] | null {
  const adapter = adapterFor(hostname);
  const form = adapter?.findForm(doc);
  if (!adapter || !form) return null;

  const fields: DetectedField[] = [];
  const grouped = new Set<string>();
  const handled = new Set<Element>();
  const controls = form.querySelectorAll<HTMLElement>(
    "input, select, textarea, button[aria-haspopup='listbox']",
  );

  controls.forEach((element, index) => {
    if (adapter.skip?.(element)) return;
    const name = element.getAttribute("name") ?? "";
    const key =
      element.id || name || element.getAttribute("data-automation-id") || `field-${index}`;
    const base = {
      key,
      label: labelOf(element, form, adapter),
      required: isRequired(element),
    };
    const type = element.getAttribute("type");

    // A question answered by clicking one of several buttons (Ashby Yes/No).
    const buttons = adapter.choiceButtons?.(element);
    if (buttons) {
      if (grouped.has(key)) return;
      grouped.add(key);
      const pressed = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
      fields.push({
        descriptor: {
          ...base,
          kind: "buttons",
          options: buttons.map((b) => cleanText(b)),
          currentValue: pressed ? cleanText(pressed) : "",
        },
        elements: buttons,
      });
      return;
    }

    // A button that opens a list of choices (Workday's dropdowns).
    if (element.tagName === "BUTTON") {
      fields.push({
        descriptor: { ...base, kind: "listbox", options: [], currentValue: listboxValue(element) },
        elements: [element],
      });
      return;
    }

    if (isSkipped(element)) return;

    if (type === "radio" || type === "checkbox") {
      if (handled.has(element)) return;
      // Options belong together when they share a name, or else when they
      // share a fieldset (Ashby gives each checkbox in a group its own name).
      const sameName = name
        ? [...form.querySelectorAll<HTMLInputElement>("input")].filter(
            (input) => input.name === name && input.type === type,
          )
        : [];
      const fieldset = element.closest("fieldset");
      const group =
        sameName.length > 1
          ? sameName
          : fieldset
            ? [...fieldset.querySelectorAll<HTMLInputElement>(`input[type='${type}']`)]
            : [element as HTMLInputElement];
      group.forEach((input) => handled.add(input));
      const kind =
        type === "radio" ? "radio" : group.length > 1 ? "checkboxes" : "checkbox";
      const groupKey =
        sameName.length > 1
          ? name
          : (fieldset?.closest("[data-field-path]")?.getAttribute("data-field-path") ?? key);
      fields.push({
        descriptor: {
          ...base,
          key: groupKey,
          kind,
          options: group.map(optionText),
          currentValue: group.filter((i) => i.checked).map(optionText).join(", "),
        },
        elements: group,
      });
      return;
    }

    if (element instanceof element.ownerDocument.defaultView!.HTMLSelectElement) {
      const select = element as HTMLSelectElement;
      fields.push({
        descriptor: {
          ...base,
          kind: "select",
          options: [...select.options]
            .filter((option) => option.value)
            .map((option) => option.text.trim()),
          currentValue: select.value
            ? (select.selectedOptions[0]?.text.trim() ?? "")
            : "",
        },
        elements: [select],
      });
      return;
    }

    if (element.getAttribute("role") === "combobox") {
      fields.push({
        descriptor: {
          ...base,
          kind: "combobox",
          options: [],
          currentValue: comboboxValue(element),
        },
        elements: [element],
      });
      return;
    }

    const input = element as HTMLInputElement | HTMLTextAreaElement;
    if (type === "file") {
      fields.push({
        descriptor: {
          ...base,
          kind: "file",
          options: [],
          currentValue: (input as HTMLInputElement).files?.[0]?.name ?? "",
        },
        elements: [input],
      });
      return;
    }

    const limit = (input as HTMLInputElement).maxLength;
    fields.push({
      descriptor: {
        ...base,
        ...(limit > 0 && limit < 100_000 ? { maxLength: limit } : {}),
        kind: adapter.isSuggestBox?.(input)
          ? "suggest"
          : input.tagName === "TEXTAREA"
            ? "textarea"
            : "text",
        options: [],
        currentValue: input.value,
      },
      elements: [input],
    });
  });

  return fields;
}

// --- Reading the job description ---
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "UL", "OL", "LI", "BR", "TR",
  "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE",
]);
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "BUTTON", "FORM", "IFRAME"]);

/** Visible text with line breaks between blocks, so lists stay readable. */
export function readableText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIPPED_TAGS.has(element.tagName)) return;
    if (element.tagName === "LI") parts.push("\n- ");
    element.childNodes.forEach(walk);
    if (BLOCK_TAGS.has(element.tagName)) parts.push("\n");
  };
  walk(root);
  return parts
    .join("")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clean = (text: string | null | undefined) =>
  (text ?? "").replace(/\s+/g, " ").trim();

const FORM_BOILERPLATE = /^(apply for this job|\* ?indicates a required field)$/i;

/**
 * The text of everything before the form's first field, inside `root`.
 * MyGreenhouse shows the description above the form in one pop-up, without
 * the markup the public job board uses.
 */
function textBeforeFirstField(root: Element): string {
  const firstField = root.querySelector(
    "input:not([type='hidden']):not([aria-hidden='true']), select, textarea",
  );
  if (!firstField) return "";
  const view = root.ownerDocument.defaultView!;
  const blocks: Element[] = [];
  const collect = (parent: Element) => {
    for (const child of parent.children) {
      if (child.contains(firstField)) {
        // Descend through containers of the whole form, but stop at the
        // first field's own wrapper so its label isn't read as description.
        const fields = child.querySelectorAll(
          "input:not([type='hidden']):not([aria-hidden='true']), select, textarea",
        );
        if (fields.length > 1) collect(child);
        return;
      }
      const precedes =
        firstField.compareDocumentPosition(child) & view.Node.DOCUMENT_POSITION_PRECEDING;
      if (!precedes) return;
      blocks.push(child);
    }
  };
  collect(root);
  return blocks
    .map(readableText)
    .join("\n")
    .split("\n")
    .filter((line) => !FORM_BOILERPLATE.test(line.trim()))
    .join("\n")
    .trim();
}

/** Greenhouse titles read "Job Application for <role> at <company>". */
function greenhouseJob(doc: Document, url: string): PageJob | null {
  const company = / at (.+)$/.exec(clean(doc.title))?.[1] ?? "";
  const description = doc.querySelector(".job__description");
  if (description) {
    return {
      url,
      title: clean(doc.querySelector(".job__title h1, h1")?.textContent),
      company,
      location: clean(doc.querySelector(".job__location")?.textContent),
      description: readableText(description),
    };
  }

  const firstName = doc.querySelector(
    "#first_name, input[name='first_name'], input[autocomplete='given-name']",
  );
  const popUp = firstName?.closest("[role='dialog'], dialog");
  const text = textBeforeFirstField(popUp ?? doc.body);
  // Too little text means this is a heading, not a job description.
  if (text.length < 200) return null;
  return {
    url,
    title: clean((popUp ?? doc).querySelector("h1, h2")?.textContent),
    company,
    location: "",
    description: text,
  };
}

/** Lever titles read "<company> - <role>". */
function leverJob(doc: Document, url: string): PageJob | null {
  const sections = [
    ...doc.querySelectorAll(".section-wrapper.page-full-width .section.page-centered"),
  ].filter(
    (section) =>
      !section.matches(
        ".posting-header, .last-section-apply, [data-qa='btn-apply-bottom']",
      ),
  );
  if (sections.length === 0) return null;
  return {
    url,
    title: clean(doc.querySelector(".posting-headline h2")?.textContent),
    company: clean(doc.title.split(" - ")[0]),
    location: clean(doc.querySelector(".posting-categories .location")?.textContent),
    description: sections.map(readableText).filter(Boolean).join("\n\n"),
  };
}

/** Turns a fragment of job HTML (from page data or an API) into plain text. */
function htmlToText(doc: Document, html: string): string {
  const parsed = new (doc.defaultView!.DOMParser)().parseFromString(html, "text/html");
  return readableText(parsed.body);
}

/**
 * Reads one JSON object starting at `start`, tracking strings so braces
 * inside them don't end it early. Used for data embedded in a page script.
 */
function readJsonObject(text: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

type AshbyAppData = {
  organization?: { name?: string };
  posting?: { title?: string; locationName?: string; descriptionHtml?: string };
};

/**
 * Ashby embeds the whole job in a `window.__appData` script on both the
 * overview and application pages. The rendered description is a fallback.
 */
function ashbyJob(doc: Document, url: string): PageJob | null {
  const script = [...doc.querySelectorAll("script")].find((s) =>
    s.textContent?.includes("window.__appData"),
  );
  const text = script?.textContent ?? "";
  const data = text
    ? (readJsonObject(text, text.indexOf("{", text.indexOf("window.__appData"))) as AshbyAppData | null)
    : null;
  const posting = data?.posting;
  const description = posting?.descriptionHtml
    ? htmlToText(doc, posting.descriptionHtml)
    : readableText(doc.querySelector(".ashby-job-posting-description") ?? doc.createElement("div"));
  if (description.length < 200) return null;
  return {
    url,
    title: posting?.title ?? clean(doc.querySelector(".ashby-job-posting-heading")?.textContent),
    company: data?.organization?.name ?? "",
    location: posting?.locationName ?? "",
    description,
  };
}

/** Workday's posting page; its application pages don't show the job. */
function workdayJob(doc: Document, url: string): PageJob | null {
  const description = doc.querySelector("[data-automation-id='jobPostingDescription']");
  if (!description) return null;
  return {
    url,
    title: clean(doc.querySelector("[data-automation-id='jobPostingHeader']")?.textContent),
    company: "",
    // The location block starts with a hidden "locations" heading.
    location: clean(doc.querySelector("[data-automation-id='locations']")?.textContent).replace(/^locations\s*/i, ""),
    description: readableText(description),
  };
}

/**
 * Workday's public job-details address for a posting or application page:
 *   https://<tenant>.wd5.myworkdayjobs.com/en-US/<site>/job/<path>[/apply/...]
 *   → https://<tenant>.wd5.myworkdayjobs.com/wday/cxs/<tenant>/<site>/job/<path>
 */
export function workdayJobApiUrl(href: string): string | null {
  const url = new URL(href);
  const match = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+?)(?:\/apply(?:\/.*)?)?\/?$/.exec(url.pathname);
  if (!match) return null;
  const tenant = url.hostname.split(".")[0];
  return `${url.origin}/wday/cxs/${tenant}/${match[1]}/job/${match[2]}`;
}

type WorkdayJobInfo = {
  jobPostingInfo?: { title?: string; location?: string; jobDescription?: string };
};

/** Reads the job from Workday's job-details response. */
export function jobFromWorkdayApi(doc: Document, data: unknown, url: string): PageJob | null {
  const info = (data as WorkdayJobInfo | null)?.jobPostingInfo;
  if (!info?.jobDescription) return null;
  return {
    url,
    title: info.title ?? "",
    company: "",
    location: info.location ?? "",
    description: htmlToText(doc, info.jobDescription),
  };
}

/** LinkedIn's job view, shown beside or behind the Easy Apply pop-up. */
function linkedInJob(doc: Document, url: string): PageJob | null {
  const description = doc.querySelector(
    ".jobs-description__content, .jobs-description-content__text, #job-details",
  );
  if (!description) return null;
  return {
    url,
    title: clean(
      doc.querySelector(
        ".job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, h1",
      )?.textContent,
    ),
    company: clean(
      doc.querySelector(
        ".job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name",
      )?.textContent,
    ),
    location: "",
    description: readableText(description),
  };
}

/**
 * One address per job, so its saved analysis and documents are found again.
 * LinkedIn shows the same job under many URLs; its job id is what matters.
 */
export function canonicalJobUrl(href: string): string {
  const url = new URL(href);
  if (/(^|\.)linkedin\.com$/.test(url.hostname)) {
    const id =
      url.searchParams.get("currentJobId") ?? /\/jobs\/view\/(\d+)/.exec(url.pathname)?.[1];
    if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  }
  url.hash = "";
  return url.toString();
}

/** Reads the job from a posting page, or null if this page doesn't show one. */
export function jobFromDocument(doc: Document, hostname: string, url: string): PageJob | null {
  switch (adapterFor(hostname)?.id) {
    case "Greenhouse":
      return greenhouseJob(doc, url);
    case "Lever":
      return leverJob(doc, url);
    case "Ashby":
      return ashbyJob(doc, url);
    case "Workday":
      return workdayJob(doc, url);
    case "LinkedIn":
      return linkedInJob(doc, url);
    default:
      return null;
  }
}
