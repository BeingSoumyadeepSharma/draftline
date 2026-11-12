/**
 * The Discover tab: a live tracker of new jobs, found two ways:
 *   - by position: searches like "Backend Engineer, Milan" across many
 *     companies, through job search sources (apps/server/src/search.ts)
 *   - by company: the Greenhouse, Lever or Ashby boards of chosen companies
 * Both feed one list, filtered by the user's preferences and ranked by fit.
 *
 * The server does the work (see apps/server/src/discovery.ts): it checks the
 * boards on the chosen interval (every 15 minutes by default) while running,
 * or when "Refresh now" is clicked. The extension shows a desktop notification
 * when a new matching job appears. This page manages boards and preferences
 * and shows the jobs two ways: "Best fit" (ranked) and "Newest" (by posting
 * time). It reloads every minute while open, and marks jobs seen when viewed.
 * "Save to Applications" copies a job into the tracker; "Dismiss" hides it.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ADZUNA_COUNTRIES,
  REFRESH_CHOICES,
  type SearchProvidersInput,
  type SearchProvidersView,
  type DiscoveredJob,
  type DiscoveryPreferences,
  type DiscoveryState,
} from "@draftline/shared";
import { api } from "./api";

const RELOAD_MS = 60_000;

/** Public boards that work, one per site, offered while no board is added. */
const EXAMPLE_BOARDS = [
  { name: "GitLab (Greenhouse)", url: "https://job-boards.greenhouse.io/gitlab" },
  { name: "Palantir (Lever)", url: "https://jobs.lever.co/palantir" },
  { name: "Notion (Ashby)", url: "https://jobs.ashbyhq.com/notion" },
];

const INTERVAL_LABELS: Record<(typeof REFRESH_CHOICES)[number], string> = {
  5: "Every 5 minutes",
  15: "Every 15 minutes",
  30: "Every 30 minutes",
  60: "Every hour",
  1440: "Once a day",
};

/** "just now", "12 min ago", "3 h ago", or a date for anything older than two days. */
function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** When the job went up: the board's posting time if it gives one, else when Draftline found it. */
const postedTime = (job: DiscoveredJob) => job.postedAt ?? job.firstSeenAt;

const SITE_NAMES = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" } as const;

const parseTerms = (text: string) =>
  text
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);

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
  const [refreshMinutes, setRefreshMinutes] = useState(preferences.refreshMinutes);
  const [saved, setSaved] = useState(false);

  const draft: DiscoveryPreferences = {
    keywords: parseTerms(keywords),
    exclude: parseTerms(exclude),
    locations: parseTerms(locations),
    useAi,
    refreshMinutes,
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
          hint="e.g. engineer, developer"
          value={keywords}
          onChange={(text) => {
            setKeywords(text);
            setSaved(false);
          }}
        />
        <TermsField
          label="Job title contains none of"
          hint="e.g. intern, manager"
          value={exclude}
          onChange={(text) => {
            setExclude(text);
            setSaved(false);
          }}
        />
        <TermsField
          label="Location contains any of"
          hint="e.g. Milan, Italy, Remote"
          value={locations}
          onChange={(text) => {
            setLocations(text);
            setSaved(false);
          }}
        />
        <label className="field">
          <span>Check the boards</span>
          <select
            value={refreshMinutes}
            onChange={(e) => {
              setRefreshMinutes(Number(e.target.value));
              setSaved(false);
            }}
          >
            {REFRESH_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {INTERVAL_LABELS[minutes]}
              </option>
            ))}
          </select>
        </label>
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

