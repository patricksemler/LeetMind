import type { PoolClient } from "pg";
import { query, queryOne, queryOneWith } from "./pool.js";
import type { UserRow } from "./types.js";

export async function getUser(id: string): Promise<UserRow | null> {
  return queryOne<UserRow>("select * from users where id = $1", [id]);
}

/** Inserts the user if absent (idempotent), then returns the row. Used to seed the single local user. */
export async function ensureUser(id: string, handle: string, client?: PoolClient): Promise<UserRow> {
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
