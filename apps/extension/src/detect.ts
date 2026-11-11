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
  isSuggestBox?: (element: HTMLElement) => boolean;
};

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

function labelOf(element: HTMLElement, form: HTMLElement): string {
  const doc = element.ownerDocument;

  // A file input's own label is the word "Attach"; the group names the field.
  if (element.getAttribute("type") === "file") {
    const group = element.closest("[role='group'][aria-labelledby]");
    const named = group && textOfIds(doc, group.getAttribute("aria-labelledby")!);
    if (named) return named;
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
  const label = input.closest("label");
  return (label && cleanText(label)) || input.value;
}

/** Reads the application form into a list of fields, in page order. */
export function detectFields(doc: Document, hostname: string): DetectedField[] | null {
  const adapter = adapterFor(hostname);
  const form = adapter?.findForm(doc);
  if (!adapter || !form) return null;

  const fields: DetectedField[] = [];
  const grouped = new Set<string>();
  const controls = form.querySelectorAll<HTMLElement>("input, select, textarea");

  controls.forEach((element, index) => {
    if (isSkipped(element)) return;
    const name = element.getAttribute("name") ?? "";
    const key = element.id || name || `field-${index}`;
    const base = {
      key,
      label: labelOf(element, form),
      required: isRequired(element),
    };
    const type = element.getAttribute("type");

    if (type === "radio" || type === "checkbox") {
      if (name && grouped.has(name)) return;
      const group = name
        ? [...form.querySelectorAll<HTMLInputElement>("input")].filter(
            (input) => input.name === name && input.type === type,
          )
        : [element as HTMLInputElement];
      if (name) grouped.add(name);
      const kind =
        type === "radio" ? "radio" : group.length > 1 ? "checkboxes" : "checkbox";
      fields.push({
        descriptor: {
          ...base,
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

/** Reads the job from a posting page, or null if this page doesn't show one. */
export function jobFromDocument(doc: Document, hostname: string, url: string): PageJob | null {
  const adapter = adapterFor(hostname);
  if (adapter?.id === "Greenhouse") return greenhouseJob(doc, url);
  if (adapter?.id === "Lever") return leverJob(doc, url);
  return null;
}
