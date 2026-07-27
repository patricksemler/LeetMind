/**
 * Vitest globalSetup for @leetmind/queue.
 *
 * The queue suite deliberately runs against its OWN throwaway Postgres (port 55433) rather than the
 * shared `leetmind_test` database: it creates and drops the `jobs` table wholesale and exercises
 * lease/reaper timing, so it wants exclusive ownership.
 *
 * Previously that container had to be started by hand. When it was absent, `tryConnect()` returned
 * null and all 14 tests reported as **skipped** — which reads as green in a terminal and in CI
 * while proving nothing. Since these are the reliability tests the whole hand-built-queue decision
 * rests on (PLAN.md §12 risk 4), silently not running them is the worst possible failure mode.
 *
 * This starts the container if it isn't already up, and leaves a pre-existing one alone (so a
 * developer's own container is never torn out from under them).
 */
import { execFileSync } from "node:child_process";

const CONTAINER = "leetmind-queue-test";
const IMAGE = "postgres:17-alpine";
const PORT = "55433";

function docker(args: string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (opts.allowFailure) return "";
    throw err;
  }
}

let startedByUs = false;

export async function setup(): Promise<void> {
  const daemon = docker(["info", "--format", "{{.ServerVersion}}"], { allowFailure: true }).trim();
  if (!daemon) {
    // No Docker at all: leave the suite to skip, but say so loudly rather than silently.
    process.stderr.write(
      "\n[queue] Docker daemon unreachable — queue tests will SKIP, not pass. " +
        "Start Docker Desktop to actually run them.\n\n",
    );
    return;
  }

  const running = docker(["ps", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.Names}}"], {
    allowFailure: true,
  }).trim();
  if (running === CONTAINER) return;

  docker(["rm", "-f", CONTAINER], { allowFailure: true });
  docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_USER=leetmind",
    "-e",
    "POSTGRES_PASSWORD=leetmind",
    "-e",
    "POSTGRES_DB=leetmind_queue_test",
    "-p",
    `${PORT}:5432`,
    IMAGE,
  ]);
  startedByUs = true;

  for (let i = 0; i < 60; i++) {
    const ready = docker(["exec", CONTAINER, "pg_isready", "-U", "leetmind"], {
      allowFailure: true,
    });
    if (ready.includes("accepting connections")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stderr.write(`\n[queue] ${CONTAINER} did not become ready in 30s\n\n`);
}

export async function teardown(): Promise<void> {
  if (startedByUs) docker(["rm", "-f", CONTAINER], { allowFailure: true });
}
