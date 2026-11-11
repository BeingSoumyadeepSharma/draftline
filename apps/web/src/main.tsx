import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AiSettingsPage } from "./AiSettingsPage";
import { AnswersPage } from "./AnswersPage";
import { ProfilePage } from "./ProfilePage";
import "./styles.css";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "answers", label: "Saved answers" },
  { id: "ai", label: "AI settings" },
] as const;

function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("profile");
  const [aiVersion, setAiVersion] = useState(0);

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
      {/* Both pages stay mounted so switching tabs never loses unsaved edits. */}
      <main hidden={tab !== "profile"}>
        <ProfilePage aiVersion={aiVersion} />
      </main>
      <main hidden={tab !== "answers"}>
        <AnswersPage />
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
