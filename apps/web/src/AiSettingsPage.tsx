import { useEffect, useState } from "react";
import type { AiProvider, AiSettingsView } from "@draftline/shared";
import { api } from "./api";

type Preset = {
  id: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  keyOptional?: boolean;
};

const PRESETS: Preset[] = [
  { id: "claude", label: "Claude", provider: "anthropic", baseUrl: "" },
  { id: "openai", label: "OpenAI", provider: "openai_compatible", baseUrl: "https://api.openai.com/v1" },
  { id: "gemini", label: "Google Gemini", provider: "openai_compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "openrouter", label: "OpenRouter", provider: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", provider: "openai_compatible", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama (on this computer)", provider: "openai_compatible", baseUrl: "http://localhost:11434/v1", keyOptional: true },
  { id: "custom", label: "Other OpenAI-compatible API", provider: "openai_compatible", baseUrl: "", keyOptional: true },
];

const presetFor = (view: AiSettingsView): Preset => {
  if (view.provider === "anthropic") return PRESETS[0]!;
  return (
    PRESETS.find((p) => p.id !== "custom" && p.baseUrl === view.baseUrl) ??
    PRESETS[PRESETS.length - 1]!
  );
};

export function AiSettingsPage({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [presetId, setPresetId] = useState("claude");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(loaded: AiSettingsView) {
    setView(loaded);
    setPresetId(presetFor(loaded).id);
    setBaseUrl(loaded.baseUrl);
    setModel(loaded.model);
    setApiKey("");
  }

  useEffect(() => {
    api.getAiSettings().then(show, (e: Error) => setError(e.message));
  }, []);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const isClaude = preset.provider === "anthropic";
  const keyIsSaved =
    view?.hasApiKey === true &&
    view.provider === preset.provider &&
    (isClaude || view.baseUrl === baseUrl.trim().replace(/\/+$/, ""));

  function choosePreset(id: string) {
    const next = PRESETS.find((p) => p.id === id)!;
    setPresetId(id);
    setBaseUrl(next.baseUrl);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      show(
        await api.saveAiSettings({
          provider: preset.provider,
          baseUrl,
          model,
          apiKey,
        }),
      );
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI settings</h1>
          <p className="muted">Choose which AI reads your resume.</p>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <div className="grid">
          <label className="field wide">
            <span>Provider</span>
            <select
              value={presetId}
              onChange={(e) => choosePreset(e.target.value)}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {!isClaude && (
            <>
              <label className="field wide">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
              <label className="field wide">
                <span>Model name, exactly as your provider lists it</span>
                <input
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setSaved(false);
                  }}
                />
              </label>
            </>
          )}

          <label className="field wide">
            <span>
              API key
              {preset.keyOptional ? " (leave blank if none is needed)" : ""}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={keyIsSaved ? "Saved. Leave blank to keep it." : ""}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSaved(false);
              }}
            />
          </label>
        </div>

        <p className="muted note settings-note">
          {isClaude
            ? "Your resume PDF is sent to Claude when you import it."
            : "Text from your resume is sent to this provider when you import it. Scanned PDFs need Claude."}{" "}
          Your key is stored only in Draftline's database on this computer.
        </p>

        <div className="actions">
          <button className="primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
          {saved && (
            <span className="status" role="status">
              Saved
            </span>
          )}
        </div>
      </section>
    </>
  );
}
