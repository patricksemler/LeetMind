// Submission source templates for every (language, outcome-kind) cell in the load profile's mix,
// plus the weighted pickers used to assemble each session's submission sequence.
import type { LoadProfile } from "./config.js";

export type OutcomeKind = "accepted" | "wrong_answer" | "timeout" | "compile_error";
export type LoadLanguage = "python" | "cpp";

/** Weighted random pick from a `{key: weight}` record (weights need not sum to exactly 1). */
export function weightedPick<K extends string>(weights: Record<K, number>, rand: () => number = Math.random): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}

/** The single problem definition the load test seeds and submits against — see seed.ts. A
 * two-integer sum: deliberately trivial algorithmically, because the point of this harness is
 * measuring judge/queue/sandbox overhead, not algorithm runtime (docs/measurements.md's honest-
 * reporting section explains why container startup, not computation, is the expected bottleneck). */
export const SIGNATURE = {
  name: "solve",
  params: [
    { name: "a", type: "int" as const },
    { name: "b", type: "int" as const },
  ],
  returns: "int" as const,
};

export const HIDDEN_TESTS: { args: [number, number]; expected: number }[] = [
  { args: [1, 2], expected: 3 },
  { args: [-5, 5], expected: 0 },
  { args: [0, 0], expected: 0 },
  { args: [1000, -1000], expected: 0 },
  { args: [123456, 654321], expected: 777777 },
];

export function sourceFor(language: LoadLanguage, outcome: OutcomeKind, profile: LoadProfile): string {
  if (language === "python") {
    switch (outcome) {
      case "accepted":
        return "def solve(a, b):\n    return a + b\n";
      case "wrong_answer":
        return "def solve(a, b):\n    return a - b\n";
      case "compile_error":
        // Missing colon -> SyntaxError at import time -> maps to compilation_error
        // (packages/sandbox/src/execute.ts classifyHarnessError / runner.py error_kind).
        return "def solve(a, b)\n    return a + b\n";
      case "timeout":
        // Comfortably longer than profile.sandboxWallTimeoutMs so it always times out.
        return `import time\ndef solve(a, b):\n    time.sleep(${Math.ceil((profile.sandboxWallTimeoutMs * 3) / 1000)})\n    return a + b\n`;
    }
  }
  switch (outcome) {
    case "accepted":
      return "class Solution {\npublic:\n    long long solve(long long a, long long b) { return a + b; }\n};\n";
    case "wrong_answer":
      return "class Solution {\npublic:\n    long long solve(long long a, long long b) { return a - b; }\n};\n";
    case "compile_error":
      // Undefined identifier -> g++ compile failure -> verdict compilation_error.
      return "class Solution {\npublic:\n    long long solve(long long a, long long b) { return a + b + this_symbol_does_not_exist; }\n};\n";
    case "timeout":
      return "class Solution {\npublic:\n    long long solve(long long a, long long b) { while (true) {} return a + b; }\n};\n";
  }
}

/** The submission the lease-recovery-under-load scenario deliberately submits and then kills a
 * worker mid-execution of — real, non-trivial sleep so there's a wide window in which the worker
 * is genuinely inside `docker run` when SIGKILLed (mirrors apps/judge/test/chaos/workerKill.test.ts's
 * rationale for using `time.sleep`, not a busy loop, as the victim). */
export function leaseRecoveryVictimSource(profile: LoadProfile): string {
  return `import time\ndef solve(a, b):\n    time.sleep(${(profile.leaseRecoveryVictimSleepMs / 1000).toFixed(1)})\n    return a + b\n`;
}
