/**
 * Thin, typed HTTP client for the LeetMind API (docs/CONTRACTS.md §9). Every response is parsed
 * through the zod schemas exported from `@leetmind/shared` — this file never redeclares an API
 * shape, it only calls fetch and hands the JSON to the shared schema.
 *
 * Talks to `/api/...` (and `/health`), which Vite proxies to `VITE_API_BASE` — the mock server in
 * dev, the real `apps/api` in a live stack. Nothing here needs to change to switch between them.
 */
import {
  CreateSubmissionResponse,
  GetConceptsResponse,
  GetCurrentBaselineResponse,
  GetHintsResponse,
  GetLatestSubmissionResponse,
  GetProblemResponse,
  GetSubmissionResponse,
  GenerateNowResponse,
  ListSubmissionsResponse,
  HealthResponse,
  MeResponse,
  NextPracticeProblemResponse,
  NextProblemResponse,
  ProgressResponse,
  SkipBaselineItemResponse,
  StartBaselineItemResponse,
  StartBaselineResponse,
  TakeHintResponse,
  GiveUpResponse,
  type CreateSubmissionRequest,
  type GenerateNowRequest,
  type GiveUpRequest,
  type SkipBaselineItemRequest,
  type TakeHintRequest,
} from "@leetmind/shared";

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

/**
 * Set by `AuthProvider`. Deliberately **async**, and deliberately a getter rather than a stored
 * token.
 *
 * Async because the session is not synchronously available at the moments that matter: right after
 * `signUp`/`signIn` resolves, React has not yet processed the `onAuthStateChange` state update, and
 * on a cold load Supabase restores the persisted session asynchronously. A synchronous getter
 * reading React state returns `null` in both windows, and every query fired in them 401s —
 * observed live as a freshly-created account landing on an empty practice page. Awaiting the
 * Supabase client instead means a request simply waits for the session rather than racing it.
 *
 * A getter rather than a stored token because Supabase refreshes access tokens in the background,
 * so any copy we hold goes stale.
 */
type AccessTokenGetter = () => Promise<string | null>;
let accessTokenGetter: AccessTokenGetter | null = null;

export function setAccessTokenGetter(getter: AccessTokenGetter | null): void {
  accessTokenGetter = getter;
}

export async function currentAccessToken(): Promise<string | null> {
  return (await accessTokenGetter?.()) ?? null;
}

interface Schema<T> {
  parse: (value: unknown) => T;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await currentAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders()), ...(init?.headers ?? {}) },
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

  me: () => request("/api/me", MeResponse),

  /** The practice loop's single endpoint: next problem, or the generation in flight for it. */
  nextPracticeProblem: () => request("/api/practice/next", NextPracticeProblemResponse),

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

  listSubmissions: (versionId: string) =>
    request(`/api/problems/${versionId}/submissions`, ListSubmissionsResponse),

  takeHint: (body: TakeHintRequest) => postJson("/api/hints", body, TakeHintResponse),

  getHints: (versionId: string) => request(`/api/hints/${versionId}`, GetHintsResponse),

  giveUp: (versionId: string, body: GiveUpRequest) =>
    postJson(`/api/problems/${versionId}/give-up`, body, GiveUpResponse),

  progress: () => request("/api/progress", ProgressResponse),

  startBaseline: () => postJson("/api/baseline/start", {}, StartBaselineResponse),

  currentBaseline: () => request("/api/baseline/current", GetCurrentBaselineResponse),

  skipBaselineItem: (id: string, body: SkipBaselineItemRequest) =>
    postJson(`/api/baseline-items/${id}/skip`, body, SkipBaselineItemResponse),

  startBaselineItem: (id: string) =>
    postJson(`/api/baseline-items/${id}/start`, {}, StartBaselineItemResponse),

  generateNow: (body: GenerateNowRequest) => postJson("/api/generate-now", body, GenerateNowResponse),

  concepts: () => request("/api/concepts", GetConceptsResponse),
};

export function submissionEventsUrl(submissionId: string): string {
  return `/api/submissions/${submissionId}/events`;
}

/**
 * `EventSource` cannot send an `Authorization` header, so the SSE stream authenticates with the
 * access token as a query parameter instead. This is the one place a token appears in a URL; it is
 * a same-origin request to our own API over the Vite proxy (or TLS in a deployed stack), and the
 * alternative — a cookie — would mean giving up the stateless bearer model everywhere else.
 */
export async function submissionEventsUrlWithAuth(submissionId: string): Promise<string> {
  const token = await currentAccessToken();
  const base = submissionEventsUrl(submissionId);
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
}
