/**
 * The Applications tab: every job opened with the extension. It is the
 * tracker (status, follow-up date, notes, timeline per job) and the place to
 * review and approve each job's tailored resume and cover letter.
 *
 * Jobs arrive here automatically: the side panel saves each job it reads, and
 * the extension marks a job Applied when it sees the site's confirmation page.
 *
 * Flow per document: "Create with AI" makes a draft, the user edits it here,
 * "Preview PDF" opens the PDF in a new tab, and "Approve" stores the PDF.
 * Only approved documents are attached by the extension. Editing an approved
 * document turns it back into a draft until it's approved again.
 *
 * The resume editor works on the profile's own bullets: you choose and order
 * them, but the wording always comes from your profile.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ACTIVE_STATUSES,
  APPLICATION_STATUS_LABELS,
  APPLICATION_STATUSES,
  type ApplicationStatus,
  type JobEvent,
  type TrackingUpdate,
} from "@draftline/shared";
import type {
  CoverLetterDocument,
  DocumentKind,
  JobDocuments,
  JobListItem,
  JobRecord,
  Profile,
  ResumeDocument,
  Source,
  TailoredResume,
} from "@draftline/shared";
import { api } from "./api";

const sourceLabels = (sources: Source[]) =>
  [...new Set(sources.map((s) => s.label))].join("; ");

/** Draft or approved, with what that means for the extension. */
function StatusPill({ status }: { status: "draft" | "approved" }) {
  return status === "approved" ? (
    <span className="pill approved">Approved. The extension attaches this.</span>
  ) : (
    <span className="pill">Draft. Approve it to use it.</span>
  );
}

const move = <T,>(list: T[], index: number, by: number): T[] => {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + by, 0, item!);
  return next;
};

/** Shared buttons: save edits, preview the PDF, approve, or start over with AI. */
function DocumentActions({
  dirty,
  busy,
  approved,
  onSave,
  onPreview,
  onApprove,
  onRegenerate,
}: {
  dirty: boolean;
  busy: boolean;
  approved: boolean;
  onSave: () => void;
  onPreview: () => void;
  onApprove: () => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="doc-actions">
      <button className="primary" disabled={busy || (approved && !dirty)} onClick={onApprove}>
        {approved && !dirty ? "Approved" : "Approve"}
      </button>
      <button className="ghost" disabled={busy} onClick={onPreview}>
        Preview PDF
      </button>
      <button className="ghost" disabled={busy || !dirty} onClick={onSave}>
        Save draft
      </button>
      <button className="ghost" disabled={busy} onClick={onRegenerate}>
        Start over with AI
      </button>
    </div>
  );
}

