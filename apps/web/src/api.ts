import type {
  AiSettingsInput,
  AiSettingsView,
  Answer,
  AnswerInput,
  ApiError,
  Profile,
  ResumeFileMeta,
  ResumeParseResult,
  Status,
} from "@draftline/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new Error("Can't reach the Draftline server. Is it running?");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  status: () => request<Status>("/status"),
  getProfile: () => request<Profile>("/profile"),
  saveProfile: (profile: Profile) =>
    request<Profile>("/profile", json("PUT", profile)),
  parseResume: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<ResumeParseResult>("/resume/parse", {
      method: "POST",
      body,
    });
  },
  getAiSettings: () => request<AiSettingsView>("/settings/ai"),
  saveAiSettings: (input: AiSettingsInput) =>
    request<AiSettingsView>("/settings/ai", json("PUT", input)),
  resumeMeta: () => request<ResumeFileMeta | null>("/resume/meta"),
  uploadResume: (file: File) => {
    const body = new FormData();
    body.set("file", file);
    return request<ResumeFileMeta>("/resume/file", { method: "PUT", body });
  },
  listAnswers: () => request<Answer[]>("/answers"),
  createAnswer: (input: AnswerInput) =>
    request<Answer>("/answers", json("POST", input)),
  updateAnswer: (id: string, input: AnswerInput) =>
    request<Answer>(`/answers/${id}`, json("PUT", input)),
  deleteAnswer: (id: string) =>
    request<void>(`/answers/${id}`, { method: "DELETE" }),
};
