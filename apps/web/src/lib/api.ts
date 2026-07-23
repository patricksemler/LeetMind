/**
 * Thin, typed HTTP client for the AlgoLift API (docs/CONTRACTS.md §9). Every response is parsed
 * through the zod schemas exported from `@algolift/shared` — this file never redeclares an API
 * shape, it only calls fetch and hands the JSON to the shared schema.
 *
 * Talks to `/api/...` (and `/health`), which Vite proxies to `VITE_API_BASE` — the mock server in
 * dev, the real `apps/api` once it exists. Nothing here needs to change to switch between them.
 */
import {
  type CreateSubmissionRequest,
  CreateSubmissionResponse,
  type CreateWorkoutRequest,
  CreateWorkoutResponse,
  type GenerateNowRequest,
  GenerateNowResponse,
  GetConceptsResponse,
  GetCurrentWorkoutResponse,
  type GiveUpRequest,
  GiveUpResponse,
  GetHintsResponse,
  GetLatestSubmissionResponse,
  GetProblemResponse,
  GetSubmissionResponse,
  HealthResponse,
  NextProblemResponse,
  ProgressResponse,
  type SkipWorkoutItemRequest,
  SkipWorkoutItemResponse,
  StartDiagnosticResponse,
  StartWorkoutItemResponse,
  SystemStatsResponse,
  type TakeHintRequest,
  TakeHintResponse,
} from "@algolift/shared";

export class ApiError extends Error {
  status: number;
  code?: string;
  correlationId?: string;

  constructor(status: number, message: string, code?: string, correlationId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

interface Schema<T> {
  parse: (value: unknown) => T;
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

  const correlationId = res.headers.get("x-correlation-id") ?? undefined;

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.message) message = body.error.message;
      code = body?.error?.code;
    } catch {
      // body wasn't JSON, fall back to statusText
    }
    throw new ApiError(res.status, message, code, correlationId);
  }

  if (res.status === 204) return schema.parse(undefined);
  const json = await res.json();
  return schema.parse(json);
}

function postJson<T>(path: string, body: unknown, schema: Schema<T>): Promise<T> {
  return request(path, schema, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export const api = {
  health: () => request("/health", HealthResponse),

  nextProblem: (params: { concept?: string; rating?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.concept) qs.set("concept", params.concept);
    if (params.rating !== undefined) qs.set("rating", String(params.rating));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request(`/api/problems/next${suffix}`, NextProblemResponse);
  },

  getProblem: (versionId: string) => request(`/api/problems/${versionId}`, GetProblemResponse),

  createSubmission: (body: CreateSubmissionRequest) =>
    postJson("/api/submissions", body, CreateSubmissionResponse),

  getSubmission: (id: string) => request(`/api/submissions/${id}`, GetSubmissionResponse),

  latestSubmission: (versionId: string) =>
    request(`/api/problems/${versionId}/submissions/latest`, GetLatestSubmissionResponse),

  takeHint: (body: TakeHintRequest) => postJson("/api/hints", body, TakeHintResponse),

  getHints: (versionId: string) => request(`/api/hints/${versionId}`, GetHintsResponse),

  giveUp: (versionId: string, body: GiveUpRequest) =>
    postJson(`/api/problems/${versionId}/give-up`, body, GiveUpResponse),

  progress: () => request("/api/progress", ProgressResponse),

  systemStats: () => request("/api/system/stats", SystemStatsResponse),

  createWorkout: (body: CreateWorkoutRequest) => postJson("/api/workouts", body, CreateWorkoutResponse),

  currentWorkout: () => request("/api/workouts/current", GetCurrentWorkoutResponse),

  skipWorkoutItem: (id: string, body: SkipWorkoutItemRequest) =>
    postJson(`/api/workout-items/${id}/skip`, body, SkipWorkoutItemResponse),

  startWorkoutItem: (id: string) =>
    postJson(`/api/workout-items/${id}/start`, {}, StartWorkoutItemResponse),

  startDiagnostic: () => postJson("/api/diagnostic/start", {}, StartDiagnosticResponse),

  generateNow: (body: GenerateNowRequest) => postJson("/api/generate-now", body, GenerateNowResponse),

  concepts: () => request("/api/concepts", GetConceptsResponse),
};

export function submissionEventsUrl(submissionId: string): string {
  return `/api/submissions/${submissionId}/events`;
}
