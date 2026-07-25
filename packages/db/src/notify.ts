import type { PoolClient } from "pg";
import { AppError } from "@leetmind/shared";
import type { NotifyPayload } from "./types.js";

/**
 * CONTRACTS.md §4.5: "Notify payload must stay under 7900 bytes" — Postgres's own NOTIFY payload
 * limit is 8000 bytes; we stay comfortably under it.
 */
export const MAX_NOTIFY_PAYLOAD_BYTES = 7900;

/**
 * Emits `select pg_notify('leetmind_events', $1)` with `payload` JSON-encoded. Must be called
 * inside the same transaction as the state write it announces (CONTRACTS.md §4.5) — callers pass
 * the transaction's `client`, never a pooled connection outside a transaction.
 */
export async function notify(client: PoolClient, payload: NotifyPayload): Promise<void> {
  const serialized = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(serialized, "utf8");

  if (byteLength > MAX_NOTIFY_PAYLOAD_BYTES) {
    throw new AppError(
      "notify_payload_too_large",
      `pg_notify payload of ${byteLength} bytes exceeds the ${MAX_NOTIFY_PAYLOAD_BYTES}-byte limit`,
      500,
      { type: payload.type, byteLength },
    );
  }

  await client.query("select pg_notify('leetmind_events', $1)", [serialized]);
}
