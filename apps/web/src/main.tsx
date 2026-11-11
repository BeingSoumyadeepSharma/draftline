/**
 * Entry point of the web app (http://127.0.0.1:5173): a top bar with four tabs.
 *
 * All pages stay mounted and are hidden with the `hidden` attribute, so
 * switching tabs never loses unsaved edits.
 *
 * The address hash selects the tab, so the extension can open a job's
 * documents directly: #/applications/<job id>.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AiSettingsPage } from "./AiSettingsPage";
import { AnswersPage } from "./AnswersPage";
import { ApplicationsPage } from "./ApplicationsPage";
import { ProfilePage } from "./ProfilePage";
import "./styles.css";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "answers", label: "Saved answers" },
  { id: "applications", label: "Applications" },
  { id: "ai", label: "AI settings" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** "#/applications/abc" → { tab: "applications", jobId: "abc" }. */
function readHash(): { tab: TabId; jobId: string | null } {
  const [, tab, jobId] = window.location.hash.split("/");
  const known = TABS.find((t) => t.id === tab);
  return { tab: known?.id ?? "profile", jobId: jobId ? decodeURIComponent(jobId) : null };
}

function App() {
  const [route, setRoute] = useState(readHash);
  const [aiVersion, setAiVersion] = useState(0);
  const { tab } = route;

  useEffect(() => {
    const onHashChange = () => setRoute(readHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setTab = (id: TabId) => {
    window.location.hash = `/${id}`;
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Draftline</span>
        <nav className="tabs">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              className="tab"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {/* Pages stay mounted so switching tabs never loses unsaved edits. */}
      <main hidden={tab !== "profile"}>
        <ProfilePage aiVersion={aiVersion} />
      </main>
      <main hidden={tab !== "answers"}>
        <AnswersPage />
      </main>
      <main hidden={tab !== "applications"}>
        <ApplicationsPage
          active={tab === "applications"}
          jobId={route.jobId}
          aiVersion={aiVersion}
        />
      </main>
      <main hidden={tab !== "ai"}>
        <AiSettingsPage onSaved={() => setAiVersion((v) => v + 1)} />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
