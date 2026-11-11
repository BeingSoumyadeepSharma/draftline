/**
 * Tests for the no-AI matching rules in match.ts.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE, type Answer, type Profile } from "@draftline/shared";
import {
  matchField,
  pickLocation,
  pickOption,
  RESUME_VALUE,
  type MatchData,
} from "../src/match";
import type { FieldDescriptor } from "../src/types";

const profile: Profile = {
  ...EMPTY_PROFILE,
  contact: {
    fullName: "Ada Mary Lovelace",
    email: "ada@example.com",
    phone: "555-0100",
    location: "London",
    links: [{ label: "LinkedIn", url: "https://linkedin.com/in/ada" }],
  },
};

const answer = (
  question: string,
  value: string,
  category: Answer["category"] = "general",
): Answer => ({ id: question, question, answer: value, category });

const data: MatchData = {
  profile,
  resumeName: "ada.pdf",
  answers: [
    answer("Are you legally authorized to work in this country?", "Yes", "work_authorization"),
    answer("Will you now or in the future require visa sponsorship?", "No", "work_authorization"),
    answer("Gender", "Decline to self-identify", "demographics"),
    answer("Disability status", "", "demographics"),
  ],
};

const field = (label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  key: label,
  label,
  kind: "text",
  required: false,
  options: [],
  currentValue: "",
  ...extra,
});

describe("profile fields", () => {
  it("splits names and fills contact details", () => {
    expect(matchField(field("First Name"), data)).toMatchObject({ value: "Ada" });
    expect(matchField(field("Last Name"), data)).toMatchObject({ value: "Mary Lovelace" });
    expect(matchField(field("Full name"), data)).toMatchObject({ value: "Ada Mary Lovelace" });
    expect(matchField(field("Email"), data)).toMatchObject({ value: "ada@example.com" });
    expect(matchField(field("LinkedIn URL"), data)).toMatchObject({
      value: "https://linkedin.com/in/ada",
    });
  });

  it("does not mistake a preferred-name question for the applicant's name", () => {
    const decision = matchField(
      field("What's the name you'd prefer us to use throughout the interview process?"),
      data,
    );
    expect(decision.status).toBe("needs_you");
  });

  it("flags a fact missing from the profile instead of guessing", () => {
    expect(matchField(field("GitHub URL"), data).status).toBe("needs_you");
  });

  it("leaves fields the user already filled alone", () => {
    expect(matchField(field("Email", { currentValue: "x@y.z" }), data).status).toBe("skip");
  });

  it("never fills a free-text question it has no saved answer for", () => {
    expect(matchField(field("Why do you want to join us?"), data).status).toBe("needs_you");
  });
});

describe("sensitive questions", () => {
  it("uses the saved answer despite different wording", () => {
    const decision = matchField(
      field("Are you legally authorized to work in the country for which you are applying?", {
        kind: "radio",
        options: ["Yes", "No"],
      }),
      data,
    );
    expect(decision).toMatchObject({ status: "ready", value: "Yes" });
  });

  it("asks for confirmation when the question names a specific place", () => {
    const decision = matchField(
      field("Are you authorized to work in the United States?", {
        kind: "radio",
        options: ["Yes", "No"],
      }),
      data,
    );
    expect(decision).toMatchObject({ status: "confirm", value: "Yes" });
  });

  it("never answers without a saved answer", () => {
    expect(matchField(field("Veteran status"), data).status).toBe("needs_you");
    expect(matchField(field("Disability status"), data).status).toBe("needs_you");
  });

  it("does not treat an accommodation request as a disability answer", () => {
    const saved = {
      ...data,
      answers: [answer("Disability status", "No", "demographics")],
    };
    const decision = matchField(
      field("Do you need any accommodation for a disability during interviews?"),
      saved,
    );
    expect(decision.status).toBe("needs_you");
  });

  it("refuses when one question covers two topics", () => {
    const decision = matchField(
      field("Are you authorized to work without sponsorship?"),
      data,
    );
    expect(decision.status).toBe("needs_you");
  });

  it("refuses when the saved answer is not one of the choices", () => {
    const decision = matchField(
      field("Gender", { kind: "select", options: ["Male", "Female"] }),
      data,
    );
    expect(decision.status).toBe("needs_you");
  });
});

describe("other field types", () => {
  it("attaches the resume only to a resume field", () => {
    expect(matchField(field("Resume/CV", { kind: "file" }), data)).toMatchObject({
      status: "ready",
      value: RESUME_VALUE,
    });
    expect(matchField(field("Cover Letter", { kind: "file" }), data).status).toBe("needs_you");
  });

  it("flags a resume field when no file is saved", () => {
    const decision = matchField(field("Resume/CV", { kind: "file" }), {
      ...data,
      resumeName: null,
    });
    expect(decision.status).toBe("needs_you");
  });

  it("never ticks a lone consent checkbox", () => {
    expect(matchField(field("I agree to the terms", { kind: "checkbox" }), data).status).toBe(
      "needs_you",
    );
  });
});

describe("pickLocation", () => {
  it("matches on city and country despite different wording", () => {
    expect(pickLocation("Milan, Italy", ["Milano, Milan, Italy", "Rome, Italy"])).toBe(
      "Milano, Milan, Italy",
    );
    expect(
      pickLocation("Milan, Lombardy, Italy", ["Milano, Milan, Italy"]),
    ).toBe("Milano, Milan, Italy");
  });

  it("refuses when more than one place fits", () => {
    expect(
      pickLocation("Milan", ["Milano, Milan, Italy", "Milan, Tennessee, United States"]),
    ).toBeNull();
  });

  it("refuses when the country differs", () => {
    expect(pickLocation("Milan, Italy", ["Milan, Tennessee, United States"])).toBeNull();
  });
});

describe("pickOption", () => {
  it("matches exactly, then by a unique prefix", () => {
    expect(pickOption("yes", ["Yes", "No"])).toBe("Yes");
    expect(pickOption("Yes", ["Yes, I am authorized", "No, I am not"])).toBe(
      "Yes, I am authorized",
    );
  });

  it("returns null when the choice is unclear", () => {
    expect(pickOption("Yes", ["Yes, now", "Yes, later"])).toBeNull();
    expect(pickOption("Maybe", ["Yes", "No"])).toBeNull();
  });
});

describe("AI eligibility", () => {
  it("lets AI draft only questions no rule covers", () => {
    expect(matchField(field("Why do you want to join us?"), data)).toMatchObject({
      status: "needs_you",
      canDraft: true,
    });
    expect(matchField(field("Veteran status"), data)).not.toHaveProperty("canDraft");
    expect(matchField(field("GitHub URL"), data)).not.toHaveProperty("canDraft");
  });
});

describe("isSensitiveQuestion", () => {
  it("covers protected and legal topics, not ordinary questions", async () => {
    const { isSensitiveQuestion } = await import("@draftline/shared/questions");
    for (const label of [
      "Are you authorized to work in the US?",
      "Do you require sponsorship?",
      "What are your salary expectations?",
      "Do you identify as transgender?",
      "Have you ever been convicted of a crime?",
      "Do you need any accommodations?",
      "What is your citizenship?",
    ]) {
      expect(isSensitiveQuestion(label), label).toBe(true);
    }
    for (const label of ["Why do you want to join?", "Years of experience with Python", "Portfolio URL"]) {
      expect(isSensitiveQuestion(label), label).toBe(false);
    }
  });
});