function ResumeEditor({
  jobId,
  profile,
  document,
  onSaved,
  onError,
}: {
  jobId: string;
  profile: Profile;
  document: ResumeDocument;
  onSaved: (documents: JobDocuments) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<TailoredResume>(document.content);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(document.content), [document]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(document.content);

  const bulletsFor = (roleId: string) =>
    draft.roles.find((r) => r.roleId === roleId)?.bulletIds ?? [];
  const setBullets = (roleId: string, bulletIds: string[]) =>
    setDraft((d) => ({
      ...d,
      roles: d.roles.map((r) => (r.roleId === roleId ? { ...r, bulletIds } : r)),
    }));
  const toggleIn = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  /** Saves edits first, if any, then runs the step. */
  async function run(step: () => Promise<JobDocuments | void>) {
    setBusy(true);
    try {
      if (dirty) onSaved(await api.saveResume(jobId, draft));
      const result = await step();
      if (result) onSaved(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Tailored resume</h2>
        <StatusPill status={dirty ? "draft" : document.status} />
      </div>
      {document.note && <p className="muted note">{document.note}</p>}

      <label className="field wide">
        <span>Summary, written for this job</span>
        <textarea
          rows={3}
          value={draft.summary}
          onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))}
        />
      </label>
      {document.sources.length > 0 && (
        <p className="muted note">Based on: {sourceLabels(document.sources)}</p>
      )}

      <h3 className="doc-heading">Experience</h3>
      <p className="muted note">
        Tick the bullets to show and use the arrows to order them. The wording
        comes from your profile.
      </p>
      {profile.experience.map((role) => {
        const chosen = bulletsFor(role.id);
        const others = role.bullets.filter((b) => !chosen.includes(b.id));
        return (
          <div className="doc-role" key={role.id}>
            <div className="doc-role-title">
              {[role.title, role.company].filter(Boolean).join(", ")}
            </div>
            {chosen.map((id, index) => {
              const bullet = role.bullets.find((b) => b.id === id);
              if (!bullet) return null;
              return (
                <div className="choice" key={id}>
                  <input
                    type="checkbox"
                    checked
                    aria-label={`Hide: ${bullet.text}`}
                    onChange={() => setBullets(role.id, toggleIn(chosen, id))}
                  />
                  <span>{bullet.text}</span>
                  <span className="order">
                    <button
                      className="ghost small"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => setBullets(role.id, move(chosen, index, -1))}
                    >
                      ↑
                    </button>
                    <button
                      className="ghost small"
                      aria-label="Move down"
                      disabled={index === chosen.length - 1}
                      onClick={() => setBullets(role.id, move(chosen, index, 1))}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              );
            })}
            {others.map((bullet) => (
              <div className="choice off" key={bullet.id}>
                <input
                  type="checkbox"
                  checked={false}
                  aria-label={`Show: ${bullet.text}`}
                  onChange={() => setBullets(role.id, [...chosen, bullet.id])}
                />
                <span>{bullet.text}</span>
              </div>
            ))}
          </div>
        );
      })}

      {profile.projects.length > 0 && (
        <>
          <h3 className="doc-heading">Projects</h3>
          {profile.projects.map((project) => (
            <label
              className={draft.projectIds.includes(project.id) ? "choice" : "choice off"}
              key={project.id}
            >
              <input
                type="checkbox"
                checked={draft.projectIds.includes(project.id)}
                onChange={() =>
                  setDraft((d) => ({ ...d, projectIds: toggleIn(d.projectIds, project.id) }))
                }
              />
              <span>{project.name}</span>
            </label>
          ))}
        </>
      )}

      {profile.skills.length > 0 && (
        <>
          <h3 className="doc-heading">Skills</h3>
          <p className="muted note">Selected skills appear in the order you pick them.</p>
          <div className="chips">
            {[...draft.skills, ...profile.skills.filter((s) => !draft.skills.includes(s))].map(
              (skill) => (
                <button
                  key={skill}
                  className="chip"
                  aria-pressed={draft.skills.includes(skill)}
                  onClick={() =>
                    setDraft((d) => ({ ...d, skills: toggleIn(d.skills, skill) }))
                  }
                >
                  {skill}
                </button>
              ),
            )}
          </div>
        </>
      )}
      <p className="muted note">Education and certifications are always included.</p>

      <DocumentActions
        dirty={dirty}
        busy={busy}
        approved={document.status === "approved"}
        onSave={() => void run(async () => {})}
        onPreview={() =>
          void run(async () => {
            window.open(api.previewUrl(jobId, "resume"), "_blank");
          })
        }
        onApprove={() => void run(() => api.approveDocument(jobId, "resume"))}
        onRegenerate={() => {
          if (window.confirm("Replace this resume with a new AI draft?")) {
            void run(() => api.generateDocument(jobId, "resume"));
          }
        }}
      />
    </section>
  );
}

