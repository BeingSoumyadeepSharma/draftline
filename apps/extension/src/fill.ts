import type { DetectedField } from "./detect";
import {
  isLocationLabel,
  pickLocation,
  pickOption,
  RESUME_VALUE,
} from "./match";
import type { FillResult, ResumeAttachment } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(40);
  }
}

/**
 * React tracks input values through the element's own setter, so writing
 * `.value` directly is ignored. Calling the prototype's setter is what makes
 * the page's framework see the change.
 */
function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const view = element.ownerDocument.defaultView!;
  const proto =
    element.tagName === "TEXTAREA"
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
  element.dispatchEvent(new view.Event("input", { bubbles: true }));
}

function fire(element: HTMLElement, type: string): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(new view.Event(type, { bubbles: true }));
}

function press(element: HTMLElement, key: string): void {
  const view = element.ownerDocument.defaultView!;
  element.dispatchEvent(
    new view.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function fillText(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  element.focus();
  setNativeValue(element, value);
  fire(element, "change");
  element.blur();
}

function menuOptions(input: HTMLElement): HTMLElement[] {
  const scope = input.closest(".select") ?? input.ownerDocument;
  return [...scope.querySelectorAll<HTMLElement>("[role='option']")];
}

type Picker = (value: string, options: string[]) => string | null;

async function fillCombobox(
  input: HTMLInputElement,
  value: string,
  isLocation: boolean,
): Promise<string | null> {
  const pick: Picker = isLocation ? pickLocation : pickOption;
  const scope = input.closest(".select") ?? input.ownerDocument;
  const findOption = () => {
    const options = menuOptions(input);
    const texts = options.map((option) => option.textContent ?? "");
    const picked = pick(value, texts);
    return picked === null ? null : options[texts.indexOf(picked)];
  };
  // Location fields look places up online, which can take a few seconds.
  const timeoutMs = isLocation ? 4000 : 1500;
  const searchFor = async (query: string) => {
    setNativeValue(input, query);
    // Stop early once the dropdown says nothing was found.
    const found = await waitFor(
      () =>
        findOption() ??
        (scope.querySelector(".select__menu-notice--no-options") ? "none" : null),
      timeoutMs,
    );
    return found && found !== "none" ? found : null;
  };

  input.focus();
  press(input, "ArrowDown");
  await waitFor(() => menuOptions(input).length > 0, 500);

  // Long lists and place lookups only show matches once you type.
  let option = findOption() ?? (await searchFor(value));
  const city = value.split(",")[0]?.trim();
  if (!option && isLocation && city && city !== value) {
    option = await searchFor(city);
  }

  if (!option) {
    setNativeValue(input, "");
    press(input, "Escape");
    input.blur();
    return `None of the choices matched "${value}"`;
  }

  option.click();
  input.blur();
  return null;
}

/**
 * Lever searches only after a keypress and clears the box if it loses focus
 * with suggestions open, so this types, waits for results, and picks one the
 * way a click would. If nothing fits, the box is left empty for the user.
 */
async function fillSuggest(
  input: HTMLInputElement,
  value: string,
): Promise<string | null> {
  const view = input.ownerDocument.defaultView!;
  const scope = input.closest(".application-field") ?? input.ownerDocument;
  const options = () => [
    ...scope.querySelectorAll<HTMLElement>(".dropdown-location"),
  ];

  const noResults = scope.querySelector<HTMLElement>(".dropdown-no-results");

  const search = async (query: string) => {
    const previous = new Set(options());
    // Clear a "no results" notice left over from an earlier search.
    if (noResults) noResults.style.display = "none";
    input.focus();
    setNativeValue(input, query);
    press(input, "a");
    // Wait for a fresh result list, or for Lever to say there are none.
    await waitFor(
      () =>
        options().some((o) => !previous.has(o)) ||
        noResults?.style.display === "flex",
      4000,
    );
    const list = options();
    const texts = list.map((o) => o.textContent?.trim() ?? "");
    const picked = pickLocation(value, texts);
    return picked === null ? null : list[texts.indexOf(picked)]!;
  };

  let option = await search(value);
  const city = value.split(",")[0]?.trim();
  if (!option && city && city !== value) option = await search(city);

  if (!option) {
    setNativeValue(input, "");
    input.blur();
    return `None of the suggestions matched "${value}"`;
  }
  option.dispatchEvent(
    new view.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  input.blur();
  return null;
}

function attachFile(input: HTMLInputElement, resume: ResumeAttachment): void {
  const view = input.ownerDocument.defaultView!;
  const bytes = Uint8Array.from(atob(resume.base64), (c) => c.charCodeAt(0));
  const file = new view.File([bytes], resume.name, { type: "application/pdf" });
  const transfer = new view.DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  fire(input, "change");
}

function choiceFor(
  field: DetectedField,
  value: string,
): HTMLInputElement | null {
  const { options } = field.descriptor;
  const index = options.indexOf(value);
  return index >= 0 ? (field.elements[index] as HTMLInputElement) : null;
}

/** Fills one field. Nothing here can submit the form. */
export async function fillField(
  field: DetectedField,
  value: string,
  resume: ResumeAttachment | null,
): Promise<FillResult> {
  const { key, kind } = field.descriptor;
  const fail = (reason: string): FillResult => ({ key, ok: false, reason });
  const element = field.elements[0];
  if (!element) return fail("This field is no longer on the page");

  try {
    switch (kind) {
      case "text":
      case "textarea":
        fillText(element as HTMLInputElement, value);
        return { key, ok: true };
      case "select": {
        const select = element as HTMLSelectElement;
        const option = [...select.options].find((o) => o.text.trim() === value);
        if (!option) return fail("That choice is no longer available");
        select.value = option.value;
        fire(select, "change");
        return { key, ok: true };
      }
      case "radio":
      case "checkboxes": {
        const choice = choiceFor(field, value);
        if (!choice) return fail("That choice is no longer available");
        choice.click();
        return { key, ok: true };
      }
      case "combobox": {
        const problem = await fillCombobox(
          element as HTMLInputElement,
          value,
          isLocationLabel(field.descriptor.label),
        );
        return problem ? fail(problem) : { key, ok: true };
      }
      case "suggest": {
        const problem = await fillSuggest(element as HTMLInputElement, value);
        return problem ? fail(problem) : { key, ok: true };
      }
      case "file":
        if (value !== RESUME_VALUE || !resume) return fail("No file to attach");
        attachFile(element as HTMLInputElement, resume);
        return { key, ok: true };
      case "checkbox":
        return fail("Tick this yourself");
    }
  } catch (error) {
    return fail(`Could not fill this field: ${(error as Error).message}`);
  }
}
