/**
 * Typed wrappers for the local server's API. Requests go to /api/..., which
 * the Vite dev server forwards to 127.0.0.1:8787 (see vite.config.ts).
 * Errors are thrown with the server's own message, ready to show the user.
 */
import type {
  AiSettingsInput,
  AiSettingsView,
  Answer,
  AnswerInput,
  ApiError,
  CoverLetter,
  DiscoveryPreferences,
  DiscoveryState,
  DocumentKind,
  JobDocuments,
  JobEvent,
  JobListItem,
  JobRecord,
  Profile,
  ResumeFileMeta,
  SearchProvidersInput,
  ResumeParseResult,
  Status,
  TailoredResume,
  TrackingUpdate,
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

  // Job discovery (Discover tab)
  discovery: () => request<DiscoveryState>("/discovery"),
  saveDiscoveryPreferences: (preferences: DiscoveryPreferences) =>
    request<DiscoveryState>("/discovery/preferences", json("PUT", preferences)),
  addDiscoverySource: (url: string) =>
    request<DiscoveryState>("/discovery/sources", json("POST", { url })),
  removeDiscoverySource: (id: string) =>
    request<DiscoveryState>(`/discovery/sources/${id}`, { method: "DELETE" }),
  refreshDiscovery: () => request<DiscoveryState>("/discovery/refresh", { method: "POST" }),
  addSearch: (position: string, location: string) =>
    request<DiscoveryState>("/discovery/searches", json("POST", { position, location })),
  removeSearch: (id: string) =>
    request<DiscoveryState>(`/discovery/searches/${id}`, { method: "DELETE" }),
  saveSearchProviders: (input: SearchProvidersInput) =>
    request<DiscoveryState>("/discovery/providers", json("PUT", input)),
  markDiscoverySeen: () => request<{ ok: true }>("/discovery/seen", { method: "POST" }),
  saveDiscoveredJob: (id: string) =>
    request<{ jobId: string; state: DiscoveryState }>(`/discovery/jobs/${id}/save`, { method: "POST" }),
  dismissDiscoveredJob: (id: string) =>
    request<DiscoveryState>(`/discovery/jobs/${id}/dismiss`, { method: "POST" }),

  // Jobs and their tailored documents (Applications tab)
  listJobs: () => request<JobListItem[]>("/jobs"),
  getJob: (id: string) => request<JobRecord>(`/jobs/${id}`),
  getDocuments: (id: string) => request<JobDocuments>(`/jobs/${id}/documents`),
  generateDocument: (id: string, kind: DocumentKind) =>
    request<JobDocuments>(`/jobs/${id}/documents/${kind}/generate`, { method: "POST" }),
  saveResume: (id: string, content: TailoredResume) =>
    request<JobDocuments>(`/jobs/${id}/documents/resume`, json("PUT", { content })),
  saveCoverLetter: (id: string, content: CoverLetter) =>
    request<JobDocuments>(`/jobs/${id}/documents/cover_letter`, json("PUT", { content })),
  approveDocument: (id: string, kind: DocumentKind) =>
    request<JobDocuments>(`/jobs/${id}/documents/${kind}/approve`, { method: "POST" }),
  updateTracking: (id: string, change: TrackingUpdate) =>
    request<JobRecord>(`/jobs/${id}/tracking`, json("PATCH", change)),
  listEvents: (id: string) => request<JobEvent[]>(`/jobs/${id}/events`),
  /** Opened in a new tab; the time stops the browser showing an old copy. */
  previewUrl: (id: string, kind: DocumentKind) =>
    `/api/jobs/${id}/documents/${kind}/preview?t=${Date.now()}`,

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
