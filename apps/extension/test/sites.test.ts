// @vitest-environment jsdom
/**
 * Tests for the Phase 5 sites. The Ashby fixture recreates live forms; the
 * Workday and LinkedIn fixtures are built from those sites' known markup
 * because their forms need an account, so they check Draftline's assumptions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "@draftline/shared";
import {
  canonicalJobUrl,
  detectFields,
  jobFromDocument,
  jobFromWorkdayApi,
  workdayJobApiUrl,
  type DetectedField,
} from "../src/detect";
import { fillField } from "../src/fill";
import { matchField, type MatchData } from "../src/match";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

function load(name: string) {
  const doc = new DOMParser().parseFromString(fixture(name), "text/html");
  document.documentElement.replaceWith(document.importNode(doc.documentElement, true));
}

const byLabel = (fields: DetectedField[], label: string) => {
  const found = fields.find((f) => f.descriptor.label === label);
  if (!found) {
    throw new Error(`No "${label}" in: ${fields.map((f) => f.descriptor.label).join(" | ")}`);
  }
  return found;
};

const data: MatchData = {
  profile: {
    ...EMPTY_PROFILE,
    contact: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "555-0100",
      location: "Milan, Italy",
      links: [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }],
    },
  },
  resumeName: "ada.pdf",
  answers: [
    { id: "1", question: "Will you now or in the future require visa sponsorship?", answer: "No", category: "work_authorization" },
  ],
};

describe("Ashby", () => {
  const host = "jobs.ashbyhq.com";
  beforeEach(() => load("ashby.html"));

  it("reads every question with its label, skipping the autofill uploader", () => {
    const fields = detectFields(document, host)!;
    expect(fields.map((f) => [f.descriptor.label, f.descriptor.kind])).toEqual([
      ["Name", "text"],
      ["Email", "text"],
      ["Location", "combobox"],
      ["Resume", "file"],
      ["LinkedIn", "text"],
      ["Are you based in a EU or equivalent timezone?", "buttons"],
      ["Which office would you work from?", "radio"],
      ["How did you hear about this opportunity? (select all that apply)", "checkboxes"],
      ["What would you want to work on?", "textarea"],
    ]);
    expect(byLabel(fields, "Which office would you work from?").descriptor.options).toEqual([
      "Milan",
      "Remote",
    ]);
    const heard = byLabel(fields, "How did you hear about this opportunity? (select all that apply)");
    expect(heard.descriptor.options).toEqual(["LinkedIn", "Referral"]);
    expect(heard.descriptor.key).toBe("0b3b7773-f6d9-4032-9ab1-368c4164e95a");
    expect(byLabel(fields, "Name").descriptor.required).toBe(true);
  });

  it("fills standard fields from the profile", () => {
    const fields = detectFields(document, host)!;
    expect(matchField(byLabel(fields, "Name").descriptor, data)).toMatchObject({ value: "Ada Lovelace" });
    expect(matchField(byLabel(fields, "LinkedIn").descriptor, data)).toMatchObject({
      value: "https://linkedin.com/in/ada",
    });
    expect(matchField(byLabel(fields, "Resume").descriptor, data)).toMatchObject({ status: "ready" });
  });

  it("answers a Yes/No question by pressing the button", async () => {
    const field = byLabel(detectFields(document, host)!, "Are you based in a EU or equivalent timezone?");
    expect(field.descriptor.options).toEqual(["Yes", "No"]);
    const [yes] = field.elements as HTMLButtonElement[];
    yes!.addEventListener("click", () => yes!.setAttribute("aria-pressed", "true"));

    const result = await fillField(field, "Yes", {});
    expect(result.ok).toBe(true);
    expect(yes!.getAttribute("aria-pressed")).toBe("true");
  });

  it("reads the job from the page's embedded data", () => {
    const job = jobFromDocument(document, host, "https://jobs.ashbyhq.com/example/1/application")!;
    expect(job.title).toBe("Software Engineer, Platform");
    expect(job.company).toBe("Example Co");
    expect(job.location).toBe("Milan, Italy");
    expect(job.description).toContain('tools for teams {and their "agents"}');
    expect(job.description).toContain("- Own reliability");
  });
});

describe("never submitting", () => {
  it("refuses to press a button that would submit a form", async () => {
    document.body.innerHTML =
      '<form><div class="ashby-application-form-container"><div class="ashby-application-form-field-entry"><label for="q">Ready?</label><div class="ashby-application-form-input-yesno"><button>Yes</button><button>No</button><input type="checkbox" id="q" name="q"></div></div></div></form>';
    let submitted = false;
    document.querySelector("form")!.addEventListener("submit", (e) => {
      submitted = true;
      e.preventDefault();
    });
    const field = detectFields(document, "jobs.ashbyhq.com")![0]!;
    const result = await fillField(field, "Yes", {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("submit");
    expect(submitted).toBe(false);
  });
});

describe("Workday", () => {
  const host = "nvidia.wd5.myworkdayjobs.com";
  beforeEach(() => load("workday.html"));

  it("reads fields by their labels and ignores the job search box", () => {
    const fields = detectFields(document, host)!;
    expect(fields.map((f) => [f.descriptor.label, f.descriptor.kind])).toEqual([
      ["First Name", "text"],
      ["Last Name", "text"],
      ["Email Address", "text"],
      ["Country", "listbox"],
      ["Have you previously worked for this company?", "radio"],
    ]);
    expect(byLabel(fields, "Country").descriptor.currentValue).toBe("");
    expect(byLabel(fields, "Have you previously worked for this company?").descriptor.options).toEqual([
      "Yes",
      "No",
    ]);
  });

  it("opens a list dropdown and picks the matching choice", async () => {
    const button = document.querySelector<HTMLButtonElement>("[data-automation-id='countryDropdown']")!;
    // Like Workday: the list appears elsewhere in the page when the button is pressed.
    button.addEventListener("click", () => {
      const list = document.createElement("ul");
      list.setAttribute("role", "listbox");
      for (const name of ["France", "Italy", "Spain"]) {
        const option = document.createElement("li");
        option.setAttribute("role", "option");
        option.textContent = name;
        option.addEventListener("click", () => {
          button.textContent = name;
          list.remove();
        });
        list.append(option);
      }
      document.body.append(list);
    });

    const field = byLabel(detectFields(document, host)!, "Country");
    expect(await fillField(field, "Italy", {})).toEqual({ key: "country--country", ok: true });
    expect(button.textContent).toBe("Italy");
  });

  it("finds the public job-details address for application pages", () => {
    expect(
      workdayJobApiUrl(
        "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Israel-Yokneam/Senior-Board-Design-Engineer_JR2029481/apply/applyManually",
      ),
    ).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/Israel-Yokneam/Senior-Board-Design-Engineer_JR2029481",
    );
    expect(workdayJobApiUrl("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite")).toBeNull();
  });

  it("reads the job from Workday's job-details response", () => {
    const job = jobFromWorkdayApi(
      document,
      {
        jobPostingInfo: {
          title: "Senior Board Design Engineer",
          location: "Israel, Yokneam",
          jobDescription: "<p>Our team is looking for an engineer.</p><ul><li>Design boards</li></ul>",
        },
      },
      "https://nvidia.wd5.myworkdayjobs.com/x",
    )!;
    expect(job).toMatchObject({ title: "Senior Board Design Engineer", location: "Israel, Yokneam" });
    expect(job.description).toContain("- Design boards");
  });
});

describe("LinkedIn Easy Apply", () => {
  const host = "www.linkedin.com";
  beforeEach(() => load("linkedin.html"));

  it("reads only the Easy Apply pop-up's fields", () => {
    const fields = detectFields(document, host)!;
    expect(fields.map((f) => [f.descriptor.label, f.descriptor.kind])).toEqual([
      ["Mobile phone number", "text"],
      ["Email address", "select"],
      ["Will you now or in the future require sponsorship?", "radio"],
    ]);
  });

  it("uses the saved sponsorship answer for the radio question", () => {
    const fields = detectFields(document, host)!;
    const sponsor = byLabel(fields, "Will you now or in the future require sponsorship?");
    expect(matchField(sponsor.descriptor, data)).toMatchObject({ value: "No" });
  });

  it("returns nothing when the Easy Apply pop-up isn't open", () => {
    document.querySelector(".jobs-easy-apply-modal")!.remove();
    expect(detectFields(document, host)).toBeNull();
  });

  it("reads the job beside the pop-up", () => {
    const job = jobFromDocument(document, host, "https://www.linkedin.com/jobs/view/123/")!;
    expect(job.title).toBe("Machine Learning Engineer");
    expect(job.company).toBe("Example Labs");
    expect(job.description).toContain("PyTorch");
  });

  it("gives each job one address, whichever page shows it", () => {
    expect(canonicalJobUrl("https://www.linkedin.com/jobs/search/?currentJobId=4012&keywords=ml")).toBe(
      "https://www.linkedin.com/jobs/view/4012/",
    );
    expect(canonicalJobUrl("https://www.linkedin.com/jobs/view/4012/?refId=abc")).toBe(
      "https://www.linkedin.com/jobs/view/4012/",
    );
    expect(canonicalJobUrl("https://jobs.lever.co/x/1/apply#top")).toBe("https://jobs.lever.co/x/1/apply");
  });
});
