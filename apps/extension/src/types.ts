/**
 * Types for messages between the side panel and the content script. They must
 * be plain data, because Chrome passes messages as JSON.
 */
export type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkboxes"
  | "checkbox"
  | "combobox"
  /** A text box whose site-made suggestion list must be picked from (Lever location). */
  | "suggest"
  | "file";

/** A form field as plain data, safe to pass between the page and the panel. */
export type FieldDescriptor = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** Known choices. Empty for dropdowns that only load options when opened. */
  options: string[];
  currentValue: string;
  /** The field's character limit, when the page sets one. */
  maxLength?: number;
  note?: string;
};

/** The job as read from the page. */
export type PageJob = {
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
};

export type FillRequest = { key: string; value: string };

export type ResumeAttachment = { name: string; base64: string };

export type FillResult = { key: string; ok: boolean; reason?: string };

export type ContentMessage =
  | { type: "scan" }
  | { type: "fill"; fields: FillRequest[]; resume: ResumeAttachment | null };

export type ScanResponse = {
  site: string;
  fields: FieldDescriptor[];
  job: PageJob | null;
};
export type FillResponse = { results: FillResult[] };
