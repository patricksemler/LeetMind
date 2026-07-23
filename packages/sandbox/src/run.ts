/**
 * `docker run` wrapper — CONTRACTS §6.
 *
 * Materializes a bundle dir, spawns `docker run` with the mandatory flag list (argv array only,
 * never a shell string), enforces the wall timeout from the host side, caps stdout/stderr while
 * still draining the pipes, and cleans up the bundle dir unless ALGOLIFT_KEEP_BUNDLES=1.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { newId, createLogger, loadSandboxConfig } from "@algolift/shared";
import { resolveImageDigest } from "./images.js";
import type { SandboxLimits, SandboxRequest, SandboxResult } from "./types.js";

const logger = createLogger("sandbox");

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * `loadSandboxConfig` reads SANDBOX_* env vars via zod and every field has a documented default
 * (CONTRACTS §2), so it never throws for a missing var — but it's still wrapped defensively in
 * case that ever changes, so a `runSandboxed` call whose `req.limits` already fully specifies
 * what it needs can't be broken by config loading.
 */
function resolveWorkDir(): string {
  try {
    return loadSandboxConfig().workDir;
  } catch {
    return process.env.SANDBOX_WORK_DIR ?? "/tmp/algolift-sandbox";
  }
}

function resolveDockerBin(): string {
  try {
    return loadSandboxConfig().dockerBin;
  } catch {
    return process.env.DOCKER_BIN ?? "docker";
  }
}

// ---------------------------------------------------------------------------
// docker argv construction (CONTRACTS §6 — exact flag list, exact order)
// ---------------------------------------------------------------------------

export interface BuildDockerArgsInput {
  image: string;
  bundleDir: string;
  argv: string[];
  limits: SandboxLimits;
  /** unique per-run container name so the wall-timeout backstop can `docker kill` by name */
  name: string;
}

/**
 * Pure function so the exact flag list/order can be snapshot-tested without spawning docker.
 * Deviations from CONTRACTS §6's mandatory list: `--name <name>` is appended after
 * `--label algolift.sandbox=1` (not specified by the contract, added so the host's wall-timeout
 * backstop can target this exact container instead of relying on the label alone, which could
 * match multiple concurrently-running sandboxes).
 */
export function buildDockerArgs(input: BuildDockerArgsInput): string[] {
  const { image, bundleDir, argv, limits, name } = input;
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/work:rw,size=64m,mode=1777,exec",
    "-v",
    `${bundleDir}:/bundle:ro`,
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--cpus",
    `${limits.cpus}`,
    "--pids-limit",
    `${limits.pidsLimit}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-u",
    "65534:65534",
    "-w",
    "/work",
    "--label",
    "algolift.sandbox=1",
    "--name",
    name,
    image,
    ...argv,
  ];
}

// ---------------------------------------------------------------------------
// Bundle materialization
// ---------------------------------------------------------------------------

function chmodRecursiveAddReadExecute(dir: string): Promise<void> {
  // Not a shell string: argv array passed straight to execve, `chmod` never sees a shell.
  return new Promise((resolve, reject) => {
    const child = spawn("chmod", ["-R", "a+rX", dir], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`chmod -R a+rX ${dir} exited with code ${code}`));
    });
  });
}

async function materializeBundle(files: Record<string, string>, workDir: string): Promise<string> {
  const bundleDir = path.join(workDir, newId());
  await mkdir(bundleDir, { recursive: true, mode: 0o755 });

  for (const [relPath, contents] of Object.entries(files)) {
    const dest = path.join(bundleDir, relPath);
    const rel = path.relative(bundleDir, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Refusing to write bundle file outside the bundle directory: ${relPath}`);
    }
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
    await writeFile(dest, contents, { mode: 0o644 });
  }

  // The container runs as uid 65534, which does not own any of the files we just wrote as the
  // host user. `chmod -R a+rX` grants read (and traverse/execute-on-dirs) to everyone without
  // touching write bits, so the non-root container user can read the bundle but the host user
  // still owns and can clean it up.
  await chmodRecursiveAddReadExecute(bundleDir);

  return bundleDir;
}

// ---------------------------------------------------------------------------
// runSandboxed
// ---------------------------------------------------------------------------

