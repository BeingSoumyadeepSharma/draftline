/**
 * Question topics shared by the extension (rule matching) and the server
 * (AI guardrails). Kept free of dependencies so the page script stays small.
 */

/**
 * Topics where the wording varies between forms but the saved answer is the
 * same. Anything sensitive must land here or match a saved question exactly,
 * so it can never be filled from a loose guess.
 */
const INTENTS: ReadonlyArray<[string, RegExp]> = [
  ["sponsorship", /sponsor/],
  ["work_auth", /authori[sz]ed to work|right to work|eligible to work|work authori[sz]ation|legally (?:able|allowed) to work/],
  ["salary", /salary|compensation expectation|desired (?:pay|compensation)|expected (?:pay|compensation)/],
  ["gender", /\bgender\b/],
  ["race", /\brace\b|ethnicity|hispanic/],
  ["veteran", /veteran/],
  ["disability", /disabilit/],
  ["notice", /notice period|earliest start|start date|when can you start/],
  ["relocate", /relocat/],
  ["workplace", /hybrid|on-?site|in[- ]office/],
  ["referral", /(?:how|where) did you (?:hear|find)/],
];

const SENSITIVE_INTENTS = new Set([
  "sponsorship",
  "work_auth",
  "salary",
  "gender",
  "race",
  "veteran",
  "disability",
]);

/** Personal or legal topics the user must always answer themselves. */
const SENSITIVE_WORDING =
  /accommodat|adjustment|transgender|sexual orientation|criminal|convict|date of birth|\bage\b|citizen|visa|immigration|religio|marital|pregnan|national origin/;

export function intentsOf(text: string): string[] {
  const lower = text.toLowerCase();
  // Accommodation questions mention disability but ask something different.
  if (/accommodat|adjustment/.test(lower)) return [];
  return INTENTS.filter(([, pattern]) => pattern.test(lower)).map(([id]) => id);
}

/** True for questions AI must never answer, even as a draft. */
export function isSensitiveQuestion(label: string): boolean {
  return (
    SENSITIVE_WORDING.test(label.toLowerCase()) ||
    intentsOf(label).some((intent) => SENSITIVE_INTENTS.has(intent))
  );
}
