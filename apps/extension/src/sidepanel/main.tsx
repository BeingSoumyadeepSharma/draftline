import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Answer,
  Profile,
  ResumeFileMeta,
  ResumeFilePayload,
} from "@draftline/shared";
import { matchField, RESUME_VALUE, type Decision } from "../match";
import type {
  ContentMessage,
  FieldDescriptor,
  FillResponse,
  FillResult,
  ScanResponse,
} from "../types";
import "./sidepanel.css";

const API = "http://127.0.0.1:8787/api";

type Row = { field: FieldDescriptor; decision: Decision };
type View =
  | { state: "loading" }
  | { state: "server_down" }
  | { state: "no_form"; reachable: boolean }
  | { state: "ready"; site: string; rows: Row[] };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
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

function App() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<FillResult[] | null>(null);
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setResults(null);
    setError(null);

    let data;
    try {
      const [profile, answers, resume] = await Promise.all([
        getJson<Profile>("/profile"),
        getJson<Answer[]>("/answers"),
        getJson<ResumeFileMeta | null>("/resume/meta"),
      ]);
      data = { profile, answers, resumeName: resume?.name ?? null };
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

    const rows = page.fields.map((field) => ({
      field,
      decision: matchField(field, data),
    }));
    setView({ state: "ready", site: page.site, rows });
    setSelected(
      new Set(
        rows
          .filter((row) => row.decision.status === "ready")
          .map((row) => row.field.key),
      ),
    );
  }, []);

  useEffect(() => {
    void scan();
    const rescan = () => void scan();
    const onUpdated = (_id: number, info: { status?: string }) => {
      if (info.status === "complete") rescan();
    };
    chrome.tabs.onActivated.addListener(rescan);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(rescan);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [scan]);

  async function fill() {
    if (view.state !== "ready") return;
    setFilling(true);
    setError(null);
    try {
      const fields = view.rows.flatMap(({ field, decision }) =>
        selected.has(field.key) &&
        (decision.status === "ready" || decision.status === "confirm")
          ? [{ key: field.key, value: decision.value }]
          : [],
      );
      const resume = fields.some((f) => f.value === RESUME_VALUE)
        ? await getJson<ResumeFilePayload>("/resume/file")
        : null;
      const reply = await sendToPage<FillResponse>({
        type: "fill",
        fields,
        resume,
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
            : "Draftline isn't running on this page. It works on Greenhouse and Lever sites. If this is one, reload the page once, then check again."}
        </p>
        <button className="ghost" onClick={() => void scan()}>
          Check again
        </button>
      </div>
    );
  }

  const fillable = view.rows.filter(
    (r) => r.decision.status === "ready" || r.decision.status === "confirm",
  );
  const manual = view.rows.filter((r) => r.decision.status === "needs_you");
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

      {manual.length > 0 && (
        <section>
          <h2>Needs you ({manual.length})</h2>
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
          {filling ? "Filling…" : `Fill ${selected.size} fields`}
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
