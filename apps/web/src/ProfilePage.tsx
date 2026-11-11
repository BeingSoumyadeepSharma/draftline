import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Profile } from "@draftline/shared";
import { api } from "./api";

type Update = (change: (draft: Profile) => void) => void;

function Field({
  label,
  value,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Section({
  title,
  onAdd,
  addLabel,
  children,
}: {
  title: string;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {onAdd && (
          <button className="ghost" onClick={onAdd}>
            + {addLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Entry({
  onRemove,
  removeLabel,
  children,
}: {
  onRemove: () => void;
  removeLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="entry">
      <div className="grid">{children}</div>
      <button className="ghost danger" onClick={onRemove}>
        Remove {removeLabel}
      </button>
    </div>
  );
}

const parseSkills = (text: string) =>
  text
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);

function SkillsInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (skills: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));

  // Sync from outside (an import) without rewriting what's being typed.
  useEffect(() => {
    if (parseSkills(text).join("\n") !== value.join("\n")) {
      setText(value.join(", "));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className="field wide">
      <span>Separate skills with commas</span>
      <textarea
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseSkills(e.target.value));
        }}
      />
    </label>
  );
}

function ProfileEditor({
  profile,
  update,
}: {
  profile: Profile;
  update: Update;
}) {
  const { contact } = profile;
  const newId = () => crypto.randomUUID();

  return (
    <>
      <Section
        title="Contact"
        addLabel="Add link"
        onAdd={() =>
          update((d) => d.contact.links.push({ label: "", url: "" }))
        }
      >
        <div className="grid">
          <Field
            label="Full name"
            value={contact.fullName}
            onChange={(v) => update((d) => void (d.contact.fullName = v))}
          />
          <Field
            label="Email"
            value={contact.email}
            onChange={(v) => update((d) => void (d.contact.email = v))}
          />
          <Field
            label="Phone"
            value={contact.phone}
            onChange={(v) => update((d) => void (d.contact.phone = v))}
          />
          <Field
            label="Location"
            value={contact.location}
            onChange={(v) => update((d) => void (d.contact.location = v))}
          />
        </div>
        {contact.links.map((link, i) => (
          <Entry
            key={i}
            removeLabel="link"
            onRemove={() => update((d) => void d.contact.links.splice(i, 1))}
          >
            <Field
              label="Label"
              value={link.label}
              onChange={(v) =>
                update((d) => void (d.contact.links[i]!.label = v))
              }
            />
            <Field
              label="URL"
              value={link.url}
              onChange={(v) =>
                update((d) => void (d.contact.links[i]!.url = v))
              }
            />
          </Entry>
        ))}
      </Section>

      <Section title="Summary">
        <div className="grid">
          <TextArea
            label="Professional summary"
            rows={4}
            value={profile.summary}
            onChange={(v) => update((d) => void (d.summary = v))}
          />
        </div>
      </Section>

      <Section
        title="Experience"
        addLabel="Add role"
        onAdd={() =>
          update((d) =>
            d.experience.push({
              id: newId(),
              company: "",
              title: "",
              location: "",
              startDate: "",
              endDate: "",
              bullets: [],
            }),
          )
        }
      >
        {profile.experience.map((role, i) => {
          const set = (key: "company" | "title" | "location" | "startDate" | "endDate") =>
            (v: string) => update((d) => void (d.experience[i]![key] = v));
          return (
            <Entry
              key={role.id}
              removeLabel="role"
              onRemove={() => update((d) => void d.experience.splice(i, 1))}
            >
              <Field label="Company" value={role.company} onChange={set("company")} />
              <Field label="Title" value={role.title} onChange={set("title")} />
              <Field label="Location" value={role.location} onChange={set("location")} />
              <div className="dates">
                <Field label="Start" value={role.startDate} onChange={set("startDate")} />
                <Field label="End" value={role.endDate} onChange={set("endDate")} />
              </div>
              <div className="wide bullets">
                {role.bullets.map((bullet, j) => (
                  <div className="bullet" key={bullet.id}>
                    <textarea
                      aria-label={`Bullet ${j + 1}`}
                      rows={2}
                      value={bullet.text}
                      onChange={(e) => {
                        const text = e.target.value;
                        update((d) => void (d.experience[i]!.bullets[j]!.text = text));
                      }}
                    />
                    <button
                      className="ghost danger"
                      aria-label={`Remove bullet ${j + 1}`}
                      onClick={() =>
                        update((d) => void d.experience[i]!.bullets.splice(j, 1))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="ghost"
                  onClick={() =>
                    update((d) =>
                      d.experience[i]!.bullets.push({ id: newId(), text: "" }),
                    )
                  }
                >
                  + Add bullet
                </button>
              </div>
            </Entry>
          );
        })}
      </Section>

      <Section
        title="Education"
        addLabel="Add school"
        onAdd={() =>
          update((d) =>
            d.education.push({
              id: newId(),
              school: "",
              degree: "",
              field: "",
              startDate: "",
              endDate: "",
              details: "",
            }),
          )
        }
      >
        {profile.education.map((item, i) => {
          const set = (key: "school" | "degree" | "field" | "startDate" | "endDate" | "details") =>
            (v: string) => update((d) => void (d.education[i]![key] = v));
          return (
            <Entry
              key={item.id}
              removeLabel="school"
              onRemove={() => update((d) => void d.education.splice(i, 1))}
            >
              <Field label="School" value={item.school} onChange={set("school")} />
              <Field label="Degree" value={item.degree} onChange={set("degree")} />
              <Field label="Field of study" value={item.field} onChange={set("field")} />
              <div className="dates">
                <Field label="Start" value={item.startDate} onChange={set("startDate")} />
                <Field label="End" value={item.endDate} onChange={set("endDate")} />
              </div>
              <TextArea label="Details" rows={2} value={item.details} onChange={set("details")} />
            </Entry>
          );
        })}
      </Section>

      <Section
        title="Projects"
        addLabel="Add project"
        onAdd={() =>
          update((d) =>
            d.projects.push({ id: newId(), name: "", url: "", description: "" }),
          )
        }
      >
        {profile.projects.map((item, i) => {
          const set = (key: "name" | "url" | "description") => (v: string) =>
            update((d) => void (d.projects[i]![key] = v));
          return (
            <Entry
              key={item.id}
              removeLabel="project"
              onRemove={() => update((d) => void d.projects.splice(i, 1))}
            >
              <Field label="Name" value={item.name} onChange={set("name")} />
              <Field label="URL" value={item.url} onChange={set("url")} />
              <TextArea label="Description" value={item.description} onChange={set("description")} />
            </Entry>
          );
        })}
      </Section>

      <Section
        title="Certifications"
        addLabel="Add certification"
        onAdd={() =>
          update((d) =>
            d.certifications.push({ id: newId(), name: "", issuer: "", date: "" }),
          )
        }
      >
        {profile.certifications.map((item, i) => {
          const set = (key: "name" | "issuer" | "date") => (v: string) =>
            update((d) => void (d.certifications[i]![key] = v));
          return (
            <Entry
              key={item.id}
              removeLabel="certification"
              onRemove={() => update((d) => void d.certifications.splice(i, 1))}
            >
              <Field label="Name" value={item.name} onChange={set("name")} />
              <Field label="Issuer" value={item.issuer} onChange={set("issuer")} />
              <Field label="Date" value={item.date} onChange={set("date")} />
            </Entry>
          );
        })}
      </Section>

      <Section title="Skills">
        <div className="grid">
          <SkillsInput
            value={profile.skills}
            onChange={(skills) => update((d) => void (d.skills = skills))}
          />
        </div>
      </Section>
    </>
  );
}

export function ProfilePage() {
  const [saved, setSaved] = useState<Profile | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [importedFrom, setImportedFrom] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = JSON.stringify(profile) !== JSON.stringify(saved);

  useEffect(() => {
    Promise.all([api.getProfile(), api.status()])
      .then(([loaded, status]) => {
        setSaved(loaded);
        setProfile(loaded);
        setAiConfigured(status.aiConfigured);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update: Update = (change) => {
    setJustSaved(false);
    setProfile((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      change(draft);
      return draft;
    });
  };

  async function importResume(file: File) {
    setImporting(true);
    setError(null);
    setJustSaved(false);
    try {
      const result = await api.parseResume(file);
      setProfile(result.profile);
      setImportedFrom(file.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function save() {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveProfile(profile);
      setSaved(result);
      setProfile(result);
      setImportedFrom(null);
      setJustSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setProfile(saved);
    setImportedFrom(null);
    setJustSaved(false);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Your profile</h1>
          <p className="muted">
            Everything Draftline writes for you is drawn from these facts.
          </p>
        </div>
        <div className="actions">
          {justSaved && !dirty && (
            <span className="status" role="status">
              Saved
            </span>
          )}
          <button className="ghost" disabled={!dirty} onClick={discard}>
            Discard changes
          </button>
          <button className="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>

      <section className="card import">
        <div>
          <h2>Import your resume</h2>
          <p className="muted">
            {aiConfigured
              ? "Claude reads your PDF and fills in the form below. Nothing is saved until you review it."
              : "To import a PDF, add ANTHROPIC_API_KEY to the .env file and restart the app. You can still fill this in by hand."}
          </p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importResume(file);
          }}
        />
        <button
          className="primary"
          disabled={!aiConfigured || importing}
          onClick={() => fileInput.current?.click()}
        >
          {importing ? "Reading resume…" : "Choose PDF"}
        </button>
      </section>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {importedFrom && (
        <p className="banner" role="status">
          Imported from {importedFrom}. Check every section, then save.
        </p>
      )}

      {profile && <ProfileEditor profile={profile} update={update} />}
    </>
  );
}