function CoverLetterEditor({
  jobId,
  document,
  onSaved,
  onError,
}: {
  jobId: string;
  document: CoverLetterDocument;
  onSaved: (documents: JobDocuments) => void;
  onError: (message: string) => void;
}) {
  const [body, setBody] = useState(document.content.body);
  const [busy, setBusy] = useState(false);
  useEffect(() => setBody(document.content.body), [document]);
  const dirty = body !== document.content.body;

  async function run(step: () => Promise<JobDocuments | void>) {
    setBusy(true);
    try {
      if (dirty) onSaved(await api.saveCoverLetter(jobId, { body }));
      const result = await step();
      if (result) onSaved(result);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Cover letter</h2>
        <StatusPill status={dirty ? "draft" : document.status} />
      </div>
      {document.note && <p className="muted note">{document.note}</p>}
      <label className="field wide">
        <span>
          Letter body. The greeting, date and sign-off are added for you. Leave a
          blank line between paragraphs.
        </span>
        <textarea rows={16} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {document.sources.length > 0 && (
        <p className="muted note">Based on: {sourceLabels(document.sources)}</p>
      )}
      <DocumentActions
        dirty={dirty}
        busy={busy}
        approved={document.status === "approved"}
        onSave={() => void run(async () => {})}
        onPreview={() =>
          void run(async () => {
            window.open(api.previewUrl(jobId, "cover_letter"), "_blank");
          })
        }
        onApprove={() => void run(() => api.approveDocument(jobId, "cover_letter"))}
        onRegenerate={() => {
          if (window.confirm("Replace this letter with a new AI draft?")) {
            void run(() => api.generateDocument(jobId, "cover_letter"));
          }
        }}
      />
    </section>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** True when an active application's follow-up date has arrived. */
const isDue = (job: { status: ApplicationStatus; followUpAt: string | null }) =>
  ACTIVE_STATUSES.includes(job.status) && job.followUpAt !== null && job.followUpAt <= todayIso();

const formatDate = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** Status, follow-up date, notes and the job's timeline. */
function TrackingCard({
  job,
  events,
  onChange,
}: {
  job: JobRecord;
  events: JobEvent[];
  onChange: (change: TrackingUpdate) => void;
}) {
  const [notes, setNotes] = useState(job.notes);
  useEffect(() => setNotes(job.notes), [job.notes]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Tracking</h2>
        {isDue(job) && <span className="pill due">Follow-up due</span>}
      </div>
      <div className="grid">
        <label className="field">
          <span>Status</span>
          <select
            value={job.status}
            onChange={(e) => onChange({ status: e.target.value as ApplicationStatus })}
          >
            {APPLICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {APPLICATION_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Follow up on</span>
          <span className="date-row">
            <input
              type="date"
              value={job.followUpAt ?? ""}
              onChange={(e) => onChange({ followUpAt: e.target.value || null })}
            />
            {job.followUpAt && (
              <button className="ghost small" onClick={() => onChange({ followUpAt: null })}>
                Clear
              </button>
            )}
          </span>
        </label>
        <p className="muted note wide">
          {job.appliedAt ? `Applied on ${formatDate(job.appliedAt)}.` : "Not applied yet."}{" "}
          Marking a job Applied sets a follow-up a week later.
        </p>
        <label className="field wide">
          <span>Notes, such as who you spoke to. Saved when you leave the box.</span>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== job.notes && onChange({ notes })}
          />
        </label>
      </div>
      {events.length > 0 && (
        <>
          <h3 className="doc-heading">Timeline</h3>
          <ul className="timeline">
            {events.map((event, i) => (
              <li key={i}>
                <span className="muted small-text">{formatDate(event.at)}</span> {event.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Filter = "all" | "due" | ApplicationStatus;

/** Shown before a document exists: explains it and offers the AI draft. */
function CreateCard({
  title,
  text,
  aiReady,
  busy,
  onCreate,
}: {
  title: string;
  text: string;
  aiReady: boolean;
  busy: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="card import">
      <div>
        <h2>{title}</h2>
        <p className="muted">
          {aiReady ? text : "Set up a provider in AI settings to create this."}
        </p>
      </div>
      <button className="primary" disabled={!aiReady || busy} onClick={onCreate}>
        {busy ? "Writing…" : "Create with AI"}
      </button>
    </section>
  );
}

export function ApplicationsPage({
  active,
  jobId,
  aiVersion,
}: {
  active: boolean;
  jobId: string | null;
  aiVersion: number;
}) {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [documents, setDocuments] = useState<JobDocuments | null>(null);
  const [creating, setCreating] = useState<DocumentKind | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);

  // Reload whenever the tab is shown: the profile or jobs may have changed
  // in another tab or through the extension.
  const loadList = useCallback(() => {
    Promise.all([api.listJobs(), api.getProfile(), api.status()])
      .then(([list, loadedProfile, status]) => {
        setJobs(list);
        setProfile(loadedProfile);
        setAiReady(status.aiConfigured);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (active) loadList();
  }, [active, aiVersion, loadList]);

  useEffect(() => {
    setJob(null);
    setDocuments(null);
    setError(null);
    if (!jobId || !active) return;
    Promise.all([api.getJob(jobId), api.getDocuments(jobId), api.listEvents(jobId)])
      .then(([record, docs, timeline]) => {
        setJob(record);
        setDocuments(docs);
        setEvents(timeline);
      })
      .catch((e: Error) => setError(e.message));
  }, [jobId, active]);

  function updated(docs: JobDocuments) {
    setDocuments(docs);
    loadList();
  }

  async function track(change: TrackingUpdate) {
    if (!jobId) return;
    setError(null);
    try {
      setJob(await api.updateTracking(jobId, change));
      setEvents(await api.listEvents(jobId));
      loadList();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create(kind: DocumentKind) {
    if (!jobId) return;
    setCreating(kind);
    setError(null);
    try {
      updated(await api.generateDocument(jobId, kind));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(null);
    }
  }

  const statusText = (status: "draft" | "approved" | null) =>
    status === "approved" ? "approved" : status === "draft" ? "draft" : "none";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Applications</h1>
          <p className="muted">
            Every job you've opened with the Draftline extension: where each
            application stands, when to follow up, and its tailored documents.
          </p>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {jobs && jobs.length === 0 && (
        <section className="card">
          <p className="muted">
            No jobs yet. Open a Greenhouse or Lever application in Chrome and use
            the Draftline panel there; the job will appear here.
          </p>
        </section>
      )}

      {jobs && jobs.length > 0 && (
        <div className="filters" role="group" aria-label="Show">
          {(["all", "due", ...APPLICATION_STATUSES] as Filter[]).map((option) => {
            const count =
              option === "all"
                ? jobs.length
                : option === "due"
                  ? jobs.filter(isDue).length
                  : jobs.filter((j) => j.status === option).length;
            if (count === 0 && option !== "all" && option !== filter) return null;
            return (
              <button
                key={option}
                className={option === "due" ? "chip due" : "chip"}
                aria-pressed={filter === option}
                onClick={() => setFilter(option)}
              >
                {option === "all"
                  ? "All"
                  : option === "due"
                    ? "Follow-up due"
                    : APPLICATION_STATUS_LABELS[option]}{" "}
                {count}
              </button>
            );
          })}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="apps-layout">
          <nav className="job-list" aria-label="Jobs">
            {jobs
              .filter((item) =>
                filter === "all" ? true : filter === "due" ? isDue(item) : item.status === filter,
              )
              .map((item) => (
              <a
                key={item.id}
                href={`#/applications/${item.id}`}
                className="job-item"
                aria-current={item.id === jobId ? "page" : undefined}
              >
                <span className="job-item-title">{item.title || "Untitled job"}</span>
                <span className="small-text">
                  <span className={`status status-${item.status}`}>
                    {APPLICATION_STATUS_LABELS[item.status]}
                  </span>
                  {isDue(item) && <span className="due-text"> · follow up</span>}
                </span>
                <span className="muted small-text">
                  {[item.company, item.score !== null ? `fit ${item.score}` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="muted small-text">
                  Resume: {statusText(item.resumeStatus)} · Letter:{" "}
                  {statusText(item.coverLetterStatus)}
                </span>
              </a>
            ))}
          </nav>

          <div className="job-detail">
            {!jobId && <p className="muted">Choose a job to see its documents.</p>}
            {job && documents && profile && (
              <>
                <section className="card">
                  <div className="card-head">
                    <div>
                      <h2>{job.title || "Untitled job"}</h2>
                      <p className="muted">
                        {[job.company, job.location].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    {job.analysis && (
                      <span className="fit">{job.analysis.score}/100 fit</span>
                    )}
                  </div>
                  <a href={job.url} target="_blank" rel="noreferrer">
                    Open the job posting
                  </a>
                </section>

                <TrackingCard job={job} events={events} onChange={(change) => void track(change)} />

                {documents.resume ? (
                  <ResumeEditor
                    jobId={job.id}
                    profile={profile}
                    document={documents.resume}
                    onSaved={updated}
                    onError={setError}
                  />
                ) : (
                  <CreateCard
                    title="Tailored resume"
                    text="AI picks and orders your most relevant bullets and skills for this job, and writes a short summary. Your bullets are never reworded."
                    aiReady={aiReady}
                    busy={creating === "resume"}
                    onCreate={() => void create("resume")}
                  />
                )}

                {documents.coverLetter ? (
                  <CoverLetterEditor
                    jobId={job.id}
                    document={documents.coverLetter}
                    onSaved={updated}
                    onError={setError}
                  />
                ) : (
                  <CreateCard
                    title="Cover letter"
                    text="AI drafts a letter from your profile facts for you to edit."
                    aiReady={aiReady}
                    busy={creating === "cover_letter"}
                    onCreate={() => void create("cover_letter")}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
