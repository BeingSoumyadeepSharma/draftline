// @vitest-environment jsdom
/**
 * Tests against saved copies of real Greenhouse and Lever pages (test/fixtures)
 * and real react-select components, so reading and filling are checked against
 * the same markup the live sites use.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, useState, act } from "react";
import { createRoot } from "react-dom/client";
import Select from "react-select";
import AsyncSelect from "react-select/async";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@draftline/shared";
import { detectFields, jobFromDocument, type DetectedField } from "../src/detect";
import { fillField } from "../src/fill";
import { matchField, type MatchData } from "../src/match";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const load = (name: string) => {
  document.body.innerHTML = readFileSync(
    path.join(import.meta.dirname, "fixtures", name),
    "utf8",
  );
};

const data: MatchData = {
  profile: {
    ...EMPTY_PROFILE,
    contact: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "555-0100",
      location: "London",
      links: [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }],
    },
  },
  resumeName: "ada.pdf",
  answers: [
    {
      id: "1",
      question: "Are you legally authorized to work in this country?",
      answer: "Yes",
      category: "work_authorization",
    },
  ],
};

const byLabel = (fields: DetectedField[], label: string) => {
  const found = fields.find((f) => f.descriptor.label === label);
  if (!found) {
    throw new Error(
      `No field "${label}" in: ${fields.map((f) => f.descriptor.label).join(" | ")}`,
    );
  }
  return found;
};

describe("real Greenhouse form", () => {
  beforeEach(() => load("greenhouse.html"));
  const host = "job-boards.greenhouse.io";

  it("reads the visible fields with their real labels", () => {
    const fields = detectFields(document, host)!;
    expect(byLabel(fields, "First Name").descriptor.kind).toBe("text");
    expect(byLabel(fields, "Resume/CV").descriptor.kind).toBe("file");
    expect(byLabel(fields, "Phone").descriptor.kind).toBe("text");
    expect(byLabel(fields, "Gender").descriptor.kind).toBe("combobox");
    expect(fields.some((f) => f.descriptor.label === "")).toBe(false);
  });

  it("maps the standard fields and flags the rest", () => {
    const fields = detectFields(document, host)!;
    const decide = (label: string) =>
      matchField(byLabel(fields, label).descriptor, data);
    expect(decide("First Name")).toMatchObject({ status: "ready", value: "Ada" });
    expect(decide("Last Name")).toMatchObject({ status: "ready", value: "Lovelace" });
    expect(decide("Email")).toMatchObject({ status: "ready" });
    expect(decide("LinkedIn Profile")).toMatchObject({ status: "ready" });
    expect(decide("Gender").status).toBe("needs_you");
  });

  it("ignores Greenhouse's hidden validation inputs", () => {
    const fields = detectFields(document, host)!;
    const hidden = fields.flatMap((f) => f.elements).filter(
      (el) => el.getAttribute("aria-hidden") === "true",
    );
    expect(hidden).toEqual([]);
  });

  it("finds the form in a MyGreenhouse pop-up with no form element", () => {
    const form = document.querySelector("form")!;
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.append(...form.childNodes);
    document.body.replaceChildren(dialog);

    const fields = detectFields(document, "my.greenhouse.io")!;
    expect(fields).not.toBeNull();
    expect(byLabel(fields, "First Name").descriptor.kind).toBe("text");
    expect(byLabel(fields, "Resume/CV").descriptor.kind).toBe("file");
  });
});

describe("real Lever form", () => {
  beforeEach(() => load("lever.html"));
  const host = "jobs.lever.co";

  it("reads text, dropdown, radio, and file fields", () => {
    const fields = detectFields(document, host)!;
    expect(byLabel(fields, "Full name").descriptor.kind).toBe("text");
    expect(byLabel(fields, "LinkedIn URL").descriptor.kind).toBe("text");
    expect(byLabel(fields, "Resume/CV").descriptor.kind).toBe("file");
    const auth = byLabel(
      fields,
      "Are you legally authorized to work in the country for which you are applying?",
    );
    expect(auth.descriptor.kind).toBe("radio");
    expect(auth.descriptor.options).toEqual(["Yes", "No"]);
    expect(auth.descriptor.required).toBe(true);
    expect(auth.elements).toHaveLength(2);
  });

  it("fills a radio group from a saved answer", async () => {
    const fields = detectFields(document, host)!;
    const auth = byLabel(
      fields,
      "Are you legally authorized to work in the country for which you are applying?",
    );
    const decision = matchField(auth.descriptor, data);
    expect(decision).toMatchObject({ status: "ready", value: "Yes" });
    const result = await fillField(auth, "Yes", null);
    expect(result.ok).toBe(true);
    expect((auth.elements[0] as HTMLInputElement).checked).toBe(true);
  });

  /**
   * Mirrors Lever's retrieveLocations.js: searches on keydown after a delay,
   * picks on mousedown, and clears the box on blur while results are open.
   */
  function mimicLeverLocations(places: string[]) {
    const input = document.querySelector<HTMLInputElement>("input.location-input")!;
    const list = document.querySelector<HTMLElement>(".dropdown-results")!;
    const noResults = document.querySelector<HTMLElement>(".dropdown-no-results")!;
    const selected = document.createElement("input");
    selected.type = "hidden";
    input.after(selected);
    let open = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    input.addEventListener("input", () => (open = true));
    input.addEventListener("keydown", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        list.replaceChildren();
        noResults.style.display = "none";
        const query = input.value.toLowerCase();
        const found = places.filter((p) => p.toLowerCase().includes(query));
        found.forEach((place, i) => {
          const option = document.createElement("div");
          option.className = "dropdown-location";
          option.id = `location-${i}`;
          option.textContent = place;
          list.append(option);
        });
        if (found.length === 0) noResults.style.display = "flex";
      }, 30);
    });
    document.addEventListener("mousedown", (event) => {
      const option = (event.target as HTMLElement).closest(".dropdown-location");
      if (!option) return;
      input.value = option.textContent!;
      selected.value = option.textContent!;
      open = false;
      list.replaceChildren();
    });
    input.addEventListener("blur", () => {
      if (!open) return;
      input.value = "";
      selected.value = "";
    });
    return { input, selected };
  }

  const locationField = () =>
    detectFields(document, host)!.find(
      (f) => f.descriptor.key === "location-input",
    )!;

  it("treats the location box as a suggestion list", () => {
    expect(locationField().descriptor.kind).toBe("suggest");
    expect(matchField(locationField().descriptor, data)).toMatchObject({
      status: "ready",
      value: "London",
    });
  });

  it("picks the suggestion matching the saved city and country", async () => {
    const { input, selected } = mimicLeverLocations([
      "Milano, Milan, Italy",
      "Milan, Tennessee, United States",
    ]);
    const result = await fillField(locationField(), "Milan, Italy", null);
    expect(result).toEqual({ key: "location-input", ok: true });
    expect(input.value).toBe("Milano, Milan, Italy");
    expect(selected.value).toBe("Milano, Milan, Italy");
  });

  it("leaves the location empty when the choice is ambiguous", async () => {
    const { input, selected } = mimicLeverLocations([
      "Springfield, Illinois, United States",
      "Springfield, Missouri, United States",
    ]);
    const result = await fillField(locationField(), "Springfield", null);
    expect(result.ok).toBe(false);
    expect(input.value).toBe("");
    expect(selected.value).toBe("");
  });

  it("returns nothing on a page without an application form", () => {
    document.body.innerHTML = "<main>Job description only</main>";
    expect(detectFields(document, host)).toBeNull();
  });
});