interface ChildRunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function capturingWriter(cap: number): {
  onData: (chunk: Buffer) => void;
  getText: () => string;
  isTruncated: () => boolean;
} {
  let buf = Buffer.alloc(0);
  let truncated = false;
  return {
    onData(chunk: Buffer) {
      if (buf.length >= cap) {
        truncated = true;
        return; // keep draining upstream (the listener itself is what drains the stream) but discard
      }
      const remaining = cap - buf.length;
      if (chunk.length > remaining) {
        truncated = true;
        buf = Buffer.concat([buf, chunk.subarray(0, remaining)]);
      } else {
        buf = Buffer.concat([buf, chunk]);
      }
    },
    getText: () => buf.toString("utf8"),
    isTruncated: () => truncated,
  };
}

function runDockerChild(
  dockerBin: string,
  args: string[],
  limits: SandboxLimits,
  containerName: string,
): Promise<{ outcome: ChildRunOutcome; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutCap = capturingWriter(limits.outputLimitBytes);
    const stderrCap = capturingWriter(limits.outputLimitBytes);

    let timedOut = false;
    let settled = false;

    child.stdout.on("data", stdoutCap.onData);
    child.stderr.on("data", stderrCap.onData);

    const wallTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      // Backstop: the `docker run` client process may die/detach without the container itself
      // stopping (e.g. daemon hiccup), so also kill the container directly by the unique name
      // we gave it. Best-effort — if this fails the container will still be cleaned up by
      // `--rm` once it eventually exits, and its resource limits still bound the blast radius.
      const killer = spawn(dockerBin, ["kill", containerName], { stdio: "ignore" });
      killer.on("error", (err) => {
        logger.warn({ err: String(err), containerName }, "docker kill backstop failed to spawn");
      });
    }, limits.wallTimeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      resolve({
        outcome: {
          exitCode: code,
          signal,
          stdout: stdoutCap.getText(),
          stderr: stderrCap.getText(),
          stdoutTruncated: stdoutCap.isTruncated(),
          stderrTruncated: stderrCap.isTruncated(),
        },
        timedOut,
      });
    });
  });
}

/**
 * Fallback heuristic OOM detector, used only if `watchForOomEvent` below (the real signal)
 * somehow saw nothing — exit code 137 (128 + SIGKILL) combined with a stderr string a Python
 * process typically produces when the OS kills it for memory pressure. This alone was the ONLY
 * signal previously, and it is nearly always wrong: a cgroup OOM-kill is a raw SIGKILL from the
 * kernel with no chance for the process to print anything, so this pattern essentially never
 * matches a real one — `memory_limit` was effectively unreachable. Kept only as a last resort;
 * 137 alone can also mean "we killed it for the wall timeout" (ruled out via `!timedOut`) or an
 * unrelated SIGKILL.
 */
function looksLikeOomFallback(exitCode: number | null, stderr: string, timedOut: boolean): boolean {
  if (timedOut) return false;
  if (exitCode !== 137) return false;
  return /MemoryError|Killed|Out of memory|Cannot allocate memory|OOM/i.test(stderr);
}

/**
 * The real OOM signal: subscribes to `docker events --filter container=<name> --filter event=oom`
 * for the container's own name (assigned via `--name` in `buildDockerArgs`, before `docker run`
 * even starts) and watches for ANY output — Docker's daemon emits an `oom` event the instant the
 * container's cgroup is OOM-killed, well before the container exits/is removed. This is what
 * `docker inspect .State.OOMKilled` would tell you too, but without needing to inspect an already-
 * `--rm`-removed container (CONTRACTS §6 mandates `--rm` in the exact flag list; this sidesteps
 * that entirely rather than fighting it). Call `start()` BEFORE `docker run`, `stop()` after it
 * exits.
 */
function watchForOomEvent(dockerBin: string, containerName: string): { stop: () => Promise<boolean> } {
  let oomSeen = false;
  let spawnFailed = false;

  const child = spawn(dockerBin, ["events", "--filter", `container=${containerName}`, "--filter", "event=oom"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.on("data", () => {
    oomSeen = true;
  });
  child.on("error", (err) => {
    spawnFailed = true;
    logger.warn({ err: String(err), containerName }, "docker events OOM watcher failed to spawn; falling back to the stderr heuristic");
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        if (spawnFailed) {
          resolve(false);
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(oomSeen);
        };
        child.once("close", finish);
        child.once("error", finish);
        // `docker events` streams forever until told to stop; SIGTERM is usually enough, but it
        // doesn't always land promptly, so force it shortly after if `close` hasn't fired yet.
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
          return;
        }
        const forceKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, 500);
        forceKill.unref?.();
        child.once("close", () => clearTimeout(forceKill));
      }),
  };
}

