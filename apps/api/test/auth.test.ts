import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { loadApiConfig, newId, type ApiConfig } from "@leetmind/shared";
import { allowsQueryToken, bearerToken, isPublicPath, pathnameOf } from "../src/auth.js";
import { buildDeps, type Deps } from "../src/deps.js";
import { buildServer, redactUrl } from "../src/server.js";
import { isDatabaseReachable, testPool } from "./helpers.js";

const dbReachable = await isDatabaseReachable();

const SUPABASE_URL = "https://test-project.supabase.co";
const JWT_SECRET = "test-only-symmetric-secret-at-least-32-chars";
const ISSUER = `${SUPABASE_URL}/auth/v1`;

async function signToken(claims: {
  sub: string;
  email?: string;
  expiresIn?: string;
  issuer?: string;
  audience?: string;
}) {
  return new SignJWT({ ...(claims.email ? { email: claims.email } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(claims.issuer ?? ISSUER)
    .setAudience(claims.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe("auth helpers (pure)", () => {
  it("parses a bearer token case-insensitively and rejects everything else", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer   ")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(["Bearer abc"])).toBeNull();
  });

  it("recognises the liveness and scrape routes as public, even with a query string", () => {
    expect(isPublicPath(pathnameOf("/health"))).toBe(true);
    expect(isPublicPath(pathnameOf("/health?probe=1"))).toBe(true);
    expect(isPublicPath(pathnameOf("/metrics"))).toBe(true);
    expect(isPublicPath(pathnameOf("/api/practice/next"))).toBe(false);
    expect(isPublicPath(pathnameOf("/api/me"))).toBe(false);
  });

  it("allows a query-parameter token ONLY on the SSE stream", () => {
    expect(allowsQueryToken("/api/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV/events")).toBe(true);
    expect(allowsQueryToken("/api/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(allowsQueryToken("/api/me")).toBe(false);
    expect(allowsQueryToken("/api/submissions/a/b/events")).toBe(false);
  });

  it("redacts an access token from a URL before it reaches the log", () => {
    expect(redactUrl("/api/submissions/x/events?access_token=super.secret.jwt")).toBe(
      "/api/submissions/x/events?access_token=REDACTED",
    );
    expect(redactUrl("/api/submissions/x/events?a=1&access_token=s&b=2")).toBe(
      "/api/submissions/x/events?a=1&access_token=REDACTED&b=2",
    );
    expect(redactUrl("/api/me")).toBe("/api/me");
  });
});

describe("loadApiConfig auth resolution", () => {
  const base = { DATABASE_URL: "postgres://leetmind:leetmind@localhost:5432/leetmind" };

  it("leaves auth off for a plain local stack with no Supabase project", () => {
    expect(loadApiConfig({ ...base } as NodeJS.ProcessEnv).authRequired).toBe(false);
  });

  it("turns auth on as soon as a Supabase project is configured", () => {
    const config = loadApiConfig({ ...base, SUPABASE_URL } as NodeJS.ProcessEnv);
    expect(config.authRequired).toBe(true);
    expect(config.supabaseUrl).toBe(SUPABASE_URL);
  });

  it("refuses to boot in production without a Supabase project rather than serving one shared account", () => {
    expect(() => loadApiConfig({ ...base, NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /SUPABASE_URL/,
    );
  });

  it("honours an explicit AUTH_REQUIRED=false even in production", () => {
    const config = loadApiConfig({
      ...base,
      NODE_ENV: "production",
      AUTH_REQUIRED: "false",
    } as NodeJS.ProcessEnv);
    expect(config.authRequired).toBe(false);
  });
});

describe.skipIf(!dbReachable)("authenticated requests", () => {
  let deps: Deps;
  let server: FastifyInstance;
  let config: ApiConfig;
  const pool = testPool();
  const createdAuthIds: string[] = [];

  beforeAll(async () => {
    config = {
      ...loadApiConfig(),
      supabaseUrl: SUPABASE_URL,
      supabaseJwtSecret: JWT_SECRET,
      authRequired: true,
      legacyClaimEmail: "legacy-owner@example.com",
    };
    deps = buildDeps(config);
    server = buildServer(deps);
  });

  afterEach(async () => {
    if (createdAuthIds.length > 0) {
      const ids = createdAuthIds.splice(0);
      await pool.query(
        "delete from user_concept_state where user_id in (select id from users where auth_user_id = any($1))",
        [ids],
      );
      await pool.query("delete from users where auth_user_id = any($1)", [ids]);
      // Un-claim the legacy row so the claim test is repeatable.
      await pool.query("update users set auth_user_id = null, email = null where id = $1", [
        config.singleUserId,
      ]);
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it("401s an unauthenticated API request instead of falling back to the single user", async () => {
    const res = await server.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("unauthorized");
  });

  it("leaves /health reachable without a token so liveness probes keep working", async () => {
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("provisions a local user on first sight of a subject, and reuses it afterwards", async () => {
    const sub = `auth-${newId()}`;
    createdAuthIds.push(sub);
    const token = await signToken({ sub, email: "newcomer@example.com" });

    const first = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.user.email).toBe("newcomer@example.com");
    expect(firstBody.user.handle).toBe("newcomer");

    const second = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(second.body).user.id).toBe(firstBody.user.id);

    const rows = await pool.query("select count(*)::int as n from users where auth_user_id = $1", [
      sub,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("gives two accounts separate local users, so practice history can never be shared", async () => {
    const subA = `auth-${newId()}`;
    const subB = `auth-${newId()}`;
    createdAuthIds.push(subA, subB);

    const a = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: subA, email: "a@example.com" })}`,
      },
    });
    const b = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: subB, email: "b@example.com" })}`,
      },
    });

    expect(JSON.parse(a.body).user.id).not.toBe(JSON.parse(b.body).user.id);
  });

  it("uniquifies the derived handle when two accounts share an email local part", async () => {
    const subA = `auth-${newId()}`;
    const subB = `auth-${newId()}`;
    createdAuthIds.push(subA, subB);

    const a = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: subA, email: "sam@one.example" })}`,
      },
    });
    const b = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: subB, email: "sam@two.example" })}`,
      },
    });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(a.body).user.handle).not.toBe(JSON.parse(b.body).user.handle);
  });

  it("binds the pre-accounts single-user history to the configured claim email, and to nobody else", async () => {
    const stranger = `auth-${newId()}`;
    const owner = `auth-${newId()}`;
    createdAuthIds.push(stranger, owner);

    // A different address must NOT inherit the legacy row.
    const strangerRes = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: stranger, email: "someone-else@example.com" })}`,
      },
    });
    expect(JSON.parse(strangerRes.body).user.id).not.toBe(config.singleUserId);

    // The configured address does — case-insensitively, since email case is not significant.
    const ownerRes = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${await signToken({ sub: owner, email: "Legacy-Owner@Example.com" })}`,
      },
    });
    expect(JSON.parse(ownerRes.body).user.id).toBe(config.singleUserId);
  });

  it("rejects an expired token with a message that tells the client to sign in again", async () => {
    const token = await signToken({ sub: `auth-${newId()}`, expiresIn: "-1h" });
    const res = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toMatch(/expired/i);
  });

  it("rejects a token from a different issuer or audience — a valid signature is not enough", async () => {
    const wrongIssuer = await signToken({
      sub: `auth-${newId()}`,
      issuer: "https://evil.example/auth/v1",
    });
    const wrongAudience = await signToken({ sub: `auth-${newId()}`, audience: "anon" });

    for (const token of [wrongIssuer, wrongAudience]) {
      const res = await server.inject({
        method: "GET",
        url: "/api/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("rejects a token signed with the wrong key", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("forged")
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-completely-different-secret-32-chars"));

    const res = await server.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the SSE stream's query-parameter token, and only there", async () => {
    const sub = `auth-${newId()}`;
    createdAuthIds.push(sub);
    const token = await signToken({ sub, email: "sse@example.com" });

    // Unknown submission id -> 404 from the route itself, which proves the auth hook let it
    // through. Without the query-token path this would be a 401.
    const sse = await server.inject({
      method: "GET",
      url: `/api/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV/events?access_token=${encodeURIComponent(token)}`,
    });
    expect(sse.statusCode).toBe(404);

    // The same trick on any other route stays unauthorized.
    const me = await server.inject({
      method: "GET",
      url: `/api/me?access_token=${encodeURIComponent(token)}`,
    });
    expect(me.statusCode).toBe(401);
  });
});