describe("filling React-controlled fields", () => {
  it("updates a controlled input's React state", async () => {
    let seen = "";
    function Input() {
      const [value, setValue] = useState("");
      seen = value;
      return h("input", {
        id: "first_name",
        value,
        onChange: (e: { target: { value: string } }) => setValue(e.target.value),
      });
    }
    document.body.innerHTML = '<div id="app"></div>';
    const root = createRoot(document.getElementById("app")!);
    await act(async () => root.render(h(Input)));

    const element = document.getElementById("first_name") as HTMLElement;
    await fillField(
      {
        descriptor: {
          key: "first_name",
          label: "First Name",
          kind: "text",
          required: true,
          options: [],
          currentValue: "",
        },
        elements: [element],
      },
      "Ada",
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toBe("Ada");
    root.unmount();
  });

  function renderSelect(onValue: (value: string) => void) {
    document.body.innerHTML = '<div class="select"><div id="app"></div></div>';
    const root = createRoot(document.getElementById("app")!);
    root.render(
      h(Select as never, {
        classNamePrefix: "select",
        inputId: "gender",
        options: [
          { value: "1", label: "Male" },
          { value: "2", label: "Female" },
          { value: "3", label: "Decline To Self Identify" },
        ],
        onChange: (option: { label: string }) => onValue(option.label),
      }),
    );
    return root;
  }

  const combobox = (element: HTMLElement): DetectedField => ({
    descriptor: {
      key: "gender",
      label: "Gender",
      kind: "combobox",
      required: false,
      options: [],
      currentValue: "",
    },
    elements: [element],
  });

  it("opens a real react-select and picks the matching option", async () => {
    let picked = "";
    const root = renderSelect((value) => (picked = value));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await fillField(
      combobox(document.getElementById("gender")!),
      "Decline to self-identify",
      null,
    );

    expect(result).toEqual({ key: "gender", ok: true });
    expect(picked).toBe("Decline To Self Identify");
    root.unmount();
  });

  function renderLocationSearch(onValue: (value: string) => void) {
    const places = [
      "Milano, Milan, Italy",
      "Milan, Tennessee, United States",
      "Rome, Lazio, Italy",
    ];
    document.body.innerHTML = '<div class="select"><div id="app"></div></div>';
    const root = createRoot(document.getElementById("app")!);
    root.render(
      h(AsyncSelect as never, {
        classNamePrefix: "select",
        inputId: "location",
        // Like a place lookup: results depend on the typed text and arrive later.
        loadOptions: (text: string) =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  places
                    .filter((p) => p.toLowerCase().includes(text.toLowerCase()))
                    .map((label) => ({ value: label, label })),
                ),
              40,
            ),
          ),
        onChange: (option: { label: string }) => onValue(option.label),
      }),
    );
    return root;
  }

  const locationCombobox = (element: HTMLElement): DetectedField => ({
    descriptor: {
      key: "location",
      label: "Location",
      kind: "combobox",
      required: true,
      options: [],
      currentValue: "",
    },
    elements: [element],
  });

  it("finds a place by city when the full location returns nothing", async () => {
    let picked = "";
    const root = renderLocationSearch((value) => (picked = value));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const started = Date.now();
    const result = await fillField(
      locationCombobox(document.getElementById("location")!),
      "Milan, Italy",
      null,
    );

    expect(result).toEqual({ key: "location", ok: true });
    expect(picked).toBe("Milano, Milan, Italy");
    // The "no options" notice ends the first search early instead of timing out.
    expect(Date.now() - started).toBeLessThan(3000);
    root.unmount();
  });

  it("leaves a place lookup empty when the country doesn't match", async () => {
    let picked = "";
    const root = renderLocationSearch((value) => (picked = value));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await fillField(
      locationCombobox(document.getElementById("location")!),
      "Rome, Georgia",
      null,
    );

    expect(result.ok).toBe(false);
    expect(picked).toBe("");
    root.unmount();
  });

  it("leaves a react-select empty when nothing matches", async () => {
    let picked = "";
    const root = renderSelect((value) => (picked = value));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const result = await fillField(
      combobox(document.getElementById("gender")!),
      "Prefer to describe",
      null,
    );

    expect(result.ok).toBe(false);
    expect(picked).toBe("");
    root.unmount();
  });
});

