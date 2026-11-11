/**
 * The side panel UI. When it opens, and whenever the tab changes, it:
 *   1. loads the profile, saved answers and AI status from the local server
 *   2. asks the content script to scan the page
 *   3. runs match.ts on every field and lists them as Ready to fill,
 *      AI drafts or Needs you
 *   4. on Fill, sends the ticked values to the content script
 *
 * AI work (fit check, drafts) goes through the local server, which holds the API
 * key; the panel never calls an AI provider directly.
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Answer,
  AnswerDraft,
  ApiError,
  JobDocuments,
  JobRecord,
  Profile,
  QuestionInput,
  ResumeFileMeta,
  ResumeFilePayload,
  Status,
} from "@draftline/shared";
import { isSensitiveQuestion } from "@draftline/shared/questions";
import {
  COVER_LETTER_VALUE,
  matchField,
  RESUME_VALUE,
  type Decision,
} from "../match";
import type {
  ContentMessage,
  FieldDescriptor,
  FillResponse,
  FillResult,
  PageJob,
  ScanResponse,
} from "../types";
import "./sidepanel.css";

const API = "http://127.0.0.1:8787/api";
const WEB_APP = "http://127.0.0.1:5173";

type Row = { field: FieldDescriptor; decision: Decision };
type View =
  | { state: "loading" }
  | { state: "server_down" }
  | { state: "no_form"; reachable: boolean }
  | { state: "ready"; site: string; rows: Row[]; job: PageJob | null };

/** An AI draft plus the user's edits to it. */
type Draft = AnswerDraft & { value: string };

async function readError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as ApiError | null;
  return new Error(body?.error ?? `Request failed (${response.status})`);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

type PageReply<T> =
  | { kind: "ok"; data: T }
  /** Draftline runs on this page but found no application form. */
  | { kind: "no_form" }
  /** Draftline doesn't run here: another site, or a tab opened before install. */
  | { kind: "unreachable" };

async function sendToPage<T>(message: ContentMessage): Promise<PageReply<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return { kind: "unreachable" };
  try {
    const data = (await chrome.tabs.sendMessage(tab.id, message)) as T | undefined;
    return data ? { kind: "ok", data } : { kind: "no_form" };
  } catch {
    return { kind: "unreachable" };
  }
}

const DRAFTABLE_KINDS = new Set(["text", "textarea", "select", "radio", "buttons"]);

/** Only questions no rule or saved answer covers, and never sensitive ones. */
const canDraft = ({ field, decision }: Row) =>
  decision.status === "needs_you" &&
  decision.canDraft === true &&
  DRAFTABLE_KINDS.has(field.kind) &&
  !isSensitiveQuestion(field.label);

const sourceLabels = (sources: { label: string }[]) =>
  [...new Set(sources.map((s) => s.label))].join("; ");

