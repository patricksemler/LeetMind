import { createHash } from "node:crypto";

/** sha256 hex digest of `input`, used for `submissions.source_hash`. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
