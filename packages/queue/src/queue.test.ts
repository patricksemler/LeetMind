import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Queue } from './queue.js';
import { insertJobRaw, setupSchema, truncateAll, tryConnect } from './test-fixture.js';

function testId(prefix = 'j'): string {
  return `${prefix}_${randomUUID()}`;
}

const pool = await tryConnect();

describe.skipIf(pool === null)('Queue (integration, real Postgres)', () => {
  const p = pool as Pool;
  let queue: Queue;

  beforeAll(async () => {
    await setupSchema(p);
  });

  beforeEach(async () => {
    await truncateAll(p);
    queue = new Queue(p, { leaseSeconds: 30 });
  });

  afterAll(async () => {
    await p.end();
  });

  it('1. priority ordering: judge before verify before generate, FIFO within a priority', async () => {
    const base = Date.now();
    const at = (offsetMs: number) => new Date(base + offsetMs);

    // Insert out of priority order, with explicit created_at to make FIFO
    // within a priority class deterministic (wall-clock now() at insert time
    // is not reliable at millisecond granularity).
    const genA = testId('gen');
    const genB = testId('gen');
    const verifyA = testId('verify');
    const judgeA = testId('judge');
    const judgeB = testId('judge');

    await insertJobRaw(p, { id: genA, kind: 'generate', priority: 100, createdAt: at(0) });
    await insertJobRaw(p, { id: genB, kind: 'generate', priority: 100, createdAt: at(10) });
    await insertJobRaw(p, { id: verifyA, kind: 'verify', priority: 50, createdAt: at(5) });
    await insertJobRaw(p, { id: judgeA, kind: 'judge', priority: 10, createdAt: at(20) });
    await insertJobRaw(p, { id: judgeB, kind: 'judge', priority: 10, createdAt: at(2) });

    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await queue.claim(['judge', 'verify', 'generate'], 'w1');
      expect(job).not.toBeNull();
      order.push(job!.id);
    }

    // judge (priority 10): FIFO -> judgeB (created earlier) then judgeA
    // verify (priority 50): verifyA
    // generate (priority 100): FIFO -> genA then genB
    expect(order).toEqual([judgeB, judgeA, verifyA, genA, genB]);

    // Queue now empty for these kinds.
    expect(await queue.claim(['judge', 'verify', 'generate'], 'w1')).toBeNull();
  });

  it('2. for update skip locked: concurrent claimers never get the same job', async () => {
    const N = 50;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = testId('gen');
      ids.push(id);
      await insertJobRaw(p, {
        id,
        kind: 'generate',
        priority: 100,
        createdAt: new Date(Date.now() + i),
      });
    }

    const claimers = 4;
    const claimedByAll: string[] = [];

    async function claimLoop(workerId: string): Promise<string[]> {
      const claimed: string[] = [];
      while (true) {
        const job = await queue.claim(['generate'], workerId);
        if (!job) break;
        claimed.push(job.id);
      }
      return claimed;
    }

    const results = await Promise.all(
      Array.from({ length: claimers }, (_, i) => claimLoop(`worker-${i}`)),
    );
    for (const r of results) claimedByAll.push(...r);

    expect(claimedByAll.length).toBe(N);
    expect(new Set(claimedByAll).size).toBe(N);
    expect(new Set(claimedByAll)).toEqual(new Set(ids));
  });

  it('3. transactional enqueue: rollback -> no job row', async () => {
    const client = await p.connect();
    let enqueued: Awaited<ReturnType<Queue['enqueue']>> = null;
    try {
      await client.query('begin');
      enqueued = await queue.enqueue(client, {
        kind: 'judge',
        payload: { submission_id: testId('sub') },
      });
      expect(enqueued).not.toBeNull();
      await client.query('rollback');
    } finally {
      client.release();
    }

    const found = await queue.getJob(enqueued!.id);
    expect(found).toBeNull();
  });

  it('transactional enqueue: commit -> job row persists', async () => {
    const client = await p.connect();
    let enqueued: Awaited<ReturnType<Queue['enqueue']>> = null;
    try {
      await client.query('begin');
      enqueued = await queue.enqueue(client, {
        kind: 'judge',
        payload: { submission_id: testId('sub') },
      });
      await client.query('commit');
    } finally {
      client.release();
    }

    const found = await queue.getJob(enqueued!.id);
    expect(found).not.toBeNull();
    expect(found!.status).toBe('queued');
  });

  it('4. idempotency: duplicate key -> second enqueue returns null, one row', async () => {
    const key = `judge:${testId('sub')}`;
    const first = await queue.enqueue(p, {
      kind: 'judge',
      payload: { a: 1 },
      idempotencyKey: key,
    });
    const second = await queue.enqueue(p, {
      kind: 'judge',
      payload: { a: 2 },
      idempotencyKey: key,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const { rows } = await p.query('select count(*)::int as c from jobs where idempotency_key=$1', [
      key,
    ]);
    expect(rows[0].c).toBe(1);
  });

  it('5. lease expiry + reaper: expired lease is requeued and re-claimable, well under 10s', async () => {
    const enqueued = await queue.enqueue(p, { kind: 'generate', payload: {} });
    expect(enqueued).not.toBeNull();

    const start = Date.now();

    const claimed = await queue.claim(['generate'], 'worker-dead');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(enqueued!.id);
    expect(claimed!.attempts).toBe(1);

    // Simulate the lease expiring (worker died before finishing / heartbeating).
    await p.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [
      claimed!.id,
    ]);

    const reapedCount = await queue.reapExpired();
    expect(reapedCount).toBe(1);

    const afterReap = await queue.getJob(claimed!.id);
    expect(afterReap!.status).toBe('queued');
    expect(afterReap!.leased_by).toBeNull();

    const reclaimed = await queue.claim(['generate'], 'worker-2');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(enqueued!.id);
    expect(reclaimed!.attempts).toBe(2);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
  });

  it('6. heartbeat extends the lease; after reaper steals the job, heartbeat returns false', async () => {
    const enqueued = await queue.enqueue(p, { kind: 'generate', payload: {} });
    const claimed = await queue.claim(['generate'], 'worker-a');
    expect(claimed).not.toBeNull();

    const before = await queue.getJob(claimed!.id);
    await new Promise((r) => setTimeout(r, 20));
    const ok = await queue.heartbeat(claimed!.id, 'worker-a');
    expect(ok).toBe(true);
    const after = await queue.getJob(claimed!.id);
    expect(after!.lease_expires_at!.getTime()).toBeGreaterThan(before!.lease_expires_at!.getTime());

    // Now simulate the reaper stealing it (lease expired).
    await p.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [
      claimed!.id,
    ]);
    const reaped = await queue.reapExpired();
    expect(reaped).toBe(1);

    const stolen = await queue.heartbeat(claimed!.id, 'worker-a');
    expect(stolen).toBe(false);

    expect(enqueued!.id).toBe(claimed!.id);
  });

  it('7. poison job: failing max_attempts times lands in dead, not queued', async () => {
    const enqueued = await queue.enqueue(p, {
      kind: 'generate',
      payload: {},
      maxAttempts: 2,
    });
    expect(enqueued).not.toBeNull();

    // Attempt 1: claim, fail -> retry (attempts=1 < max_attempts=2)
    const claim1 = await queue.claim(['generate'], 'worker-1');
    expect(claim1!.attempts).toBe(1);
    const result1 = await queue.fail(claim1!.id, 'worker-1', 'boom 1', { retryInMs: 0 });
    expect(result1).toBe('retry');

    const afterFail1 = await queue.getJob(claim1!.id);
    expect(afterFail1!.status).toBe('queued');

    // Attempt 2: claim, fail -> dead (attempts=2 >= max_attempts=2)
    const claim2 = await queue.claim(['generate'], 'worker-1');
    expect(claim2!.attempts).toBe(2);
    const result2 = await queue.fail(claim2!.id, 'worker-1', 'boom 2', { retryInMs: 0 });
    expect(result2).toBe('dead');

    const final = await queue.getJob(claim2!.id);
    expect(final!.status).toBe('dead');
    expect(final!.last_error).toBe('boom 2');

    // Dead jobs are never re-claimable.
    const shouldBeNull = await queue.claim(['generate'], 'worker-1');
    expect(shouldBeNull).toBeNull();
  });

  it('stats(): reports per-kind counts and dead jobs', async () => {
    await queue.enqueue(p, { kind: 'judge', payload: {} });
    await queue.enqueue(p, { kind: 'judge', payload: {} });
    const dead = await queue.enqueue(p, { kind: 'verify', payload: {}, maxAttempts: 1 });
    const claimedDead = await queue.claim(['verify'], 'w');
    await queue.fail(claimedDead!.id, 'w', 'dead on arrival');

    const stats = await queue.stats();
    const judgeStats = stats.kinds.find((k) => k.kind === 'judge');
    expect(judgeStats?.counts.queued).toBe(2);

    expect(stats.dead_count).toBeGreaterThanOrEqual(1);
    expect(stats.recent_dead.some((j) => j.id === dead!.id)).toBe(true);
    // recent_dead now carries an explicit age (ms since it went dead), the "enough context to
    // debug" shape M4's poison-job parking requires.
    const deadEntry = stats.recent_dead.find((j) => j.id === dead!.id);
    expect(deadEntry?.age_ms).toBeGreaterThanOrEqual(0);
    expect(deadEntry?.kind).toBe('verify');
    expect(deadEntry?.last_error).toBe('dead on arrival');
  });

  it('stats(): lease_recovery buckets a reaped-then-recovered job as recovered, a reaped-then-dead job as dead_after_reap', async () => {
    // Job A: crashes once, gets reaped, second claim acks it -> 'recovered'.
    const jobA = await queue.enqueue(p, { kind: 'judge', payload: {} });
    await queue.claim(['judge'], 'worker-dead-a');
    await p.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [jobA!.id]);
    await queue.reapExpired();
    const reclaimedA = await queue.claim(['judge'], 'worker-b');
    expect(reclaimedA!.id).toBe(jobA!.id);
    await queue.ack(jobA!.id, 'worker-b');

    // Job B: crashes with attempts already at max_attempts (maxAttempts=1, and claim() always
    // increments attempts), so the reaper's own CTE deadens it directly (the `expired.attempts >=
    // expired.max_attempts` branch) in the SAME statement that writes the 'lease expired' marker
    // -- unlike a subsequent separate fail() call, this does NOT overwrite it. -> 'dead_after_reap'.
    const jobB = await queue.enqueue(p, { kind: 'judge', payload: {}, maxAttempts: 1 });
    await queue.claim(['judge'], 'worker-dead-b');
    await p.query(`update jobs set lease_expires_at = now() - interval '1 second' where id=$1`, [jobB!.id]);
    await queue.reapExpired();
    const deadB = await queue.getJob(jobB!.id);
    expect(deadB!.status).toBe('dead');
    expect(deadB!.last_error).toBe('lease expired');

    // Job C: never reaped at all (happy path) -> must NOT be counted in lease_recovery.
    const jobC = await queue.enqueue(p, { kind: 'judge', payload: {} });
    await queue.claim(['judge'], 'worker-d');
    await queue.ack(jobC!.id, 'worker-d');

    const stats = await queue.stats();
    expect(stats.lease_recovery.reaped_total).toBe(2);
    expect(stats.lease_recovery.recovered).toBe(1);
    expect(stats.lease_recovery.dead_after_reap).toBe(1);
    expect(stats.lease_recovery.still_pending).toBe(0);
  });

  it('listDeadJobs(): fuller listing than stats().recent_dead, filterable by kind', async () => {
    const deadJudge = await queue.enqueue(p, { kind: 'judge', payload: {}, maxAttempts: 1 });
    await queue.fail((await queue.claim(['judge'], 'w'))!.id, 'w', 'judge poison');
    const deadVerify = await queue.enqueue(p, { kind: 'verify', payload: {}, maxAttempts: 1 });
    await queue.fail((await queue.claim(['verify'], 'w'))!.id, 'w', 'verify poison');

    const all = await queue.listDeadJobs();
    expect(all.map((j) => j.id).sort()).toEqual([deadJudge!.id, deadVerify!.id].sort());

    const judgeOnly = await queue.listDeadJobs({ kind: 'judge' });
    expect(judgeOnly.map((j) => j.id)).toEqual([deadJudge!.id]);
    expect(judgeOnly[0]?.last_error).toBe('judge poison');
    expect(judgeOnly[0]?.attempts).toBe(1);
  });

  it('requeueDeadJob(): resets attempts and makes a dead job claimable again; refuses non-dead jobs', async () => {
    await queue.enqueue(p, { kind: 'judge', payload: {}, maxAttempts: 1 });
    const claimed = await queue.claim(['judge'], 'w');
    await queue.fail(claimed!.id, 'w', 'boom');
    const dead = await queue.getJob(claimed!.id);
    expect(dead!.status).toBe('dead');

    const requeued = await queue.requeueDeadJob(claimed!.id);
    expect(requeued).not.toBeNull();
    expect(requeued!.status).toBe('queued');
    expect(requeued!.attempts).toBe(0);
    expect(requeued!.last_error).toContain('manually requeued');

    // Now claimable again, and can run to a normal ack.
    const reclaimed = await queue.claim(['judge'], 'w2');
    expect(reclaimed!.id).toBe(claimed!.id);
    expect(reclaimed!.attempts).toBe(1);
    await queue.ack(reclaimed!.id, 'w2');

    // Refuses to touch a job that isn't dead (e.g. one currently queued).
    const live = await queue.enqueue(p, { kind: 'judge', payload: {} });
    const refused = await queue.requeueDeadJob(live!.id);
    expect(refused).toBeNull();
    const untouched = await queue.getJob(live!.id);
    expect(untouched!.status).toBe('queued');

    // Unknown id -> null, not a throw.
    expect(await queue.requeueDeadJob('does-not-exist')).toBeNull();
  });
});
