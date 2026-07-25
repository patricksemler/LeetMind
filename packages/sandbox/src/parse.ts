/**
 * Harness result protocol parsing — CONTRACTS §6.
 *
 * The in-container program prints arbitrary user output first, then a single sentinel line,
 * then one JSON object. The host parses the LAST occurrence of the sentinel: user code (or a
 * malicious solution) could print a line that looks exactly like the sentinel block earlier in
 * its output trying to spoof a fake result, but the *real* harness always writes the genuine
 * sentinel + result last, so taking the last occurrence defeats that trivially. Anything before
 * the winning sentinel — including any spoofed attempt — is just user output.
 */
import type { HarnessResult } from "./types.js";

export const RESULT_SENTINEL = "<<<LEETMIND_RESULT>>>";

export type ParsedHarnessOutput =
  | { ok: true; userOutput: string; result: HarnessResult }
  | { ok: false; userOutput: string; error: string };

export function parseHarnessOutput(stdout: string): ParsedHarnessOutput {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx === -1) {
    return { ok: false, userOutput: stdout, error: "sentinel_missing" };
  }

  const userOutput = stdout.slice(0, idx);
  const afterSentinel = stdout.slice(idx + RESULT_SENTINEL.length);
  const jsonText = afterSentinel.replace(/^\r?\n/, "").trim();

  if (jsonText.length === 0) {
    return { ok: false, userOutput, error: "sentinel_empty_payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      userOutput,
      error: `sentinel_json_parse_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, userOutput, error: "sentinel_json_not_object" };
  }

  return { ok: true, userOutput, result: parsed as HarnessResult };
}
