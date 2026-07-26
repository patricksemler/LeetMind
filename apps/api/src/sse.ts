// LISTEN/NOTIFY fanout — the spine of the SSE UX (docs/CONTRACTS.md §4.5).
//
// ONE dedicated long-lived `pg.Client` (never a pooled connection — LISTEN state must live on a
// single, stable backend connection) issues `LISTEN leetmind_events`. Every notification is
// parsed + validated against `NotifyPayloadSchema` and dispatched only to the subscribers
// registered for that `submission_id`. Reconnects with backoff if the connection drops.
import { Client } from "pg";
import { createLogger, loadBaseConfig, NOTIFY_CHANNEL, NotifyPayloadSchema, type NotifyPayload } from "@leetmind/shared";

const logger = createLogger("api-sse");

const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_DELAY_MS = 500;

type NotifySubscriber = (type: string, payload: NotifyPayload) => void;

class NotifyBus {
  private client: Client | null = null;
  private readonly subscribers = new Map<string, Set<NotifySubscriber>>();
  private reconnectAttempt = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      await client.end().catch(() => {});
    }
  }

  /** Registers `fn` to receive every notification for `submissionId`. Returns an unsubscribe fn. */
  subscribe(submissionId: string, fn: NotifySubscriber): () => void {
    let set = this.subscribers.get(submissionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(submissionId, set);
    }
    set.add(fn);
    return () => {
      const current = this.subscribers.get(submissionId);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.subscribers.delete(submissionId);
    };
  }

  /** Number of distinct submissions with at least one live subscriber. Test/debug use only. */
  get activeSubmissionCount(): number {
    return this.subscribers.size;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const config = loadBaseConfig();
    const client = new Client({ connectionString: config.databaseUrl });
    this.client = client;

    client.on("notification", (msg) => this.handleNotification(msg.payload));
    client.on("error", (err) => {
      logger.warn({ err }, "LISTEN client error; scheduling reconnect");
      this.scheduleReconnect();
    });
    client.on("end", () => {
      if (!this.stopped) {
        logger.warn("LISTEN client connection ended unexpectedly; scheduling reconnect");
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
      this.reconnectAttempt = 0;
      logger.info({ channel: NOTIFY_CHANNEL }, "LISTEN established");
    } catch (err) {
      logger.warn({ err }, "failed to establish LISTEN connection; scheduling reconnect");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => logger.error({ err }, "LISTEN reconnect attempt threw"));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private handleNotification(rawPayload: string | undefined): void {
    if (!rawPayload) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch (err) {
      logger.warn({ err }, "failed to JSON-parse notify payload");
      return;
    }

    const result = NotifyPayloadSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn({ issues: result.error.issues }, "notify payload failed schema validation");
      return;
    }

    const notification = result.data;
    if (!notification.submission_id) return;

    const subs = this.subscribers.get(notification.submission_id);
    if (!subs || subs.size === 0) return;
    for (const sub of subs) {
      try {
        sub(notification.type, notification);
      } catch (err) {
        logger.error({ err }, "SSE subscriber callback threw");
      }
    }
  }
}

/** Process-wide singleton: one LISTEN connection shared by every SSE subscriber. */
export const notifyBus = new NotifyBus();
