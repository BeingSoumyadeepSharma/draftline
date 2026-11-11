import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  EMPTY_PROFILE,
  ProfileSchema,
  type Answer,
  type AnswerCategory,
  type AnswerInput,
  type Profile,
} from "@draftline/shared";

const STARTER_QUESTIONS: ReadonlyArray<[AnswerCategory, string]> = [
  ["work_authorization", "Are you legally authorized to work in this country?"],
  ["work_authorization", "Will you now or in the future require visa sponsorship?"],
  ["compensation", "What are your salary expectations?"],
  ["demographics", "Gender"],
  ["demographics", "Race / ethnicity"],
  ["demographics", "Veteran status"],
  ["demographics", "Disability status"],
  ["logistics", "What is your notice period or earliest start date?"],
  ["logistics", "Are you willing to relocate?"],
  ["logistics", "Are you open to hybrid or on-site work?"],
  ["general", "How did you hear about this role?"],
];

export type Store = ReturnType<typeof createStore>;

export function createStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      category TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `);

  const answerCount = db.prepare("SELECT COUNT(*) AS n FROM answers").get() as {
    n: number;
  };
  if (answerCount.n === 0) {
    const insert = db.prepare(
      "INSERT INTO answers (id, question, answer, category, position) VALUES (?, ?, '', ?, ?)",
    );
    db.transaction(() => {
      STARTER_QUESTIONS.forEach(([category, question], index) => {
        insert.run(randomUUID(), question, category, index);
      });
    })();
  }

  return {
    getProfile(): Profile {
      const row = db.prepare("SELECT data FROM profile WHERE id = 1").get() as
        | { data: string }
        | undefined;
      return row ? ProfileSchema.parse(JSON.parse(row.data)) : EMPTY_PROFILE;
    },

    saveProfile(profile: Profile): void {
      db.prepare(
        `INSERT INTO profile (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(profile), new Date().toISOString());
    },

    listAnswers(): Answer[] {
      return db
        .prepare(
          "SELECT id, question, answer, category FROM answers ORDER BY position",
        )
        .all() as Answer[];
    },

    createAnswer(input: AnswerInput): Answer {
      const answer = { id: randomUUID(), ...input };
      db.prepare(
        `INSERT INTO answers (id, question, answer, category, position)
         VALUES (@id, @question, @answer, @category,
                 (SELECT COALESCE(MAX(position), -1) + 1 FROM answers))`,
      ).run(answer);
      return answer;
    },

    updateAnswer(id: string, input: AnswerInput): Answer | null {
      const { changes } = db
        .prepare(
          "UPDATE answers SET question = @question, answer = @answer, category = @category WHERE id = @id",
        )
        .run({ id, ...input });
      return changes > 0 ? { id, ...input } : null;
    },

    deleteAnswer(id: string): boolean {
      return db.prepare("DELETE FROM answers WHERE id = ?").run(id).changes > 0;
    },
  };
}