/** The job at the top of the panel, with the fit check and its result. */
function JobCard({
  job,
  record,
  aiReady,
  analyzing,
  onAnalyze,
}: {
  job: PageJob;
  record: JobRecord | null;
  aiReady: boolean;
  analyzing: boolean;
  onAnalyze: (refresh: boolean) => void;
}) {
  const analysis = record?.analysis;
  const title = record?.title || job.title || "This job";
  const details = [record?.company || job.company, record?.location || job.location]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="job">
      <div className="job-head">
        <div>
          <div className="job-title">{title}</div>
          {details && <div className="row-note">{details}</div>}
        </div>
        {analysis && (
          <div className="score" title="AI estimate of how well your profile covers the must-haves">
            {analysis.score}
            <span>/100 fit</span>
          </div>
        )}
      </div>

      {!aiReady ? (
        <p className="row-note">
          Set up an AI provider in Draftline's AI settings to check fit and
          draft answers.
        </p>
      ) : analysis ? (
        <>
          <p className="verdict">{analysis.verdict}</p>
          <details>
            <summary>Strengths and gaps</summary>
            {analysis.strengths.length > 0 && (
              <>
                <h3>Strengths</h3>
                <ul>
                  {analysis.strengths.map((s, i) => (
                    <li key={i}>
                      {s.point}
                      <span className="row-note"> ({sourceLabels(s.sources)})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {analysis.gaps.length > 0 && (
              <>
                <h3>Gaps</h3>
                <ul>
                  {analysis.gaps.map((gap, i) => (
                    <li key={i}>{gap}</li>
                  ))}
                </ul>
              </>
            )}
            <button
              className="ghost small"
              disabled={analyzing}
              onClick={() => onAnalyze(true)}
            >
              {analyzing ? "Checking…" : "Check again"}
            </button>
          </details>
        </>
      ) : (
        <button className="ghost" disabled={analyzing} onClick={() => onAnalyze(false)}>
          {analyzing ? "Checking fit…" : "Check fit with AI"}
        </button>
      )}
    </section>
  );
}

/** Status of this job's tailored resume and cover letter, with next steps. */
function DocumentsCard({
  documents,
  aiReady,
  creating,
  onCreate,
  onReview,
}: {
  documents: JobDocuments | null;
  aiReady: boolean;
  creating: boolean;
  onCreate: () => void;
  onReview: () => void;
}) {
  const describe = (doc: { status: "draft" | "approved" } | null | undefined) =>
    !doc
      ? "Not created yet"
      : doc.status === "approved"
        ? "Approved. Will be attached."
        : "Draft. Approve it in Draftline to attach it.";
  const missing = !documents?.resume || !documents?.coverLetter;
  const exists = Boolean(documents?.resume || documents?.coverLetter);
  return (
    <section className="job docs">
      <div className="job-title">Documents for this job</div>
      <p className="row-note">Resume: {describe(documents?.resume)}</p>
      <p className="row-note">Cover letter: {describe(documents?.coverLetter)}</p>
      <div className="docs-actions">
        {aiReady && missing && (
          <button className="ghost small" disabled={creating} onClick={onCreate}>
            {creating ? "Writing…" : exists ? "Create the other with AI" : "Create both with AI"}
          </button>
        )}
        {exists && (
          <button className="ghost small" onClick={onReview}>
            Review and approve
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One AI draft: editable, unticked until the user chooses it, with its
 * sources and any warnings. Can't be ticked while empty or over the limit.
 */
function DraftRow({
  field,
  draft,
  checked,
  result,
  onToggle,
  onChange,
}: {
  field: FieldDescriptor;
  draft: Draft;
  checked: boolean;
  result?: FillResult;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const over = field.maxLength ? draft.value.length > field.maxLength : false;
  return (
    <div className="row draft">
      <input
        type="checkbox"
        aria-label={`Fill ${field.label}`}
        checked={checked}
        disabled={!draft.value.trim() || over}
        onChange={onToggle}
      />
      <div className="row-body">
        <span className="row-label">{field.label}</span>
        {field.options.length > 0 ? (
          <select value={draft.value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <textarea
            rows={field.kind === "textarea" ? 6 : 2}
            value={draft.value}
            placeholder="No draft. Write your own answer."
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {field.maxLength && (
          <span className={over ? "row-error" : "row-note"}>
            {draft.value.length} / {field.maxLength} characters
          </span>
        )}
        {draft.sources.length > 0 && (
          <span className="row-note">Based on: {sourceLabels(draft.sources)}</span>
        )}
        {draft.unsupported && (
          <span className="row-warn">
            This doesn't cite anything from your profile. Check it carefully.
          </span>
        )}
        {draft.note && <span className="row-note">{draft.note}</span>}
        {result && !result.ok && <span className="row-error">{result.reason}</span>}
      </div>
    </div>
  );
}

/** Holds the panel's state and runs scan, fit check, drafting and fill. */
function App() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<FillResult[] | null>(null);
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [jobRecord, setJobRecord] = useState<JobRecord | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [documents, setDocuments] = useState<JobDocuments | null>(null);
  const [creatingDocs, setCreatingDocs] = useState(false);
  const jobUrl = useRef<string | null>(null);

  const scan = useCallback(async () => {
    setResults(null);
    setError(null);

    let data;
    try {
      const [profile, answers, resume, status] = await Promise.all([
        getJson<Profile>("/profile"),
        getJson<Answer[]>("/answers"),
        getJson<ResumeFileMeta | null>("/resume/meta"),
        getJson<Status>("/status"),
      ]);
      data = { profile, answers, resumeName: resume?.name ?? null };
      setAiReady(status.aiConfigured);
    } catch {
      setView({ state: "server_down" });
      return;
    }

    const reply = await sendToPage<ScanResponse>({ type: "scan" });
    if (reply.kind !== "ok") {
      setView({ state: "no_form", reachable: reply.kind === "no_form" });
      return;
    }
    const page = reply.data;

    // The saved job and its documents decide which files get attached, so
    // they're loaded before matching.
    const url = page.job?.url ?? null;
    let record: JobRecord | null = null;
    let docs: JobDocuments | null = null;
    if (url) {
      record = await getJson<JobRecord | null>(
        `/jobs/lookup?url=${encodeURIComponent(url)}`,
      ).catch(() => null);
      if (record) {
        docs = await getJson<JobDocuments>(`/jobs/${record.id}/documents`).catch(() => null);
      }
    }
    const tailored = {
      resume: docs?.resume?.status === "approved" ? "Tailored resume (approved)" : null,
      coverLetter:
        docs?.coverLetter?.status === "approved" ? "Tailored cover letter (approved)" : null,
    };

    const rows = page.fields.map((field) => ({
      field,
      decision: matchField(field, { ...data, tailored }),
    }));
    setView({ state: "ready", site: page.site, rows, job: page.job });
    setSelected(
      new Set(
        rows
          .filter((row) => row.decision.status === "ready")
          .map((row) => row.field.key),
      ),
    );

    // Answer drafts belong to one job; keep them across rescans of it.
    if (url !== jobUrl.current) {
      jobUrl.current = url;
      setDrafts({});
    }
    setJobRecord(record);
    setDocuments(docs);
  }, []);

  useEffect(() => {
    void scan();
    const rescan = () => void scan();
    const onUpdated = (_id: number, info: { status?: string }) => {
      if (info.status === "complete") rescan();
    };
    // A multi-step form moved to a new step in the tab being shown.
    const onPageChanged = async (
      message: { type?: string },
      sender: chrome.runtime.MessageSender,
    ) => {
      if (message.type !== "page-changed") return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (sender.tab?.id === tab?.id) rescan();
    };
    chrome.tabs.onActivated.addListener(rescan);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.runtime.onMessage.addListener(onPageChanged);
    return () => {
      chrome.tabs.onActivated.removeListener(rescan);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.runtime.onMessage.removeListener(onPageChanged);
    };
  }, [scan]);

  async function analyze(refresh: boolean) {
    if (view.state !== "ready" || !view.job) return;
    setAnalyzing(true);
    setError(null);
    try {
      setJobRecord(
        await postJson<JobRecord>(
          `/jobs/analyze${refresh ? "?refresh=1" : ""}`,
          view.job,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  /** The saved job for this page, saving it first (no AI) if needed. */
  async function ensureJob(): Promise<JobRecord | null> {
    if (jobRecord) return jobRecord;
    if (view.state !== "ready" || !view.job) return null;
    const record = await postJson<JobRecord>("/jobs/analyze?save_only=1", view.job);
    setJobRecord(record);
    return record;
  }

  /** Asks the AI for whichever of the two documents doesn't exist yet. */
  async function createDocuments() {
    setCreatingDocs(true);
    setError(null);
    try {
      const record = await ensureJob();
      if (!record) return;
      let docs = documents;
      if (!docs?.resume) {
        docs = await postJson<JobDocuments>(`/jobs/${record.id}/documents/resume/generate`, {});
      }
      if (!docs?.coverLetter) {
        docs = await postJson<JobDocuments>(`/jobs/${record.id}/documents/cover_letter/generate`, {});
      }
      setDocuments(docs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingDocs(false);
    }
  }

  /** Opens this job's documents in the Draftline web app to edit and approve. */
  function openReview() {
    if (jobRecord) {
      void chrome.tabs.create({ url: `${WEB_APP}/#/applications/${jobRecord.id}` });
    }
  }

  async function draftAll() {
    if (view.state !== "ready" || !view.job) return;
    setDrafting(true);
    setError(null);
    try {
      // Drafting needs the job saved, but not a fit check.
      const record =
        jobRecord ??
        (await postJson<JobRecord>("/jobs/analyze?save_only=1", view.job));
      setJobRecord(record);
      const questions: QuestionInput[] = view.rows
        .filter((row) => canDraft(row) && !drafts[row.field.key])
        .map(({ field }) => ({
          key: field.key,
          label: field.label,
          // Yes/No buttons are offered to the AI as a radio question.
          kind: (field.kind === "buttons" ? "radio" : field.kind) as QuestionInput["kind"],
          options: field.options,
          maxLength: field.maxLength ?? null,
        }));
      const { answers } = await postJson<{ answers: AnswerDraft[] }>(
        `/jobs/${record.id}/answers`,
        { questions },
      );
      setDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          answers.map((answer) => [answer.key, { ...answer, value: answer.answer }]),
        ),
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function fill() {
    if (view.state !== "ready") return;
    setFilling(true);
    setError(null);
    try {
      const fields = view.rows.flatMap(({ field, decision }) => {
        if (!selected.has(field.key)) return [];
        const draft = drafts[field.key];
        if (draft) return draft.value.trim() ? [{ key: field.key, value: draft.value }] : [];
        return decision.status === "ready" || decision.status === "confirm"
          ? [{ key: field.key, value: decision.value }]
          : [];
      });
      // Fetch only the files this fill needs: the approved tailored resume
      // for this job if there is one, otherwise the default resume.
      const files: Record<string, ResumeFilePayload> = {};
      const uses = (value: string) => fields.some((f) => f.value === value);
      if (uses(RESUME_VALUE)) {
        files[RESUME_VALUE] =
          jobRecord && documents?.resume?.status === "approved"
            ? await getJson<ResumeFilePayload>(`/jobs/${jobRecord.id}/documents/resume/file`)
            : await getJson<ResumeFilePayload>("/resume/file");
      }
      if (uses(COVER_LETTER_VALUE) && jobRecord) {
        files[COVER_LETTER_VALUE] = await getJson<ResumeFilePayload>(
          `/jobs/${jobRecord.id}/documents/cover_letter/file`,
        );
      }
      const reply = await sendToPage<FillResponse>({
        type: "fill",
        fields,
        files,
      });
      if (reply.kind !== "ok") {
        throw new Error("Lost contact with the page. Reload it.");
      }
      setResults(reply.data.results);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFilling(false);
    }
  }

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function editDraft(key: string, value: string) {
    setDrafts((current) => ({ ...current, [key]: { ...current[key]!, value } }));
    // An emptied or over-long answer can't stay ticked.
    const limit =
      view.state === "ready"
        ? view.rows.find((r) => r.field.key === key)?.field.maxLength
        : undefined;
    if (!value.trim() || (limit && value.length > limit)) {
      setSelected((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  if (view.state === "loading") return <p className="muted pad">Reading…</p>;

  if (view.state === "server_down") {
    return (
      <div className="pad">
        <h1>Draftline isn't running</h1>
        <p className="muted">Run pnpm dev in the project folder, then retry.</p>
        <button className="primary" onClick={() => void scan()}>
          Retry
        </button>
      </div>
    );
  }

  if (view.state === "no_form") {
    return (
      <div className="pad">
        <h1>No application form found</h1>
        <p className="muted">
          {view.reachable
            ? "Draftline is running on this page but can't see the form. If it's behind an Apply button, open it, then check again."
            : "Draftline isn't running on this page. It works on Greenhouse, Lever, Ashby, Workday and LinkedIn Easy Apply. If this is one, reload the page once, then check again."}
        </p>
        <button className="ghost" onClick={() => void scan()}>
          Check again
        </button>
      </div>
    );
  }

  const fillable = view.rows.filter(
    (r) =>
      !drafts[r.field.key] &&
      (r.decision.status === "ready" || r.decision.status === "confirm"),
  );
  const drafted = view.rows.filter((r) => drafts[r.field.key]);
  const manual = view.rows.filter(
    (r) => r.decision.status === "needs_you" && !drafts[r.field.key],
  );
  const draftable = manual.filter(canDraft);
  const skipped = view.rows.filter((r) => r.decision.status === "skip").length;
  const resultFor = (key: string) => results?.find((r) => r.key === key);
  const filledCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <div className="pad">
      <header className="head">
        <h1>{view.site} application</h1>
        <button className="ghost" onClick={() => void scan()}>
          Rescan
        </button>
      </header>

      {view.job ? (
        <JobCard
          job={view.job}
          record={jobRecord}
          aiReady={aiReady}
          analyzing={analyzing}
          onAnalyze={(refresh) => void analyze(refresh)}
        />
      ) : (
        <p className="row-note">
          Draftline couldn't read the job description on this page, so AI
          features are off here.
        </p>
      )}

      {view.job && (aiReady || documents?.resume || documents?.coverLetter) && (
        <DocumentsCard
          documents={documents}
          aiReady={aiReady}
          creating={creatingDocs}
          onCreate={() => void createDocuments()}
          onReview={openReview}
        />
      )}

      {results && (
        <p className="banner" role="status">
          Filled {filledCount} of {results.length}. Check the form on the page.
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {fillable.length > 0 && (
        <section>
          <h2>Ready to fill</h2>
          {fillable.map(({ field, decision }) => {
            if (decision.status !== "ready" && decision.status !== "confirm") {
              return null;
            }
            const result = resultFor(field.key);
            return (
              <label className="row" key={field.key}>
                <input
                  type="checkbox"
                  checked={selected.has(field.key)}
                  onChange={() => toggle(field.key)}
                />
                <span className="row-body">
                  <span className="row-label">{field.label}</span>
                  <span className="row-value">
                    {decision.value === RESUME_VALUE
                      ? decision.source
                      : decision.value}
                  </span>
                  {decision.note && (
                    <span className="row-note">{decision.note}</span>
                  )}
                  {result && !result.ok && (
                    <span className="row-error">{result.reason}</span>
                  )}
                </span>
              </label>
            );
          })}
        </section>
      )}

      {drafted.length > 0 && (
        <section>
          <h2>AI drafts ({drafted.length})</h2>
          <p className="row-note">
            Read and edit each one, then tick the ones you want filled.
          </p>
          {drafted.map(({ field }) => (
            <DraftRow
              key={field.key}
              field={field}
              draft={drafts[field.key]!}
              checked={selected.has(field.key)}
              result={resultFor(field.key)}
              onToggle={() => toggle(field.key)}
              onChange={(value) => editDraft(field.key, value)}
            />
          ))}
        </section>
      )}

      {manual.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Needs you ({manual.length})</h2>
            {aiReady && view.job && draftable.length > 0 && (
              <button
                className="ghost small"
                disabled={drafting}
                onClick={() => void draftAll()}
              >
                {drafting ? "Drafting…" : `Draft ${draftable.length} with AI`}
              </button>
            )}
          </div>
          {manual.map(({ field, decision }) => (
            <div className="row manual" key={field.key}>
              <span className="row-body">
                <span className="row-label">
                  {field.label}
                  {field.required && <span className="req"> required</span>}
                </span>
                {decision.status === "needs_you" && (
                  <span className="row-note">{decision.reason}</span>
                )}
              </span>
            </div>
          ))}
        </section>
      )}

      {skipped > 0 && <p className="muted">{skipped} already filled.</p>}

      <footer className="foot">
        <button
          className="primary"
          disabled={filling || selected.size === 0}
          onClick={() => void fill()}
        >
          {filling
            ? "Filling…"
            : `Fill ${selected.size} ${selected.size === 1 ? "field" : "fields"}`}
        </button>
        <p className="muted">
          Draftline never submits. Review the form and submit it yourself.
        </p>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
