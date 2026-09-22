/**
 * BullMQ 스파이크(#13 코멘트). 워커 설계(`CONSUMES_ATTEMPT`)가 기대는 BullMQ 동작을 실측한다.
 *
 * PLAN.md 기술 선택표는 "`worker.rateLimit()`은 큐 전체를 멈추고 작업의 시도 횟수를 깎지
 * 않는다"고 적었는데 리포 안에 검증이 없었다. 이게 틀리면 속도 제한 세 번 만에 멀쩡한
 * 작업이 DLQ로 가는 설계가 된다. 문서가 아니라 실제 Redis에 물어서 확인한다.
 *
 * 사용: `pnpm -s tsx scripts/spike/bullmq-rate-limit.ts` (리포 루트, Redis가 떠 있어야 한다.
 * 주소는 REDIS_URL, 기본 redis://127.0.0.1:6379). 큐 이름마다 실행 시각을 붙이고 끝나면
 * obliterate로 지운다. 결과는 JSON 줄로 찍는다. 시각(`t`)은 실험 시작부터의 밀리초다.
 */

import { createRequire } from 'node:module';

import { DelayedError, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job, WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const runId = Date.now().toString(36);
const opened: { close: () => Promise<unknown> }[] = [];
const connections: Redis[] = [];

function connection(blocking: boolean): Redis {
  // 워커 연결은 maxRetriesPerRequest가 null이어야 한다(아니면 BullMQ가 던진다).
  const c = new Redis(url, blocking ? { maxRetriesPerRequest: null } : {});
  connections.push(c);
  return c;
}

function queue(label: string): Queue {
  const q = new Queue(`spike-${runId}-${label}`, { connection: connection(false) });
  opened.push({ close: async () => { await q.obliterate({ force: true }); await q.close(); } });
  return q;
}

function worker(q: Queue, processor: (job: Job, token?: string) => Promise<unknown>, opts: Partial<WorkerOptions> = {}): Worker {
  const w = new Worker(q.name, processor, { connection: connection(true), ...opts });
  // 닫기는 큐보다 먼저 해야 obliterate가 active 작업과 겨루지 않는다.
  opened.unshift({ close: () => w.close() });
  return w;
}

function print(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

async function finished(q: Queue, id: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await q.getJobState(id);
    if (state === 'completed' || state === 'failed') return state;
    if (Date.now() > deadline) return `timeout(${state})`;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function summary(q: Queue, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const job = await q.getJob(id);
  print({
    ...extra,
    final: await q.getJobState(id),
    attemptsMade: job?.attemptsMade,
    attemptsStarted: job?.attemptsStarted,
    failedReason: job?.failedReason ?? null,
  });
}

/**
 * 1. rateLimit + RateLimitError를 N번 던진 뒤 성공하는 작업. attempts: 3보다 많이(5번) 던진다.
 * `via`로 worker.rateLimit(6.x에서 deprecated)와 queue.rateLimit을 둘 다 본다.
 */
async function q1(via: 'worker' | 'queue', limiter: boolean, maxStartedAttempts?: number): Promise<void> {
  const label = `q1-${via}-${limiter ? 'limiter' : 'nolimiter'}${maxStartedAttempts === undefined ? '' : `-maxStarted${maxStartedAttempts}`}`;
  const q = queue(label);
  const start = Date.now();
  let calls = 0;
  const w: Worker = worker(
    q,
    async (job) => {
      calls += 1;
      print({ exp: label, t: Date.now() - start, call: calls, attemptsMade: job.attemptsMade, attemptsStarted: job.attemptsStarted });
      if (calls <= 5) {
        if (via === 'worker') await w.rateLimit(200);
        else await q.rateLimit(200);
        throw Worker.RateLimitError();
      }
      return 'ok';
    },
    {
      ...(limiter ? { limiter: { max: 100, duration: 1000 } } : {}),
      ...(maxStartedAttempts === undefined ? {} : { maxStartedAttempts }),
    },
  );
  await q.add('j', {}, { jobId: 'a', attempts: 3, backoff: { type: 'fixed', delay: 50 } });
  await finished(q, 'a');
  await summary(q, 'a', { exp: label, calls, elapsedMs: Date.now() - start });
}

/**
 * 2·3. 큐가 실제로 멈추는가. 작업 a가 rateLimit(1000)을 걸고, b·c·d는 그 사이에 꺼내지는지
 * 시각으로 본다. workers=2면 두 번째 워커(다른 연결, 다른 인스턴스)도 멈추는지 본다.
 */
async function q23(limiter: boolean, workers: 1 | 2): Promise<void> {
  const label = `q23-${limiter ? 'limiter' : 'nolimiter'}-w${workers}`;
  const q = queue(label);
  const start = Date.now();
  let limitedAt: number | undefined;
  const make = (name: string): Worker => {
    const w: Worker = worker(
      q,
      async (job) => {
        const t = Date.now() - start;
        print({ exp: label, t, worker: name, job: job.id, attemptsMade: job.attemptsMade });
        if (job.id === 'a' && limitedAt === undefined) {
          limitedAt = t;
          await w.rateLimit(1000);
          throw Worker.RateLimitError();
        }
        return 'ok';
      },
      { concurrency: 1, autorun: false, ...(limiter ? { limiter: { max: 100, duration: 1000 } } : {}) },
    );
    return w;
  };
  const ws = workers === 1 ? [make('w1')] : [make('w1'), make('w2')];
  // 작업을 먼저 넣고 a가 맨 앞에 오게 한 뒤 워커를 돌린다.
  for (const id of ['a', 'b', 'c', 'd']) await q.add('j', {}, { jobId: id, attempts: 3 });
  for (const w of ws) void w.run();
  for (const id of ['a', 'b', 'c', 'd']) await finished(q, id);
  const jobs = await Promise.all(['a', 'b', 'c', 'd'].map((id) => q.getJob(id)));
  print({
    exp: label,
    limitedAt,
    // processedOn은 마지막으로 꺼낸 시각이다. a는 제한 뒤 다시 꺼낸 시각이 남는다.
    processedOnRel: Object.fromEntries(jobs.map((j) => [j?.id, (j?.processedOn ?? 0) - start])),
    attemptsMade: Object.fromEntries(jobs.map((j) => [j?.id, j?.attemptsMade])),
  });
}

/** 4. moveToDelayed + DelayedError를 3번 한 뒤 성공. attempts: 3. */
async function q4(): Promise<void> {
  const label = 'q4-delayed';
  const q = queue(label);
  const start = Date.now();
  let calls = 0;
  worker(q, async (job, token) => {
    calls += 1;
    print({ exp: label, t: Date.now() - start, call: calls, attemptsMade: job.attemptsMade, attemptsStarted: job.attemptsStarted });
    if (calls <= 3) {
      await job.moveToDelayed(Date.now() + 200, token);
      throw new DelayedError();
    }
    return 'ok';
  });
  await q.add('j', {}, { jobId: 'a', attempts: 3 });
  await finished(q, 'a');
  await summary(q, 'a', { exp: label, calls, elapsedMs: Date.now() - start });
}

/** 5. UnrecoverableError와 보통 Error를 attempts: 3에서 비교한다. */
async function q5(kind: 'unrecoverable' | 'plain'): Promise<void> {
  const label = `q5-${kind}`;
  const q = queue(label);
  const start = Date.now();
  let calls = 0;
  worker(q, async (job) => {
    calls += 1;
    print({ exp: label, t: Date.now() - start, call: calls, attemptsMade: job.attemptsMade });
    const message = 'AUTH_FAILED: HTTP 401 + X-Auth-Failed';
    throw kind === 'unrecoverable' ? new UnrecoverableError(message) : new Error(message);
  });
  await q.add('j', {}, { jobId: 'a', attempts: 3, backoff: { type: 'fixed', delay: 50 } });
  await finished(q, 'a');
  await summary(q, 'a', { exp: label, calls, elapsedMs: Date.now() - start });
}

try {
  print({ bullmq: (createRequire(import.meta.url)('bullmq/package.json') as { version: string }).version, redis: url, runId });
  await q1('worker', true);
  await q1('queue', true);
  await q1('worker', false);
  // 시도 횟수 말고 "시작 횟수" 상한을 걸면 속도 제한도 세는지 본다(#13이 이 옵션을 켜면 안 되는지).
  await q1('worker', true, 3);
  await q23(true, 1);
  await q23(false, 1);
  await q23(true, 2);
  await q23(false, 2);
  await q4();
  await q5('unrecoverable');
  await q5('plain');
} finally {
  for (const o of opened) await o.close();
  for (const c of connections) c.disconnect();
  const probe = new Redis(url);
  // obliterate가 지우지 않는 키가 있는지 이름과 남은 수명(ms)까지 본다.
  const leftover = await probe.keys(`bull:spike-${runId}-*`);
  const ttls = await Promise.all(leftover.map(async (key) => [key, await probe.pttl(key)] as const));
  probe.disconnect();
  print({ cleanup: 'done', leftoverKeys: Object.fromEntries(ttls) });
  process.exit(0);
}
