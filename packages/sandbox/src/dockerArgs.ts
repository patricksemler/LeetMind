/**
 * Docker invocation config — CONTRACTS §6.
 *
 * Config resolution (work dir / docker binary) and the pure `docker run` argv builder, split out
 * of `run.ts` because both are config-resolving/pure rather than process-spawning: `buildDockerArgs`
 * in particular needs to be snapshot-testable without spawning docker, which is easiest to keep
 * true in a module that doesn't otherwise import `node:child_process`.
 */
import { loadSandboxConfig } from "@leetmind/shared";
import type { SandboxLimits } from "./types.js";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * `loadSandboxConfig` reads SANDBOX_* env vars via zod and every field has a documented default
 * (CONTRACTS §2), so it never throws for a missing var — but it's still wrapped defensively in
 * case that ever changes, so a `runSandboxed` call whose `req.limits` already fully specifies
 * what it needs can't be broken by config loading.
 */
export function resolveWorkDir(): string {
  try {
    return loadSandboxConfig().workDir;
  } catch {
    return process.env.SANDBOX_WORK_DIR ?? "/tmp/leetmind-sandbox";
  }
}

export function resolveDockerBin(): string {
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
 * `--label leetmind.sandbox=1` (not specified by the contract, added so the host's wall-timeout
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
    "leetmind.sandbox=1",
    "--name",
    name,
    image,
    ...argv,
  ];
}
