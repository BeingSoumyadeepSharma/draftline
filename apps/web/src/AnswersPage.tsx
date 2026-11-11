import { useEffect, useState } from "react";
import {
  ANSWER_CATEGORIES,
  SENSITIVE_CATEGORIES,
  type Answer,
  type AnswerCategory,
} from "@draftline/shared";
import { api } from "./api";

const CATEGORY_LABELS: Record<AnswerCategory, string> = {
  work_authorization: "Work authorization",
  compensation: "Compensation",
  demographics: "Demographics",
  logistics: "Logistics",
  general: "General",
};

function AnswerRow({
  answer,
  onSaved,
  onDeleted,
  onError,
}: {
  answer: Answer;
  onSaved: (answer: Answer) => void;
  onDeleted: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [question, setQuestion] = useState(answer.question);
  const [text, setText] = useState(answer.answer);

  async function save() {
    if (question === answer.question && text === answer.answer) return;
    if (!question.trim()) {
      setQuestion(answer.question);
      return;
    }
    try {
      onSaved(
        await api.updateAnswer(answer.id, {
          question,
          answer: text,
          category: answer.category,
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function remove() {
    if (answer.answer && !window.confirm(`Delete "${answer.question}"?`)) return;
    try {
      await api.deleteAnswer(answer.id);
      onDeleted(answer.id);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="answer">
      <textarea
        className="question"
        aria-label="Question"
        rows={2}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onBlur={save}
      />
      <textarea
        aria-label={`Answer to ${answer.question}`}
        rows={2}
        placeholder="Your answer"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
      />
      <button className="ghost danger" onClick={remove}>
        Delete
      </button>
    </div>
  );
}

export function AnswersPage() {
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAnswers().then(setAnswers, (e: Error) => setError(e.message));
  }, []);

  async function add(category: AnswerCategory) {
    const question = window.prompt("What question do applications ask?");
    if (!question?.trim()) return;
    try {
      const created = await api.createAnswer({ question, answer: "", category });
      setAnswers((current) => [...current, created]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Saved answers</h1>
          <p className="muted">
            Answers to the questions applications keep asking. Changes save when
            you leave a field.
          </p>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {ANSWER_CATEGORIES.map((category) => (
        <section className="card" key={category}>
          <div className="card-head">
            <h2>{CATEGORY_LABELS[category]}</h2>
            <button className="ghost" onClick={() => add(category)}>
              + Add question
            </button>
          </div>
          {SENSITIVE_CATEGORIES.includes(category) && (
            <p className="muted note">
              Only ever filled from what you write here. AI never answers these.
            </p>
          )}
          {answers
            .filter((answer) => answer.category === category)
            .map((answer) => (
              <AnswerRow
                key={answer.id}
                answer={answer}
                onError={setError}
                onSaved={(updated) =>
                  setAnswers((current) =>
                    current.map((a) => (a.id === updated.id ? updated : a)),
                  )
                }
                onDeleted={(id) =>
                  setAnswers((current) => current.filter((a) => a.id !== id))
                }
              />
            ))}
        </section>
      ))}
    </>
  );
}
