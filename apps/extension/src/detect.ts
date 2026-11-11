import type { FieldDescriptor } from "./types";

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

    fields.push({
      descriptor: {
        ...base,
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
