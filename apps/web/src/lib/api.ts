/**
 * Thin, typed HTTP client for the LeetMind API (PLAN_BACKEND.md §9). Every function's return type
 * comes from `@shared`, which re-exports the OpenAPI-generated shapes — this file never
 * redeclares an API shape, it only calls fetch and casts the JSON to the type the server's own
 * schema says it is.
 *
 * Talks to `/api/...` (and `/health`), which Vite proxies to `VITE_API_BASE`.
 */
import type {
  CodeRequest,
  GiveUpResponse,
  HintResponse,
  MeResponse,
  PracticeNextResponse,
  ProblemDetail,
  ProgressResponse,
  ReplenishResponse,
  RunResponse,
  SubmitResponse,
} from "@shared";

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

async function authHeaders(): Promise<Record<string, string>> {
  const token = await currentAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(await authHeaders()),
      ...(init?.headers ?? {}),
    },
  });

  const correlationId = res.headers.get("x-correlation-id") ?? undefined;

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { detail?: string };
      if (typeof body?.detail === "string") message = body.detail;
      code = String(res.status);
    } catch {
      // body wasn't JSON, fall back to statusText
    }
    throw new ApiError(res.status, message, code, correlationId);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export const api = {
  health: () => request<Record<string, boolean | string>>("/health"),

  me: () => request<MeResponse>("/api/me"),

  /** The practice loop's single read: what's active, what's generating, or nothing at all —
   * never the statement (amendments 36, 41). */
  practiceNext: () => request<PracticeNextResponse>("/api/practice/next"),

  /** Idempotent bootstrap/self-heal: tops the queue up to the invariant. */
  practiceReplenish: () => postJson<ReplenishResponse>("/api/practice/replenish"),

  /** Requires the problem opened first (409 `not_opened` otherwise). */
  getProblem: (problemId: string) => request<ProblemDetail>(`/api/problems/${problemId}`),

  /** Atomically stamps `served_at` and returns the full view — the one way to see the statement. */
  openProblem: (problemId: string) => postJson<ProblemDetail>(`/api/problems/${problemId}/open`),

  run: (problemId: string, body: CodeRequest) =>
    postJson<RunResponse>(`/api/problems/${problemId}/run`, body),

  submit: (problemId: string, body: CodeRequest) =>
    postJson<SubmitResponse>(`/api/problems/${problemId}/submit`, body),

  giveUp: (problemId: string) => postJson<GiveUpResponse>(`/api/problems/${problemId}/give-up`),

  revealHint: (problemId: string, rung: number) =>
    postJson<HintResponse>(`/api/problems/${problemId}/hints/${rung}`),

  progress: () => request<ProgressResponse>("/api/progress"),
};

export function eventsUrl(): string {
  return "/api/events";
}
