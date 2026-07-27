import type { PoolClient } from "pg";
import { newId } from "@leetmind/shared";
import { query, queryOne, queryOneWith, withTransaction } from "./pool.js";
import type { UserRow } from "./types.js";

export async function getUser(id: string): Promise<UserRow | null> {
  return queryOne<UserRow>("select * from users where id = $1", [id]);
}

/** Inserts the user if absent (idempotent), then returns the row. Used to seed the single local user. */
export async function ensureUser(
  id: string,
  handle: string,
  client?: PoolClient,
): Promise<UserRow> {
  const sql = `
    insert into users (id, handle)
    values ($1, $2)
    on conflict (id) do nothing
  `;
  if (client) {
    await client.query(sql, [id, handle]);
  } else {
    await query(sql, [id, handle]);
  }

  const row = client
    ? await queryOneWith<UserRow>(client, "select * from users where id = $1", [id])
    : await queryOne<UserRow>("select * from users where id = $1", [id]);

  if (!row) {
    throw new Error(`ensureUser: failed to read back user ${id} after insert`);
  }
  return row;
}

/** The verified subset of a Supabase Auth JWT that this database cares about. */
export interface AuthIdentity {
  /** JWT `sub` — Supabase's own user UUID. */
  authUserId: string;
  email: string | null;
}

export interface ProvisionOptions {
  /** The pre-accounts single-user row (`SINGLE_USER_ID`). Its history is adopted by the first
   * account whose email equals `legacyClaimEmail`, and by nobody otherwise. */
  legacyUserId?: string;
  /** Opt-in, exact-match (case-insensitive) email allowed to claim `legacyUserId`. Unset means
   * the legacy row is never claimed — the safe default, since a wrong claim silently hands one
   * person's practice history to another account. */
  legacyClaimEmail?: string | null;
}

/** `handle` predates accounts and is `not null unique`, so it has to be derived from something.
 * The email local part is the friendly choice; collisions get a numeric suffix, and an
 * address with no usable local part falls back to the row's own id. */
function handleCandidates(email: string | null, userId: string): string[] {
  const local = (email ?? "").split("@")[0]?.replace(/[^a-zA-Z0-9_.-]/g, "") ?? "";
  if (local.length === 0) return [userId];
  return [local, ...Array.from({ length: 8 }, (_, i) => `${local}${i + 2}`), userId];
}

/**
 * Resolves the local `users` row that owns this identity's practice history, creating it on first
 * sight. Every other table keys off `users.id`, so this is the single place an authenticated
 * request turns a Supabase subject into a local user id.
 *
 * Three outcomes, in priority order:
 *  1. An existing row already bound to `authUserId` — the steady state.
 *  2. The legacy single-user row, if and only if `legacyClaimEmail` is configured AND matches this
 *     identity's email AND that row hasn't already been claimed. This is how the pre-accounts
 *     practice history survives the migration to real accounts instead of being orphaned.
 *  3. A brand-new row with a freshly minted ULID.
 *
 * Concurrency: two first-ever requests for the same subject race here (the web client fires
 * several queries in parallel the moment a session appears). The insert is therefore
 * `on conflict (auth_user_id) do nothing` followed by a re-read, so the loser of the race returns
 * the winner's row rather than throwing a unique-violation 500.
 */
export async function provisionUserForAuth(
  identity: AuthIdentity,
  opts: ProvisionOptions = {},
): Promise<UserRow> {
  const existing = await queryOne<UserRow>("select * from users where auth_user_id = $1", [
    identity.authUserId,
  ]);
  if (existing) return existing;

  return withTransaction(async (client) => {
    // Re-check inside the transaction: another request may have provisioned between the read
    // above and this point.
    const raced = await queryOneWith<UserRow>(
      client,
      "select * from users where auth_user_id = $1",
      [identity.authUserId],
    );
    if (raced) return raced;

    const claimEmail = opts.legacyClaimEmail?.trim().toLowerCase();
    if (
      opts.legacyUserId &&
      claimEmail &&
      identity.email &&
      identity.email.toLowerCase() === claimEmail
    ) {
      const claimed = await queryOneWith<UserRow>(
        client,
        `update users
            set auth_user_id = $2, email = $3
          where id = $1
            and auth_user_id is null
          returning *`,
        [opts.legacyUserId, identity.authUserId, identity.email],
      );
      if (claimed) return claimed;
      // Already claimed by someone else — fall through and mint a fresh row rather than
      // handing over history that is no longer unowned.
    }

    const id = newId();
    for (const handle of handleCandidates(identity.email, id)) {
      const inserted = await queryOneWith<UserRow>(
        client,
        `insert into users (id, handle, auth_user_id, email)
         values ($1, $2, $3, $4)
         on conflict do nothing
         returning *`,
        [id, handle, identity.authUserId, identity.email],
      );
      if (inserted) return inserted;

      // `on conflict do nothing` covers BOTH the handle collision (retry with the next candidate)
      // and the auth_user_id collision (another request won the race) — distinguish them by
      // looking for the subject.
      const bySubject = await queryOneWith<UserRow>(
        client,
        "select * from users where auth_user_id = $1",
        [identity.authUserId],
      );
      if (bySubject) return bySubject;
    }

    throw new Error(`provisionUserForAuth: exhausted handle candidates for ${identity.authUserId}`);
  });
}
