import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const CLI_PATH = path.resolve(__dirname, "cli.ts");

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

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(subcommand: string, stdinPayload: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", CLI_PATH, subcommand], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

const dockerUp = isDockerUp();
const IMAGE = process.env.SANDBOX_PYTHON_IMAGE ?? "leetmind/runner-python:1";
const CPP_IMAGE = process.env.SANDBOX_CPP_IMAGE ?? "leetmind/runner-cpp:1";

describe("sandbox CLI bridge (cli.ts)", () => {
  it("keeps stdout pure JSON when the underlying code logs (no Docker needed)", async () => {
    // Malformed input triggers the `invalid_request` infra-failure path, which calls
    // `logger.error(...)` — a real pino call. pino defaults to writing to fd 1 (stdout), which
    // would otherwise interleave a log line with the JSON result. This asserts BOTH halves of
    // the CONTRACTS §6.1 contract: stdout carries exactly one line of JSON, and the log line
    // that pino produced landed on stderr instead (proving the cli.ts stdout->stderr redirect
    // actually redirected something, not just that nothing was logged at all).
    const result = await runCli("exec", JSON.stringify({ not: "a valid SandboxRequest" }));

    const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0] as string);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("invalid_request");
    expect(result.code).not.toBe(0);

    // the pino log line pino would have put on stdout by default landed on stderr instead
    expect(result.stderr).toContain("invalid_request");
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 20_000);

  it("exits non-zero with a structured error on unknown subcommand, stdout still pure JSON", async () => {
    const result = await runCli("bogus-subcommand", "{}");
    expect(result.code).not.toBe(0);
    const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0] as string);
    expect(parsed.error.code).toBe("bad_usage");
  }, 20_000);

  it("exits non-zero with a structured error on invalid JSON on stdin", async () => {
    const result = await runCli("exec", "{not valid json");
    expect(result.code).not.toBe(0);
    const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0] as string);
    expect(parsed.error.code).toBe("invalid_json");
  }, 20_000);

  describe.skipIf(!dockerUp)("end to end through Docker", () => {
    it("exec-python pipes a request through and returns a normalized accepted result on stdout only", async () => {
      if (!hasImage(IMAGE)) {
        execSync(`bash ${path.join(REPO_ROOT, "scripts/build-images.sh")}`, { stdio: "ignore" });
      }

      const payload = {
        signature: {
          name: "add",
          params: [
            { name: "a", type: "int" },
            { name: "b", type: "int" },
          ],
          returns: "int",
        },
        tests: [{ args: [1, 2], expected: 3 }],
        comparator: { kind: "exact" },
        source: "def add(a, b):\n    return a + b\n",
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 8000, outputLimitBytes: 65536 },
        image: IMAGE,
      };

      const result = await runCli("exec-python", JSON.stringify(payload));

      expect(result.code).toBe(0);
      const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0] as string);
      expect(parsed.verdict).toBe("accepted");
      expect(parsed.passedTests).toBe(1);
      expect(parsed.totalTests).toBe(1);
    }, 60_000);

    it("exec-python still exits 0 on a non-accepted verdict (wrong_answer is data, not a CLI failure)", async () => {
      const payload = {
        signature: {
          name: "add",
          params: [
            { name: "a", type: "int" },
            { name: "b", type: "int" },
          ],
          returns: "int",
        },
        tests: [{ args: [1, 2], expected: 3 }],
        comparator: { kind: "exact" },
        source: "def add(a, b):\n    return a - b\n",
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 8000, outputLimitBytes: 65536 },
        image: IMAGE,
      };

      const result = await runCli("exec-python", JSON.stringify(payload));

      expect(result.code).toBe(0);
      const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0] as string);
      expect(parsed.verdict).toBe("wrong_answer");
    }, 60_000);

    it("exec runs a raw SandboxRequest and returns a SandboxResult on stdout only", async () => {
      const payload = {
        image: IMAGE,
        files: {},
        argv: ["python3", "-c", "print('hi')"],
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 8000, outputLimitBytes: 65536 },
      };

      const result = await runCli("exec", JSON.stringify(payload));

      expect(result.code).toBe(0);
      const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0] as string);
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout).toContain("hi");
    }, 60_000);

    it("exec-cpp compiles and runs, returning a normalized accepted result on stdout only", async () => {
      if (!hasImage(CPP_IMAGE)) {
        execSync(`bash ${path.join(REPO_ROOT, "scripts/build-images.sh")}`, { stdio: "ignore" });
      }

      const payload = {
        signature: {
          name: "add",
          params: [
            { name: "a", type: "int" },
            { name: "b", type: "int" },
          ],
          returns: "int",
        },
        tests: [{ args: [1, 2], expected: 3 }],
        comparator: { kind: "exact" },
        source: "class Solution {\npublic:\n    long long add(long long a, long long b) { return a + b; }\n};\n",
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 8000, outputLimitBytes: 65536 },
        image: CPP_IMAGE,
      };

      const result = await runCli("exec-cpp", JSON.stringify(payload));

      expect(result.code).toBe(0);
      const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0] as string);
      expect(parsed.verdict).toBe("accepted");
      expect(parsed.passedTests).toBe(1);
      expect(parsed.totalTests).toBe(1);
      expect(parsed.compile?.ok).toBe(true);
    }, 60_000);

    it("exec-cpp still exits 0 on a compilation_error (a compile failure is data, not a CLI failure)", async () => {
      const payload = {
        signature: { name: "add", params: [{ name: "a", type: "int" }, { name: "b", type: "int" }], returns: "int" },
        tests: [{ args: [1, 2], expected: 3 }],
        comparator: { kind: "exact" },
        source: "class Solution {\npublic:\n    long long add(long long a, long long b) { return this_is_broken; }\n};\n",
        limits: { memoryMb: 256, cpus: 1, pidsLimit: 64, wallTimeoutMs: 8000, outputLimitBytes: 65536 },
        image: CPP_IMAGE,
      };

      const result = await runCli("exec-cpp", JSON.stringify(payload));

      expect(result.code).toBe(0);
      const stdoutLines = result.stdout.split("\n").filter((l) => l.length > 0);
      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0] as string);
      expect(parsed.verdict).toBe("compilation_error");
    }, 60_000);
  });
});
