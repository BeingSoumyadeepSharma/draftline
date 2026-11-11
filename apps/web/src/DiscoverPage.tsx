/**
 * The Discover tab: new jobs from company job boards the user chooses,
 * filtered by their preferences and ranked by fit.
 *
 * The server does the work (see apps/server/src/discovery.ts): it checks each
 * board once a day while running, or when "Refresh now" is clicked. This page
 * manages the boards and preferences and shows the shortlist. "Save to
 * Applications" copies a job into the tracker; "Dismiss" hides it for good.
 */
import { useCallback, useEffect, useState } from "react";
import type {
  DiscoveredJob,
  DiscoveryPreferences,
  DiscoveryState,
} from "@draftline/shared";
import { api } from "./api";

const DAY_MS = 24 * 60 * 60 * 1000;

const SITE_NAMES = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" } as const;

const parseTerms = (text: string) =>
  text
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** A comma-separated list of words, kept as typed until it's saved. */
function TermsField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} placeholder={hint} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** Keywords, exclusions, locations and the AI switch. */
function PreferencesCard({
  preferences,
  onSave,
}: {
  preferences: DiscoveryPreferences;
  onSave: (preferences: DiscoveryPreferences) => Promise<void>;
}) {
  const [keywords, setKeywords] = useState(preferences.keywords.join(", "));
  const [exclude, setExclude] = useState(preferences.exclude.join(", "));
  const [locations, setLocations] = useState(preferences.locations.join(", "));
  const [useAi, setUseAi] = useState(preferences.useAi);
  const [saved, setSaved] = useState(false);

  const draft: DiscoveryPreferences = {
    keywords: parseTerms(keywords),
    exclude: parseTerms(exclude),
    locations: parseTerms(locations),
    useAi,
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(preferences);

  return (
    <section className="card">
      <div className="card-head">
        <h2>What to look for</h2>
      </div>
      <p className="muted note">
        Separate words with commas. Empty boxes don't filter anything. Changes
        apply from the next refresh.
      </p>
      <div className="grid">
        <TermsField
          label="Job title contains any of"
          hint="engineer, developer"
          value={keywords}
          onChange={(text) => {
            setKeywords(text);
            setSaved(false);
          }}
        />
        <TermsField
          label="Job title contains none of"
          hint="intern, manager"
          value={exclude}
          onChange={(text) => {
            setExclude(text);
            setSaved(false);
          }}
        />
        <TermsField
          label="Location contains any of"
          hint="Milan, Italy, Remote"
          value={locations}
          onChange={(text) => {
            setLocations(text);
            setSaved(false);
          }}
        />
        <label className="choice wide">
          <input
            type="checkbox"
            checked={useAi}
            onChange={(e) => {
              setUseAi(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            Rank the most promising new jobs with AI, up to 15 per refresh in a
            single request. Without it, jobs are ranked by how many of your
            profile's skills they mention.
          </span>
        </label>
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={!dirty}
          onClick={() => void onSave(draft).then(() => setSaved(true))}
        >
          Save preferences
        </button>
        {saved && !dirty && (
          <span className="status" role="status">
            Saved
          </span>
        )}
      </div>
    </section>
  );
}

/** One job in the shortlist with its score and actions. */
function JobCard({
  job,
  onSave,
  onDismiss,
}: {
  job: DiscoveredJob;
  onSave: () => void;
  onDismiss: () => void;
}) {
  const isNew = Date.now() - Date.parse(job.firstSeenAt) < DAY_MS;
  return (
    <article className="card found-job">
      <div className="card-head">
        <div>
          <h2>
            <a href={job.url} target="_blank" rel="noreferrer">
              {job.title}
            </a>
            {isNew && <span className="pill new-pill">New</span>}
          </h2>
          <p className="muted">
            {[job.company, job.location, job.postedAt ? `posted ${formatDate(job.postedAt)}` : ""]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {job.aiScore !== null ? (
          <span className="fit" title="AI estimate from your profile">
            {job.aiScore}/100 fit
          </span>
        ) : (
          <span className="fit muted" title="Share of your profile's skills the posting mentions">
            {job.ruleScore}/100 skills
          </span>
        )}
      </div>
      {job.aiReason && <p className="note">{job.aiReason}</p>}
      {job.matchedSkills.length > 0 && (
        <p className="muted note">Mentions: {job.matchedSkills.join(", ")}</p>
      )}
      <div className="actions">
        {job.status === "saved" && job.jobId ? (
          <a className="ghost" href={`#/applications/${job.jobId}`}>
            Saved. Open in Applications
          </a>
        ) : (
          <>
            <button className="primary" onClick={onSave}>
              Save to Applications
            </button>
            <button className="ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function DiscoverPage({ active }: { active: boolean }) {
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [boardUrl, setBoardUrl] = useState("");
  const [busy, setBusy] = useState<"adding" | "refreshing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.discovery().then(setState, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  async function run(step: () => Promise<DiscoveryState>, kind?: "adding" | "refreshing") {
    setError(null);
    if (kind) setBusy(kind);
    try {
      setState(await step());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!state) {
    return error ? <p className="banner error">{error}</p> : <p className="muted">Loading…</p>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Discover jobs</h1>
          <p className="muted">
            New jobs from company job boards you choose, ranked by how well they
            fit your profile. Checked once a day while Draftline is running.
          </p>
        </div>
        <div className="actions">
          <button
            className="primary"
            disabled={busy !== null || state.sources.length === 0}
            onClick={() => void run(api.refreshDiscovery, "refreshing")}
          >
            {busy === "refreshing" ? "Checking boards…" : "Refresh now"}
          </button>
        </div>
      </div>

      {state.lastRunAt && (
        <p className="muted note">
          Last checked {new Date(state.lastRunAt).toLocaleString()}. {state.lastRunSummary}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Job boards</h2>
        </div>
        <p className="muted note">
          Paste a company's Greenhouse, Lever or Ashby job board address, like
          jobs.lever.co/company. Draftline reads their public job listings; it
          sends nothing about you.
        </p>
        <form
          className="add-board"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.addDiscoverySource(boardUrl), "adding").then(
              (ok) => ok && setBoardUrl(""),
            );
          }}
        >
          <input
            aria-label="Job board address"
            value={boardUrl}
            placeholder="https://jobs.ashbyhq.com/company"
            onChange={(e) => setBoardUrl(e.target.value)}
          />
          <button className="primary" disabled={!boardUrl.trim() || busy !== null}>
            {busy === "adding" ? "Adding…" : "Add"}
          </button>
        </form>
        {state.sources.map((source) => (
          <div className="board-row" key={source.id}>
            <div>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
              <span className="muted small-text">
                {" "}
                · {SITE_NAMES[source.kind]} · {source.jobCount} matching
                {source.lastFetchedAt ? ` · checked ${formatDate(source.lastFetchedAt)}` : ""}
              </span>
              {source.lastError && <div className="row-error small-text">{source.lastError}</div>}
            </div>
            <button
              className="ghost danger"
              onClick={() => void run(() => api.removeDiscoverySource(source.id))}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <PreferencesCard
        key={JSON.stringify(state.preferences)}
        preferences={state.preferences}
        onSave={async (preferences) => {
          await run(() => api.saveDiscoveryPreferences(preferences));
        }}
      />

      <h2 className="shortlist-title">Shortlist ({state.jobs.length})</h2>
      {state.jobs.length === 0 && (
        <p className="muted">
          {state.sources.length === 0
            ? "Add a job board to start."
            : "No matching jobs right now. Try wider preferences or more boards."}
        </p>
      )}
      {state.jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onSave={() =>
            void run(async () => (await api.saveDiscoveredJob(job.id)).state)
          }
          onDismiss={() => void run(() => api.dismissDiscoveredJob(job.id))}
        />
      ))}
    </>
  );
}
