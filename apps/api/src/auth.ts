/**
 * Request authentication (PLAN.md §2 decision 15, revised: v1 shipped with no auth and `user_id`
 * on every table precisely so multi-user would be a migration rather than a rewrite — this is that
 * migration).
 *
 * Passwords, sessions, and email verification all live in Supabase Auth. This API never sees a
 * credential; it only ever verifies a signed access token and maps its subject onto the local
 * `users` row that owns the practice history (`provisionUserForAuth` in @leetmind/db).
 *
 * Two verification paths, because Supabase supports both and a project can be rotated from one to
 * the other while sessions signed the old way are still live:
 *  - **Symmetric (HS256)** using `SUPABASE_JWT_SECRET`. Legacy hosted projects sign this way.
 *  - **Asymmetric (ES256/RS256)** verified against the project's published JWKS at
 *    `/auth/v1/.well-known/jwks.json`. Current projects — including local `supabase start` — sign
 *    this way, and `jose`'s remote key set handles fetching, caching, and key rotation.
 *
 * Which path a given token takes is decided by the token's own header, not by configuration — see
 * `createTokenVerifier`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { provisionUserForAuth } from "@leetmind/db";
import { AppError, type ApiConfig } from "@leetmind/shared";
import type { Deps } from "./deps.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The local `users.id` that owns this request's data. Always set by the time a route handler
     * runs — either from a verified token, or from `SINGLE_USER_ID` when auth is off. */
    userId: string;
    /** The verified Supabase subject, when authentication is on. */
    authUserId?: string;
    authEmail?: string | null;
  }
}

/** Routes reachable without a token. Deliberately tiny: liveness, and the Prometheus scrape
 * target (reached by the scraper on the compose network, which has no session — see the comment
 * in routes/metrics.ts). Everything under `/api` requires a verified session. */
const PUBLIC_PATHS = new Set(["/health", "/healthz", "/metrics"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

/** Strips query/fragment so `/health?probe=1` is still recognised as the liveness route. */
export function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/** The SSE verdict stream, the one route a browser cannot send an `Authorization` header to
 * (`EventSource` has no header API). */
const SSE_PATH = /^\/api\/submissions\/[^/]+\/events$/;

export function allowsQueryToken(pathname: string): boolean {
  return SSE_PATH.test(pathname);
}

/**
 * Resolves the request's token. Falls back to an `access_token` query parameter *only* on the SSE
 * route, because that is the only place a header is impossible. Tokens in URLs are otherwise a bad
 * idea — they end up in access logs and referrers — so the fallback is deliberately narrow, and
 * `redactUrl` (src/server.ts) strips the parameter before anything is logged.
 */
export function requestToken(request: FastifyRequest): string | null {
  const header = bearerToken(request.headers.authorization);
  if (header) return header;

  const pathname = pathnameOf(request.url);
  if (!allowsQueryToken(pathname)) return null;

  const q = (request.query ?? {}) as Record<string, unknown>;
  const token = typeof q.access_token === "string" ? q.access_token.trim() : "";
  return token.length > 0 ? token : null;
}

export interface VerifiedIdentity {
  authUserId: string;
  email: string | null;
}

/**
 * Builds the token verifier for this config. Constructed once at server build time so the JWKS
 * key set (and its cache) is shared across requests instead of refetched per call.
 *
 * The algorithm is chosen **per token, from its own header**, not from configuration. Supabase is
 * mid-migration from symmetric to asymmetric signing keys: a project can be rotated from one to
 * the other, and during that rotation both kinds of token are live at once. Picking the path from
 * config instead would mean every session minted on the other side of the rotation failing with an
 * opaque "invalid token" — which is exactly what happened here the first time, against a local
 * project that signs ES256 while `SUPABASE_JWT_SECRET` was still set from the legacy defaults.
 *
 * An attacker cannot use this to downgrade: an `HS256` header is only honoured when a symmetric
 * secret is actually configured, and the secret is never used to verify a token that claims an
 * asymmetric algorithm (or vice versa).
 */
export function createTokenVerifier(
  config: ApiConfig,
): (token: string) => Promise<VerifiedIdentity> {
  if (!config.supabaseUrl) {
    return async () => {
      throw new AppError(
        "internal_error",
        "Token verification requested with no SUPABASE_URL configured",
        500,
      );
    };
  }

  const issuer = `${config.supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  const secret = config.supabaseJwtSecret
    ? new TextEncoder().encode(config.supabaseJwtSecret)
    : null;
  // Lazily constructed: a project that only ever issues HS256 tokens should never be made to
  // fetch a JWKS document it doesn't use.
  let jwks: JWTVerifyGetKey | null = null;
  function remoteKeys(): JWTVerifyGetKey {
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    return jwks;
  }

  return async (token: string): Promise<VerifiedIdentity> => {
    let payload: JWTPayload;
    try {
      const alg = decodeProtectedHeader(token).alg ?? "";
      const symmetric = alg.startsWith("HS");
      if (symmetric && !secret) {
        throw new AppError(
          "unauthorized",
          "Token is signed with a symmetric key but SUPABASE_JWT_SECRET is not configured.",
          401,
        );
      }
      const result = symmetric
        ? await jwtVerify(token, secret!, { issuer, audience: "authenticated", algorithms: [alg] })
        : await jwtVerify(token, remoteKeys(), { issuer, audience: "authenticated" });
      payload = result.payload;
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Expiry is the overwhelmingly common case and the client can fix it by refreshing, so it
      // gets its own message rather than a flat "invalid token".
      const expired = err instanceof Error && err.name === "JWTExpired";
      throw new AppError(
        "unauthorized",
        expired ? "Session expired — sign in again." : "Invalid or malformed access token.",
        401,
      );
    }

    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sub) throw new AppError("unauthorized", "Access token has no subject.", 401);

    const email = typeof payload.email === "string" ? payload.email : null;
    return { authUserId: sub, email };
  };
}

/**
 * Registers the `preHandler` hook that resolves every request's `userId`.
 *
 * When authentication is off (a single-user local stack: no `SUPABASE_URL`, not production) this
 * pins every request to `SINGLE_USER_ID`, which is exactly the behaviour the app had before
 * accounts existed. When it is on, a missing or bad token is a 401 and no route handler runs.
 */
export function registerAuth(fastify: FastifyInstance, deps: Deps): void {
  const { config, logger } = deps;

  if (!config.authRequired) {
    fastify.addHook("preHandler", async (request) => {
      request.userId = config.singleUserId;
    });
    return;
  }

  const verify = createTokenVerifier(config);

  fastify.addHook("preHandler", async (request: FastifyRequest) => {
    if (isPublicPath(pathnameOf(request.url))) return;

    const token = requestToken(request);
    if (!token) {
      throw new AppError("unauthorized", "Sign in to continue.", 401);
    }

    const identity = await verify(token);

    // First request from a new account creates its local row. Every later request is a single
    // indexed lookup on `users.auth_user_id`.
    const user = await provisionUserForAuth(identity, {
      legacyUserId: config.singleUserId,
      legacyClaimEmail: config.legacyClaimEmail ?? null,
    });

    request.userId = user.id;
    request.authUserId = identity.authUserId;
    request.authEmail = identity.email;
    logger.debug({ user_id: user.id, auth_user_id: identity.authUserId }, "request authenticated");
  });
}
