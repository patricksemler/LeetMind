import type { Queue } from './queue.js';
import type { Logger } from './types.js';

export interface StartReaperOpts {
  queue: Queue;
  intervalMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface ReaperHandle {
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 5000;

/**
 * setInterval-style loop calling queue.reapExpired(). Safe to run in every
 * process concurrently -- reapExpired() uses `for update skip locked` so
 * concurrent reapers never double-process the same expired lease.
 */
export function startReaper(opts: StartReaperOpts): ReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const logger = opts.logger;

  let running = false;
  const tick = () => {
    if (running) return; // don't overlap ticks if reapExpired is slow
    running = true;
    opts.queue
      .reapExpired()
      .then((count) => {
        if (count > 0) {
          logger?.info({ count }, 'reaper: requeued/deadened expired leases');
        }
      })
      .catch((err) => {
        logger?.error({ err }, 'reaper: reapExpired() threw');
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  const stop = () => clearInterval(timer);

  if (opts.signal) {
    if (opts.signal.aborted) {
      stop();
    } else {
      opts.signal.addEventListener('abort', stop, { once: true });
    }
  }

  return { stop };
}
