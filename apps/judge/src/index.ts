// Entrypoint: load config, resolve the sandbox image (fail fast if missing), start the reaper and
// the job-claiming worker loop, graceful shutdown on SIGINT/SIGTERM. CONTRACTS.md apps/judge brief.
import { closePool } from "@leetmind/db";
import { installShutdownHandlers, runWorker, startReaper, type Logger as QueueLogger } from "@leetmind/queue";
import { ensureImage } from "@leetmind/sandbox";
import { createLogger } from "@leetmind/shared";
import { buildJudgeDeps } from "./deps.js";
import { createJudgeHandler } from "./handler.js";
import { startStrandedSweep } from "./reconcile.js";

const bootLogger = createLogger("judge");

async function main(): Promise<void> {
  const deps = buildJudgeDeps();
  const { config, queue, logger } = deps;
  const queueLogger = logger as unknown as QueueLogger;

  // Fail fast at boot with an actionable message (ensureImage's own error text names
  // scripts/build-images.sh) rather than failing confusingly on the first judge job.
  await ensureImage(config.sandboxPythonImage);

  const controller = new AbortController();
  installShutdownHandlers(controller);

  const reaper = startReaper({ queue, signal: controller.signal, logger: queueLogger });
  const strandedSweep = startStrandedSweep(deps, { signal: controller.signal });

  await queue.upsertWorkerHeartbeat(config.judgeWorkerId, "judge", { concurrency: config.judgeConcurrency });

  logger.info(
    { worker_id: config.judgeWorkerId, concurrency: config.judgeConcurrency, image: config.sandboxPythonImage },
    "judge worker starting",
  );

  await runWorker({
    queue,
    kinds: ["judge"],
    concurrency: config.judgeConcurrency,
    handler: createJudgeHandler(deps),
    logger: queueLogger,
    workerId: config.judgeWorkerId,
    signal: controller.signal,
  });

  reaper.stop();
  strandedSweep.stop();
  await closePool();
  logger.info("judge worker shut down");
}

main().catch((err: unknown) => {
  bootLogger.error({ err }, "judge worker failed to start");
  process.exit(1);
});
