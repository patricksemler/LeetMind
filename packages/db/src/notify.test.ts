import type { PoolClient } from "pg";
import { AppError } from "@leetmind/shared";
import { describe, expect, it, vi } from "vitest";
import { MAX_NOTIFY_PAYLOAD_BYTES, notify } from "./notify.js";
import type { NotifyPayload } from "./types.js";

function fakeClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
}

describe("notify payload-size guard", () => {
  it("sends pg_notify with the JSON-encoded payload when under the limit", async () => {
    const client = fakeClient();
    const payload: NotifyPayload = { type: "status", submission_id: "01ARZ3", status: "running" };

    await notify(client, payload);

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain("pg_notify('leetmind_events'");
    expect(params).toEqual([JSON.stringify(payload)]);
  });

  it("throws an AppError and never calls pg_notify when the serialized payload exceeds the limit", async () => {
    const client = fakeClient();
    // Pad well past the 7900-byte ceiling.
    const payload: NotifyPayload = { type: "status", blob: "x".repeat(MAX_NOTIFY_PAYLOAD_BYTES) };

    await expect(notify(client, payload)).rejects.toThrow(AppError);
    await expect(notify(client, payload)).rejects.toMatchObject({
      code: "notify_payload_too_large",
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("accepts a payload right at the boundary and rejects one byte over it", async () => {
    // Reserve room for the surrounding JSON structure of `{"type":"t","blob":"..."}`.
    const overhead = Buffer.byteLength(JSON.stringify({ type: "t", blob: "" }), "utf8");
    const fill = MAX_NOTIFY_PAYLOAD_BYTES - overhead;

    const okClient = fakeClient();
    await expect(notify(okClient, { type: "t", blob: "x".repeat(fill) })).resolves.toBeUndefined();

    const overClient = fakeClient();
    await expect(notify(overClient, { type: "t", blob: "x".repeat(fill + 1) })).rejects.toThrow(
      AppError,
    );
  });
});