/** Adds and lists searches by role, across companies. */
function SearchCard({
  state,
  busy,
  onAdd,
  onRemove,
}: {
  state: DiscoveryState;
  busy: boolean;
  onAdd: (position: string, location: string) => Promise<boolean>;
  onRemove: (id: string) => void;
}) {
  const [position, setPosition] = useState("");
  const [location, setLocation] = useState("");
  return (
    <section className="card">
      <div className="card-head">
        <h2>Search by position</h2>
      </div>
      <p className="muted note">
        The role you're applying for, and optionally where. Draftline searches
        across companies using the sources below and keeps jobs whose title
        matches the role.
      </p>
      <form
        className="add-search"
        onSubmit={(e) => {
          e.preventDefault();
          void onAdd(position, location).then((ok) => {
            if (ok) {
              setPosition("");
              setLocation("");
            }
          });
        }}
      >
        <input
          aria-label="Position"
          value={position}
          placeholder="e.g. Backend Engineer"
          onChange={(e) => setPosition(e.target.value)}
        />
        <input
          aria-label="Location (optional)"
          value={location}
          placeholder="e.g. Milan, or Remote (optional)"
          onChange={(e) => setLocation(e.target.value)}
        />
        <button className="primary" disabled={position.trim().length < 2 || busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {state.searches.map((search) => (
        <div className="board-row" key={search.id}>
          <div>
            <strong>{search.position}</strong>
            <span className="muted small-text">
              {" "}
              · {search.location || "anywhere"} · {search.jobCount} matching
              {search.lastRunAt ? ` · checked ${timeAgo(search.lastRunAt)}` : ""}
            </span>
            {search.lastError && <div className="row-error small-text">{search.lastError}</div>}
          </div>
          <button className="ghost danger" onClick={() => onRemove(search.id)}>
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

/** Which search sources to use, with the keys some need. */
function SourcesCard({
  providers,
  onSave,
}: {
  providers: SearchProvidersView;
  onSave: (input: SearchProvidersInput) => Promise<boolean>;
}) {
  const [remotive, setRemotive] = useState(providers.remotive);
  const [arbeitnow, setArbeitnow] = useState(providers.arbeitnow);
  const [adzunaOn, setAdzunaOn] = useState(providers.adzuna.enabled);
  const [country, setCountry] = useState(providers.adzuna.country ?? "");
  const [appId, setAppId] = useState("");
  const [appKey, setAppKey] = useState("");
  const [braveOn, setBraveOn] = useState(providers.brave.enabled);
  const [braveKey, setBraveKey] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = () => setSaved(false);

  // A key saved here wins over one in the server's .env file.
  const keyNote = (keyFrom: SearchProvidersView["brave"]["keyFrom"]) =>
    keyFrom === "saved"
      ? "Saved. Leave blank to keep it."
      : keyFrom === "env"
        ? "Using the key from .env. Enter one here to use it instead."
        : "";

  return (
    <section className="card">
      <details>
        <summary className="sources-summary">
          <h2>Search sources</h2>
          <span className="muted small-text">
            {[
              providers.remotive && "Remotive",
              providers.arbeitnow && "Arbeitnow",
              providers.adzuna.enabled && providers.adzuna.hasKey && "Adzuna",
              providers.brave.enabled && providers.brave.hasKey && "Web search",
            ]
              .filter(Boolean)
              .join(", ") || "None on"}
          </span>
        </summary>
        <p className="muted note">
          LinkedIn and Indeed don't offer a public search and forbid scraping,
          so Draftline uses these instead. Each is checked no more often than it
          allows.
        </p>

        <label className="choice">
          <input type="checkbox" checked={remotive} onChange={(e) => { setRemotive(e.target.checked); changed(); }} />
          <span>
            <strong>Remotive</strong>: remote jobs worldwide. No key needed.
            Checked up to 4 times a day, and its jobs appear 24 hours after posting.
          </span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={arbeitnow} onChange={(e) => { setArbeitnow(e.target.checked); changed(); }} />
          <span>
            <strong>Arbeitnow</strong>: jobs in Europe, mostly Germany. No key
            needed. Checked hourly.
          </span>
        </label>

        <label className="choice">
          <input type="checkbox" checked={adzunaOn} onChange={(e) => { setAdzunaOn(e.target.checked); changed(); }} />
          <span>
            <strong>Adzuna</strong>: a job search engine for one country at a time,
            including Italy. Needs a free key from{" "}
            <a href="https://developer.adzuna.com/" target="_blank" rel="noreferrer">
              developer.adzuna.com
            </a>
            . Checked hourly.
          </span>
        </label>
        {adzunaOn && (
          <div className="grid source-keys">
            <label className="field">
              <span>Country</span>
              <select value={country} onChange={(e) => { setCountry(e.target.value); changed(); }}>
                <option value="">Choose…</option>
                {ADZUNA_COUNTRIES.map((code) => (
                  <option key={code} value={code}>
                    {code.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>App ID</span>
              <input value={appId} placeholder={keyNote(providers.adzuna.keyFrom)} onChange={(e) => { setAppId(e.target.value); changed(); }} />
            </label>
            <label className="field wide">
              <span>App key</span>
              <input type="password" autoComplete="off" value={appKey} placeholder={keyNote(providers.adzuna.keyFrom)} onChange={(e) => { setAppKey(e.target.value); changed(); }} />
            </label>
          </div>
        )}

        <label className="choice">
          <input type="checkbox" checked={braveOn} onChange={(e) => { setBraveOn(e.target.checked); changed(); }} />
          <span>
            <strong>Web search</strong>: finds Greenhouse, Lever and Ashby postings
            at any company, which Draftline can fill in for you. Uses the Brave
            Search API; get a key at{" "}
            <a href="https://brave.com/search/api/" target="_blank" rel="noreferrer">
              brave.com/search/api
            </a>
            . Checked up to 4 times a day.
          </span>
        </label>
        {braveOn && (
          <div className="grid source-keys">
            <label className="field wide">
              <span>Brave Search API key</span>
              <input type="password" autoComplete="off" value={braveKey} placeholder={keyNote(providers.brave.keyFrom)} onChange={(e) => { setBraveKey(e.target.value); changed(); }} />
            </label>
          </div>
        )}

        <p className="muted note">
          Keys entered here are stored only in Draftline's database on this
          computer and take priority. Otherwise Draftline uses ADZUNA_APP_ID,
          ADZUNA_APP_KEY, ADZUNA_COUNTRY and BRAVE_SEARCH_API_KEY from the .env
          file, if set (restart Draftline after changing it).
        </p>
        <div className="actions">
          <button
            className="primary"
            onClick={() =>
              void onSave({
                remotive,
                arbeitnow,
                adzuna: {
                  enabled: adzunaOn,
                  country: (country || null) as SearchProvidersInput["adzuna"]["country"],
                  appId,
                  appKey,
                },
                brave: { enabled: braveOn, apiKey: braveKey },
              }).then((ok) => {
                if (ok) {
                  setAppId("");
                  setAppKey("");
                  setBraveKey("");
                  setSaved(true);
                }
              })
            }
          >
            Save sources
          </button>
          {saved && (
            <span className="status" role="status">
              Saved
            </span>
          )}
        </div>
      </details>
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
  // "New" means posted after the board was added and not yet seen here.
  const isNew = !job.baseline && job.seenAt === null;
  return (
    <article className={isNew ? "card found-job unseen" : "card found-job"}>
      <div className="card-head">
        <div>
          <h2>
            <a href={job.url} target="_blank" rel="noreferrer">
              {job.title}
            </a>
            {isNew && <span className="pill new-pill">New</span>}
          </h2>
          <p className="muted">
            {[
              job.company,
              job.location,
              `posted ${timeAgo(postedTime(job))}`,
              // Sources like Remotive ask to be named alongside their jobs.
              job.via ? `via ${job.via}` : "",
            ]
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
  const [busy, setBusy] = useState<"adding" | "refreshing" | "searching" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<"fit" | "newest">("newest");

  const load = useCallback(() => {
    return api.discovery().then(setState, (e: Error) => setError(e.message));
  }, []);

  // While the tab is open: load now, mark what's shown as seen (its "New"
  // labels stay until the next reload), and reload every minute.
  useEffect(() => {
    if (!active) return;
    void load().then(() => api.markDiscoverySeen().catch(() => {}));
    const timer = setInterval(() => {
      void load().then(() => api.markDiscoverySeen().catch(() => {}));
    }, RELOAD_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function run(
    step: () => Promise<DiscoveryState>,
    kind?: "adding" | "refreshing" | "searching",
  ) {
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
  const hasAnything = state.sources.length > 0 || state.searches.length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Discover jobs</h1>
          <p className="muted">
            New jobs for the positions you're applying for, across companies,
            and from company job boards you choose. Draftline checks while it's
            running, and the extension shows a desktop notification for each
            new match.
          </p>
        </div>
        {/* Nothing to refresh until there's a search or a board. */}
        {hasAnything && (
          <div className="actions">
            <button
              className="primary"
              disabled={busy !== null}
              onClick={() => void run(api.refreshDiscovery, "refreshing")}
            >
              {busy === "refreshing" ? "Checking boards…" : "Refresh now"}
            </button>
          </div>
        )}
      </div>

      {hasAnything && (
        <p className="muted note">
          {state.running
            ? "Checking now…"
            : [
                INTERVAL_LABELS[state.preferences.refreshMinutes as (typeof REFRESH_CHOICES)[number]] ??
                  "",
                state.lastRunAt ? `last checked ${timeAgo(state.lastRunAt)}` : "not checked yet",
                state.nextRunAt
                  ? `next check ${new Date(state.nextRunAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
          {state.lastRunSummary && !state.running ? `. ${state.lastRunSummary}` : ""}
        </p>
      )}
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {!hasAnything && (
        <section className="card start">
          <h2>Get started</h2>
          <ol className="steps">
            <li>
              <strong>Search by position:</strong> enter the role you're applying
              for, like "Backend Engineer", and optionally a place.
            </li>
            <li>
              <strong>Optionally, follow companies:</strong> add the job boards of
              companies you'd like to work for, or try one of the examples.
            </li>
            <li>
              <strong>Keep Draftline running.</strong> It checks on your schedule,
              and the Chrome extension notifies you as soon as a matching job is
              posted.
            </li>
          </ol>
          <p className="muted note">
            Jobs already listed when you add a search or a board appear here
            straight away. Notifications start with the next new posting.
          </p>
        </section>
      )}

      <SearchCard
        state={state}
        busy={busy === "searching"}
        onAdd={(position, location) => run(() => api.addSearch(position, location), "searching")}
        onRemove={(id) => void run(() => api.removeSearch(id))}
      />
      <SourcesCard
        key={JSON.stringify(state.providers)}
        providers={state.providers}
        onSave={(input) => run(() => api.saveSearchProviders(input))}
      />

      <section className="card">
        <div className="card-head">
          <h2>Follow companies</h2>
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
            placeholder="e.g. https://jobs.lever.co/company"
            onChange={(e) => setBoardUrl(e.target.value)}
          />
          <button className="primary" disabled={!boardUrl.trim() || busy !== null}>
            {busy === "adding" ? "Adding…" : "Add"}
          </button>
        </form>
        {state.sources.length === 0 && (
          <div className="examples">
            <span className="muted small-text">Examples to try:</span>
            {EXAMPLE_BOARDS.map((example) => (
              <button
                key={example.url}
                className="chip"
                disabled={busy !== null}
                onClick={() => void run(() => api.addDiscoverySource(example.url), "adding")}
              >
                {example.name}
              </button>
            ))}
          </div>
        )}
        {state.sources.map((source) => (
          <div className="board-row" key={source.id}>
            <div>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
              <span className="muted small-text">
                {" "}
                · {SITE_NAMES[source.kind]} · {source.jobCount} matching
                {source.lastFetchedAt ? ` · checked ${timeAgo(source.lastFetchedAt)}` : ""}
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

      <div className="shortlist-head">
        <h2 className="shortlist-title">
          Jobs ({state.jobs.length}
          {state.unseenCount > 0 ? `, ${state.unseenCount} new` : ""})
        </h2>
        <div className="filters" role="group" aria-label="Order">
          <button className="chip" aria-pressed={order === "newest"} onClick={() => setOrder("newest")}>
            Newest
          </button>
          <button className="chip" aria-pressed={order === "fit"} onClick={() => setOrder("fit")}>
            Best fit
          </button>
        </div>
      </div>
      {state.jobs.length === 0 && (
        <p className="muted">
          {!hasAnything
            ? "No jobs yet. Add a search or a job board above and matching jobs will appear here."
            : "No matching jobs right now. Try wider preferences or more boards."}
        </p>
      )}
      {(order === "newest"
        ? [...state.jobs].sort((a, b) => Date.parse(postedTime(b)) - Date.parse(postedTime(a)))
        : state.jobs
      ).map((job) => (
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