/**
 * Dev-only artificial delay, injected right before `runSandboxed` returns (QA-PLAN.md "Prevent
 * recurrence" §3). A real judge run finishes in ~150-300ms — fast enough that the UI's
 * pending/running intermediate states (`ResultsPanel`'s progress bar, the SSE `status`/`progress`
 * events) have never actually been observed by anyone, dev or QA. Sets no delay unless explicitly
 * opted into via `ALGOLIFT_SANDBOX_ARTIFICIAL_DELAY_MS` (never on by default, so it can never leak
 * into CI or a real judge deployment) — matches the file's existing `ALGOLIFT_KEEP_BUNDLES`
 * escape-hatch convention.
 */
function artificialDelayMs(): number {
  const raw = process.env.ALGOLIFT_SANDBOX_ARTIFICIAL_DELAY_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSandboxed(req: SandboxRequest): Promise<SandboxResult> {
  const { image, files, argv, limits, correlationId } = req;
  const workDir = resolveWorkDir();
  const dockerBin = resolveDockerBin();
  const keepBundles = process.env.ALGOLIFT_KEEP_BUNDLES === "1";

  await mkdir(workDir, { recursive: true });
  const bundleDir = await materializeBundle(files, workDir);
  const containerName = `algolift-sbx-${newId()}`;

  logger.info(
    { correlationId, image, containerName, bundleDir },
    "sandbox run starting",
  );

  const start = process.hrtime.bigint();
  try {
    const dockerArgs = buildDockerArgs({ image, bundleDir, argv, limits, name: containerName });

    // Started BEFORE `docker run` — the container doesn't exist yet, but `docker events` filters
    // by name and starts watching from "now", so it's already listening by the time `--name`
    // makes the container come into existence and (if it does) get OOM-killed. Stopped in this
    // `finally`, exactly once, regardless of whether `runDockerChild` itself throws — otherwise a
    // `docker run` spawn failure would leak the watcher process.
    const oomWatcher = watchForOomEvent(dockerBin, containerName);
    let oomEventSeen = false;
    let outcome: ChildRunOutcome;
    let timedOut: boolean;
    try {
      ({ outcome, timedOut } = await runDockerChild(dockerBin, dockerArgs, limits, containerName));
    } finally {
      oomEventSeen = await oomWatcher.stop();
    }
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    const oomKilled = oomEventSeen || looksLikeOomFallback(outcome.exitCode, outcome.stderr, timedOut);
    const imageDigest = await resolveImageDigest(image);

    logger.info(
      {
        correlationId,
        image,
        containerName,
        exitCode: outcome.exitCode,
        timedOut,
        oomKilled,
        durationMs,
      },
      "sandbox run finished",
    );

    const delayMs = artificialDelayMs();
    if (delayMs > 0) {
      logger.info({ correlationId, containerName, delayMs }, "ALGOLIFT_SANDBOX_ARTIFICIAL_DELAY_MS: holding before returning");
      await sleep(delayMs);
    }

    return {
      exitCode: outcome.exitCode,
      timedOut,
      oomKilled,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      durationMs,
      imageDigest,
      // maxRssKb intentionally left unset here: with `--rm` there is no cheap, race-free way to
      // read cgroup memory.peak for a container that has already exited and been removed. For
      // Python, per-test memory is instead reported by the harness itself
      // (resource.getrusage(RUSAGE_SELF).ru_maxrss inside runner.py) and surfaced via
      // ExecutionResult.perTest[].memoryKb / memoryKb in execute.ts, which is both more
      // accurate (per test, not just process-wide) and doesn't need the container alive.
      usage: {},
    };
  } finally {
    if (!keepBundles) {
      await rm(bundleDir, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn({ err: String(err), bundleDir }, "failed to clean up sandbox bundle dir");
      });
    }
  }
}