describe("reading the job description", () => {
  const parse = (name: string) =>
    new DOMParser().parseFromString(
      readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"),
      "text/html",
    );

  it("reads a real Greenhouse posting", () => {
    const job = jobFromDocument(
      parse("greenhouse-job.html"),
      "job-boards.greenhouse.io",
      "https://job-boards.greenhouse.io/gitlab/jobs/1",
    )!;
    expect(job.title).toBe("AI Transformation Owner, CRO");
    expect(job.company).toBe("GitLab");
    expect(job.location).toBe("Remote, United States");
    expect(job.description).toContain("GitLab is the intelligent orchestration platform");
    expect(job.description).toContain("\n- ");
    expect(job.description.length).toBeGreaterThan(200);
  });

  it("reads a real Lever posting without the apply button", () => {
    const job = jobFromDocument(
      parse("lever-posting.html"),
      "jobs.lever.co",
      "https://jobs.lever.co/palantir/1",
    )!;
    expect(job.title).toBe("Administrative Business Partner");
    expect(job.company).toBe("Palantir Technologies");
    expect(job.location).toBe("Singapore, Singapore");
    expect(job.description).toContain("A World-Changing Company");
    expect(job.description).not.toMatch(/\bApply\s*$/);
  });

  it("returns nothing on a Lever apply page, which has no description", () => {
    load("lever.html");
    expect(jobFromDocument(document, "jobs.lever.co", "https://jobs.lever.co/x/apply")).toBeNull();
  });

  it("passes on a field's character limit", () => {
    load("greenhouse.html");
    const fields = detectFields(document, "job-boards.greenhouse.io")!;
    expect(byLabel(fields, "First Name").descriptor.maxLength).toBe(255);
  });
});

describe("reading a MyGreenhouse pop-up", () => {
  const description = `
    <h2>Company Description</h2>
    <p>Moviri started as a research spinoff at Politecnico of Milan and was incubated at its startup accelerator.</p>
    <p>Moviri Consulting is the first company of Moviri and its foundation. Its professionals use data, software, and insights to solve business challenges.</p>
    <h2>What you'll do</h2>
    <p>As part of our AI Labs team, you'll contribute to projects ranging from traditional Machine Learning to the latest Generative AI applications.</p>`;

  function renderPopUp() {
    load("greenhouse.html");
    const form = document.querySelector("form")!;
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<div class="content">${description}</div><h2>Apply for this job</h2><p>* indicates a required field</p>`;
    dialog.append(form);
    document.body.replaceChildren(dialog);
  }

  it("reads the description shown above the form", () => {
    renderPopUp();
    const job = jobFromDocument(document, "my.greenhouse.io", "https://my.greenhouse.io/jobs/1")!;
    expect(job).not.toBeNull();
    expect(job.title).toBe("Company Description");
    expect(job.description).toContain("research spinoff at Politecnico of Milan");
    expect(job.description).toContain("Generative AI applications");
    expect(job.description).not.toContain("Apply for this job");
    expect(job.description).not.toContain("First Name");
  });

  it("returns nothing when only a heading sits above the form", () => {
    load("greenhouse.html");
    const form = document.querySelector("form")!;
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = "<h2>Apply for this job</h2>";
    dialog.append(form);
    document.body.replaceChildren(dialog);
    expect(jobFromDocument(document, "my.greenhouse.io", "https://my.greenhouse.io/jobs/1")).toBeNull();
  });
});
