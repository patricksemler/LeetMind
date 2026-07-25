// Entrypoint: load config, build the server, listen, graceful shutdown on SIGINT/SIGTERM.
import { closePool } from "@leetmind/db";
import { createLogger, loadApiConfig } from "@leetmind/shared";
import { buildDeps } from "./deps.js";
import { buildServer } from "./server.js";
import { notifyBus } from "./sse.js";

const bootLogger = createLogger("api");

async function main(): Promise<void> {
  const config = loadApiConfig();
  const deps = buildDeps(config);

  await notifyBus.start();

  const server = buildServer(deps);
  await server.listen({ port: config.apiPort, host: config.apiHost });
  deps.logger.info({ port: config.apiPort, host: config.apiHost }, "api listening");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ signal }, "shutting down");
    try {
      await server.close();
      await notifyBus.stop();
      await closePool();
      deps.logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      deps.logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  bootLogger.error({ err }, "api failed to start");
  process.exit(1);
});
