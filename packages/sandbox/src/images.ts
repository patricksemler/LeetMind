/**
 * Sandbox image resolution — CONTRACTS §6.
 *
 * `resolveImageDigest` shells `docker image inspect --format '{{index .RepoDigests 0}}'` and
 * falls back to `.Id`. Every `execution_attempts` row is expected to record the result.
 */
import { spawn } from "node:child_process";

function dockerBin(): string {
  return process.env.DOCKER_BIN ?? "docker";
}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDocker(args: string[]): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(dockerBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Memoized per image per process — repeated calls for the same image never re-shell docker. */
const digestCache = new Map<string, Promise<string | null>>();

/**
 * Resolves the content-addressed digest for a locally-present image. Prefers the first
 * RepoDigest (stable across retags of the same content); falls back to the image ID when no
 * RepoDigest is recorded (e.g. an image that was only ever `docker build`'t locally and never
 * pushed/pulled from a registry — RepoDigests is empty in that case).
 */
export async function resolveImageDigest(image: string): Promise<string | null> {
  const cached = digestCache.get(image);
  if (cached) return cached;

  const promise = (async (): Promise<string | null> => {
    const primary = await runDocker([
      "image",
      "inspect",
      image,
      "--format",
      "{{index .RepoDigests 0}}",
    ]);
    const primaryOut = primary.stdout.trim();
    if (primary.code === 0 && primaryOut && primaryOut !== "<no value>") {
      return primaryOut;
    }

    const fallback = await runDocker(["image", "inspect", image, "--format", "{{.Id}}"]);
    const fallbackOut = fallback.stdout.trim();
    if (fallback.code === 0 && fallbackOut) {
      return fallbackOut;
    }

    return null;
  })();

  digestCache.set(image, promise);
  return promise;
}

/**
 * Throws a clear, actionable error when `image` isn't present locally, naming
 * scripts/build-images.sh as the fix. Callers (judge, content) should call this once at boot
 * per configured image, not on every execution.
 */
export async function ensureImage(image: string): Promise<void> {
  const result = await runDocker(["image", "inspect", image, "--format", "{{.Id}}"]);
  if (result.code !== 0) {
    throw new Error(
      `Sandbox image "${image}" is not present locally. Build it with ` +
        `\`bash scripts/build-images.sh\` (see docker/runner-python/Dockerfile and ` +
        `docker/runner-cpp/Dockerfile) before running the judge or content worker.`,
    );
  }
}
