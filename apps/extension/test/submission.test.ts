// @vitest-environment jsdom
/** Tests for noticing submissions: which buttons count, and which pages confirm. */
import { describe, expect, it } from "vitest";
import { isSubmitControl, looksSubmitted } from "../src/submission";

const button = (html: string) => {
  document.body.innerHTML = html;
  return document.body.querySelector("[data-test]")!;
};

describe("isSubmitControl", () => {
  it("recognizes submit buttons on each site", () => {
    expect(isSubmitControl(button('<form><button data-test type="submit">Send</button></form>'))).toBe(true);
    expect(isSubmitControl(button('<button data-test>Submit Application</button>'))).toBe(true);
    expect(isSubmitControl(button('<button data-test aria-label="Submit application"><span>Submit application</span></button>'))).toBe(true);
    expect(isSubmitControl(button('<div role="button" data-test>Submit</div>'))).toBe(true);
  });

  it("ignores other buttons, including Next and Apply", () => {
    expect(isSubmitControl(button('<button data-test type="button">Next</button>'))).toBe(false);
    expect(isSubmitControl(button('<button data-test>Apply</button>'))).toBe(false);
    expect(isSubmitControl(button('<button data-test>Upload File</button>'))).toBe(false);
    expect(isSubmitControl(button('<span data-test>Submit application</span>'))).toBe(false);
  });
});

describe("looksSubmitted", () => {
  it("matches the confirmation wording sites use", () => {
    for (const text of [
      "Thank you for applying to Acme!",
      "Application submitted",
      "Your application was sent to Example Labs",
      "Thanks for your application. We'll be in touch.",
      "We have received your application",
    ]) {
      expect(looksSubmitted(text), text).toBe(true);
    }
  });

  it("doesn't match ordinary job pages", () => {
    expect(looksSubmitted("Apply for this job. Submit your application below.")).toBe(false);
    expect(looksSubmitted("Thank you for your interest in Acme.")).toBe(false);
  });
});
