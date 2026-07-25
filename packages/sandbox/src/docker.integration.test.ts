import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { executePython } from "./execute.js";
import { runSandboxed } from "./run.js";
import type { SandboxLimits } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const IMAGE = process.env.SANDBOX_PYTHON_IMAGE ?? "leetmind/runner-python:1";

function isDockerUp(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasImage(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerUp = isDockerUp();

describe.skipIf(!dockerUp)("sandbox docker integration", () => {
  beforeAll(() => {
    if (!hasImage(IMAGE)) {
      execSync(`bash ${path.join(REPO_ROOT, "scripts/build-images.sh")}`, { stdio: "inherit" });
    }
  }, 180_000);

  const baseLimits: SandboxLimits = {
    memoryMb: 256,
    cpus: 1,
    pidsLimit: 64,
    wallTimeoutMs: 8000,
    outputLimitBytes: 65536,
  };

  it("runs a hello-world solution end to end and gets accepted", async () => {
    const result = await executePython({
      signature: {
        name: "add",
        params: [
          { name: "a", type: "int" },
          { name: "b", type: "int" },
        ],
        returns: "int",
      },
      tests: [
        { args: [1, 2], expected: 3 },
        { args: [10, -3], expected: 7 },
      ],
      comparator: { kind: "exact" },
      source: "def add(a, b):\n    return a + b\n",
      limits: baseLimits,
      image: IMAGE,
    });

    expect(result.verdict).toBe("accepted");
    expect(result.passedTests).toBe(2);
    expect(result.totalTests).toBe(2);
    expect(result.raw.sandbox.imageDigest).toBeTruthy();
  }, 30_000);

  it("--network none really blocks a socket connect", async () => {
    const script = [
      "import socket",
      "s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
      "s.settimeout(2)",
      "try:",
      "    s.connect(('8.8.8.8', 53))",
      "    print('connected')",
      "except OSError as e:",
      "    print('blocked:', type(e).__name__)",
    ].join("\n");

    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", script],
      limits: { ...baseLimits, wallTimeoutMs: 6000 },
    });

    expect(result.stdout).toContain("blocked");
    expect(result.stdout).not.toContain("connected");
  }, 20_000);

  it("kills an infinite loop at the host wall timeout", async () => {
    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", "while True:\n    pass"],
      limits: { ...baseLimits, wallTimeoutMs: 2000 },
    });

    expect(result.timedOut).toBe(true);
    // should be close to the 2s budget, nowhere near hanging indefinitely
    expect(result.durationMs).toBeLessThan(9000);
  }, 15_000);

  it("constrains a memory hog to the configured --memory limit, and reports oomKilled: true", async () => {
    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", "b = bytearray(500 * 1024 * 1024)\nb[0] = 1\nprint('should not get here')"],
      limits: { ...baseLimits, memoryMb: 64, wallTimeoutMs: 8000 },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("should not get here");
    // A real cgroup OOM-kill is a raw SIGKILL with no chance for the process to print anything —
    // the old stderr-text heuristic essentially never matched a genuine one, making the
    // `memory_limit` verdict effectively unreachable (QA-PLAN.md §3). This now comes from
    // subscribing to `docker events --filter event=oom`, the real signal, not a text guess.
    expect(result.oomKilled).toBe(true);
  }, 15_000);

  it("enforces --pids-limit against a fork bomb", async () => {
    const script = ["import os", "while True:", "    os.fork()"].join("\n");

    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", script],
      limits: { ...baseLimits, pidsLimit: 16, wallTimeoutMs: 8000 },
    });

    // the fork bomb should be cut short by the pids limit (an uncaught OSError exits the
    // process quickly), not run out the clock waiting for the host wall timeout
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
  }, 15_000);

  it("truncates stdout at the configured cap while still draining a 10MB writer", async () => {
    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", "import sys\nsys.stdout.write('A' * (10 * 1024 * 1024))"],
      limits: { ...baseLimits, outputLimitBytes: 65536, wallTimeoutMs: 8000 },
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(65536);
    // the process itself should complete (we drain, not block its pipe), not be killed
    expect(result.timedOut).toBe(false);
  }, 15_000);

  it("rootfs is read-only outside of /work", async () => {
    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: ["python3", "-c", "open('/etc/leetmind-write-test', 'w')"],
      limits: baseLimits,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Read-only file system|Permission denied/i);
  }, 15_000);

  it("/work is writable", async () => {
    const result = await runSandboxed({
      image: IMAGE,
      files: {},
      argv: [
        "python3",
        "-c",
        "open('/work/test.txt', 'w').write('ok')\nprint(open('/work/test.txt').read())",
      ],
      limits: baseLimits,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 15_000);
});
