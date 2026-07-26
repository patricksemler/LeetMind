/**
 * OOM detection subsystem for a running/finished sandbox container — split out of `run.ts` since
 * it is a self-contained pair of collaborators (a `docker events` subscriber plus a stderr-pattern
 * fallback) around one concern, independent of process-spawning/timeout/output-capture concerns
 * that `run.ts` still owns.
 */
import { spawn } from "node:child_process";
import { createLogger } from "@leetmind/shared";

const logger = createLogger("sandbox");

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
export function looksLikeOomFallback(exitCode: number | null, stderr: string, timedOut: boolean): boolean {
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
export function watchForOomEvent(dockerBin: string, containerName: string): { stop: () => Promise<boolean> } {
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
        const timers: ReturnType<typeof setTimeout>[] = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          for (const t of timers) clearTimeout(t);
          resolve(oomSeen);
        };
        // The child may already be gone (a bounced Docker daemon closes every `docker events`
        // stream): its `close` fired before stop() was called, so listeners registered below
        // would never run and this promise would hang the handler forever — before its terminal
        // write, with the per-job heartbeat still extending the lease, so neither the reaper nor
        // the stranded-submission reconciler would ever recover it.
        if (child.exitCode !== null || child.signalCode !== null) {
          finish();
          return;
        }
        child.once("close", finish);
        child.once("error", finish);
        // `docker events` streams forever until told to stop; SIGTERM is usually enough, but it
        // doesn't always land promptly, so force it shortly after if `close` hasn't fired yet —
        // and resolve unconditionally after that as a last-resort backstop, because a wedged
        // watcher must never outrank delivering the verdict.
        try {
          child.kill("SIGTERM");
        } catch {
          finish();
          return;
        }
        timers.push(
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, 500),
        );
        timers.push(setTimeout(finish, 2000));
        for (const t of timers) t.unref?.();
      }),
  };
}
