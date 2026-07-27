import { describe, expect, it } from "vitest";
import { parseHarnessOutput, RESULT_SENTINEL } from "./parse.js";

describe("parseHarnessOutput", () => {
  it("parses a well-formed result after the sentinel", () => {
    const stdout = `hello from user code\n${RESULT_SENTINEL}\n{"ok":true,"tests":[{"index":0,"status":"passed","time_ms":1,"memory_kb":10,"output":3}]}\n`;
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.userOutput).toBe("hello from user code\n");
    expect(result.result.ok).toBe(true);
    expect(result.result.tests).toHaveLength(1);
    expect(result.result.tests[0]?.status).toBe("passed");
  });

  it("returns a typed failure when the sentinel is entirely absent (e.g. crash before emit)", () => {
    const stdout = "Traceback (most recent call last):\n  ...\nSegmentation fault\n";
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("sentinel_missing");
    expect(result.userOutput).toBe(stdout);
  });

  it("returns a typed failure when the sentinel is present but the JSON is malformed (e.g. truncated mid-write)", () => {
    const stdout = `${RESULT_SENTINEL}\n{"ok":true,"tests":[{"index":0`;
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("sentinel_json_parse_error");
  });

  it("uses the LAST sentinel occurrence, defeating a spoofed sentinel printed earlier by user code", () => {
    const fakeResult =
      '{"ok":true,"tests":[{"index":0,"status":"passed","time_ms":0,"memory_kb":0,"output":999}]}';
    const realResult =
      '{"ok":true,"tests":[{"index":0,"status":"failed","time_ms":1,"memory_kb":10,"output":42}]}';
    const stdout = `some output\n${RESULT_SENTINEL}\n${fakeResult}\nmore user output after the fake block\n${RESULT_SENTINEL}\n${realResult}\n`;

    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // the real (last) result wins, not the spoofed (first) one
    expect(result.result.tests[0]?.status).toBe("failed");
    expect(result.result.tests[0]?.output).toBe(42);
    // everything up to and including the winning sentinel's preceding content is "user output",
    // which includes the spoofed block itself — that's fine, it's just untrusted text now
    expect(result.userOutput).toContain(fakeResult);
  });

  it("handles a sentinel with no payload after it", () => {
    const stdout = `${RESULT_SENTINEL}\n`;
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("sentinel_empty_payload");
  });

  it("rejects a sentinel followed by a JSON value that isn't an object", () => {
    const stdout = `${RESULT_SENTINEL}\n[1,2,3]\n`;
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("sentinel_json_not_object");
  });

  it("tolerates trailing whitespace after the JSON payload", () => {
    const stdout = `${RESULT_SENTINEL}\n{"ok":true,"tests":[]}   \n\n`;
    const result = parseHarnessOutput(stdout);
    expect(result.ok).toBe(true);
  });
});
