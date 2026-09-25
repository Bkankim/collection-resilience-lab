/**
 * 큐 워커 통합 테스트. 실제 Redis와 실제 대상 서버(`buildApp`을 빈 포트에 띄운 것)에 붙고,
 * 워커는 진입점과 같은 `createCollectionWorker`로 같은 프로세스 안에 띄운다.
 *
 * 실제 서버를 쓰는 이유: 처분(무엇을 던지는가)이 맞아도 BullMQ가 그것을 어떻게 세는지,
 * 속도 제한이 다른 워커까지 멈추는지는 Redis 스크립트와 실제 요청 시각으로만 보인다.
 * 대상 서버로 만들기 어려운 실패(TRANSIENT 3회, 세션 토큰이 실린 UNKNOWN, 속도 제한을
 * attempts보다 많이)는 닫힌 포트나 가짜 수집 함수로 만든다.
 *
 * 대상 서버 요청은 `onResponse` 훅으로 시각·경로·상태를 모은다. "로그인 시도 1회", "제한
 * 창 동안 요청 0건"을 서버 쪽에서 센다. 워커 로그만 보면 워커가 보냈다고 믿는 것을 셀 뿐이다.
 *
 * `REDIS_URL`이 없으면 건너뛴다. CI에서는 없으면 던진다(`redis-for-tests.ts`).
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../target/app.js';
import { buildLedger } from '../../target/transactions.js';
import type { Failure } from '../client/classify.js';
import { systemClock } from '../client/clock.js';
import type { Transaction } from '../client/parse.js';
import { collect } from '../client/session.js';
import type { CollectOptions, CollectResult } from '../client/session.js';
import { createUndiciTransport } from '../client/transport.js';
import type { Transport } from '../client/transport.js';
import {
  COLLECT_JOB,
  COLLECT_JOB_OPTIONS,
  authBlockKey,
  createRedis,
  deadLetterQueueName,
  jobIdOf,
  parseFailedReason,
  progressKey,
  readResults,
  resultsKey,
} from '../queue.js';
import type { CollectionJobData, DeadLetterData } from '../queue.js';
import { redisUrlForTests } from '../redis-for-tests.js';
import { createCollectionWorker } from './process.js';
import type { CollectionWorkerOptions, ProcessorDeps, ProcessorResult, WorkerEvent } from './process.js';

const REDIS_URL = redisUrlForTests();
const suite = REDIS_URL === undefined ? describe.skip : describe;

const DEMO01 = { loginId: 'demo01', accountNo: '000-11-222333', count: 137 };
const DEMO02 = { loginId: 'demo02', accountNo: '000-44-555666', count: 12 };
type Demo = typeof DEMO01;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Hit = { t: number; method: string; path: string; status: number; page?: number };

/** 대상 서버를 빈 포트에 띄운다. 관리 API는 요청 기록에서 뺀다(차단 판정도 받지 않는다). */
async function startTarget() {
  const app = buildApp();
  const hits: Hit[] = [];
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (path.startsWith('/admin')) return;
    const page = /[?&]page=(\d+)/.exec(request.url)?.[1];
    hits.push({ t: Date.now(), method: request.method, path, status: reply.statusCode, ...(page === undefined ? {} : { page: Number(page) }) });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    async configure(body: object) {
      const res = await app.inject({ method: 'POST', url: '/admin/switches', payload: body });
      expect(res.statusCode).toBe(200);
    },
  };
}

type Logged = WorkerEvent & { worker: string; t: number };

async function makeLab() {
  const url = REDIS_URL as string;
  const redis = createRedis('producer', url);
  const name = `test-worker-${randomUUID()}`;
  const queue = new Queue<CollectionJobData>(name, { connection: redis });
  const deadLetter = new Queue<DeadLetterData>(deadLetterQueueName(name), { connection: redis });
  const events: Logged[] = [];
  const workers: Worker[] = [];
  const connections: Redis[] = [];

  cleanups.push(async () => {
    for (const w of workers) await w.close();
    for (const c of connections) c.disconnect();
    for (const pattern of [`results:${name}:*`, `authblock:${name}:*`, `progress:${name}`]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await queue.obliterate({ force: true });
    await deadLetter.obliterate({ force: true });
    await queue.close();
    await deadLetter.close();
    await redis.quit();
  });

  return {
    redis,
    queue,
    deadLetter,
    events,
    /** 진입점과 같은 조립으로 워커를 띄운다. `limiter`도 진입점 기본값 그대로다. */
    async startWorker(
      workerName: string,
      collectFn: (data: CollectionJobData, options: CollectOptions) => Promise<CollectResult>,
      extra: Partial<Pick<ProcessorDeps, 'noProgressCycles' | 'redis'>> & Pick<CollectionWorkerOptions, 'stalled'> = {},
    ) {
      const connection = createRedis('worker', url);
      connections.push(connection);
      const { stalled, ...deps } = extra;
      const worker = createCollectionWorker({
        connection,
        deps: {
          collect: collectFn,
          redis,
          queue,
          deadLetter,
          clock: systemClock,
          log: (event) => events.push({ ...event, worker: workerName, t: Date.now() }),
          ...deps,
        },
        ...(stalled === undefined ? {} : { stalled }),
      });
      workers.push(worker);
      await worker.waitUntilReady();
      return worker;
    },
    async add(demo: Demo, from: string, to: string, opts: object = {}): Promise<string> {
      const data = { loginId: demo.loginId, accountNo: demo.accountNo, from, to };
      const jobId = jobIdOf(data.loginId, data.accountNo, from, to);
      await queue.add(COLLECT_JOB, data, { ...COLLECT_JOB_OPTIONS, ...opts, jobId });
      return jobId;
    },
    async waitFinished(ids: string[], timeoutMs = 15_000): Promise<Record<string, string>> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const states = await Promise.all(ids.map((id) => queue.getJobState(id)));
        if (states.every((s) => s === 'completed' || s === 'failed')) {
          return Object.fromEntries(ids.map((id, i) => [id, states[i] as string]));
        }
        if (Date.now() > deadline) throw new Error(`끝나지 않은 작업: ${JSON.stringify(states)}`);
        await sleep(20);
      }
    },
  };
}

function realCollect(origin: string, env?: Record<string, string | undefined>) {
  const transport = createUndiciTransport({ origin });
  return (data: CollectionJobData, options: CollectOptions) =>
    collect({ transport, clock: systemClock, ...(env === undefined ? {} : { env }) }, data.loginId, data.accountNo, data.from, data.to, options);
}

function expectedRows(demo: Demo, from: string, to: string): number {
  return buildLedger(demo.accountNo, demo.count).filter((row) => row.at >= from && row.at <= to).length;
}

/** 2026-01-02 00:00:00 UTC(원장 첫 거래일)에서 시간을 더한 `YYYY-MM-DD HH:mm:ss`. */
function at(hours: number): string {
  return new Date(Date.UTC(2026, 0, 2) + hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('조건이 제시간에 참이 되지 않았다');
    await sleep(10);
  }
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

const TIMEOUT = 20_000;

suite('큐 워커: 속도 제한(rate-limit 처분)', () => {
  it('속도 제한을 attempts(3)보다 많이 맞아도 시도 횟수를 깎지 않고 결국 완료한다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const row: Transaction = { seq: 1, at: '2026-01-02 01:00:00', memo: '급여', withdrawal: 0, deposit: 1000, balance: 1000 };
    let calls = 0;
    // 대상 서버의 Retry-After는 초 단위 정수(최소 1초)라 네 번이면 4초다. 가짜 수집 함수로
    // 0.1초짜리를 준다. 이 테스트가 보는 것은 BullMQ가 세는 방식이지 대상 서버가 아니다.
    // 가짜는 페이지를 하나도 받지 않으므로 진행 기반 상한(#19, 기본 3)이 세 번째에서 끊는다.
    // 이 테스트는 그 상한이 아니라 시도 횟수를 보므로 상한을 넉넉히 둔다.
    await lab.startWorker(
      'w1',
      async () => {
        calls += 1;
        if (calls <= 4) return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
        return { ok: true, rows: [row], pages: 1 };
      },
      { noProgressCycles: 10 },
    );
    const id = await lab.add(DEMO01, at(0), at(24));
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'completed' });

    const limited = lab.events.filter((e) => e.event === 'rate-limited');
    expect(limited).toHaveLength(4);
    // 처리 중 시도 횟수가 매번 0이다. 속도 제한이 시도를 깎았다면 1, 2가 보이고 세 번째에 실패했다.
    expect(limited.map((e) => e.attemptsMade)).toEqual([0, 0, 0, 0]);
    expect(calls).toBe(5);
    expect((await lab.queue.getJob(id))?.attemptsMade).toBe(1);
    expect(await lab.deadLetter.count()).toBe(0);
    expect(await lab.redis.hlen(resultsKey(lab.queue.name, id))).toBe(1);
  });

  it('실제 대상 서버의 429를 여러 번 맞아도 시도 횟수 0으로 기다렸다가 전부 완료한다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    // demo02 작업 하나는 요청 4개(로그인 2 + 1페이지 + 빈 2페이지)다. 창 1초에 4개면 작업
    // 하나만 들어가고, 다음 작업은 429를 받아 큐가 1초 멈춘 뒤 들어간다.
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 1, maxRequests: 4 } });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const ids = [
      await lab.add(DEMO02, at(0), at(24)),
      await lab.add(DEMO02, at(0), at(48)),
      await lab.add(DEMO02, at(0), at(72)),
    ];
    const states = await lab.waitFinished(ids);
    expect(Object.values(states)).toEqual(['completed', 'completed', 'completed']);

    const limited = lab.events.filter((e) => e.event === 'rate-limited');
    expect(limited.length).toBeGreaterThanOrEqual(2);
    expect(limited.every((e) => e.attemptsMade === 0)).toBe(true);
    expect(target.hits.filter((h) => h.status === 429).length).toBe(limited.length);
    expect(await lab.deadLetter.count()).toBe(0);
    for (const [id, to] of [
      [ids[0], at(24)],
      [ids[1], at(48)],
      [ids[2], at(72)],
    ] as const) {
      expect(await lab.redis.hlen(resultsKey(lab.queue.name, id as string))).toBe(expectedRows(DEMO02, at(0), to));
    }
  });

  it('한 워커가 429를 받으면 놀고 있는 다른 워커도 제한 창 동안 대상 서버에 요청하지 않는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    // 창 2초에 요청 8개 = demo02 작업 2개. 워커 2개가 동시에 한 작업씩 돌아도 한 창에 들어간다.
    // 창이 작업 2개보다 작으면 제한이 풀리는 순간 두 워커가 같이 출발해 서로의 창을 먹고 둘 다
    // 다시 429를 받는다. 그 경우는 이 테스트가 아니라 증거 문서(d2-pipeline.md)에서 다룬다.
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 2, maxRequests: 8 } });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    await lab.startWorker('w2', realCollect(target.origin));

    // 1) 두 작업으로 창을 채운다.
    const warm = [await lab.add(DEMO02, at(0), at(6)), await lab.add(DEMO02, at(0), at(12))];
    await lab.waitFinished(warm);
    // 2) 세 번째 작업이 429를 받아 큐 전체 제한을 건다. 이 작업은 대기로 돌아가고, 다른 워커
    //    하나는 놀고 있다. 큐 전체가 멈추지 않았다면 그 워커가 바로 이 작업을 꺼내 로그인을
    //    보내고 또 429를 받는다(limiter를 뺀 대조 실행에서 5ms 뒤에 그랬다: TROUBLESHOOTING 5번).
    const limitedId = await lab.add(DEMO02, at(0), at(18));
    await waitUntil(() => lab.events.some((e) => e.event === 'rate-limited'));
    const limited = lab.events.find((e) => e.event === 'rate-limited') as Extract<Logged, { event: 'rate-limited' }>;
    // 3) 제한 중에 새 작업도 하나 넣는다. 이것도 제한이 풀릴 때까지 꺼내지면 안 된다.
    const lateId = await lab.add(DEMO02, at(0), at(24));
    const states = await lab.waitFinished([limitedId, lateId]);
    expect(Object.values(states)).toEqual(['completed', 'completed']);

    expect(limited.attemptsMade).toBe(0);
    // 제한은 한 번만 걸렸다. 다른 워커가 제한 창 안에서 작업을 꺼냈다면 두 번째 429와 두 번째
    // 제한이 생긴다.
    expect(lab.events.filter((e) => e.event === 'rate-limited')).toHaveLength(1);
    const pauseEnd = limited.t + limited.waitMs;
    // 429 응답은 워커가 분류하기 전에 기록되므로(t ≤ limited.t) 여기 들지 않는다. 그 뒤
    // 제한이 풀릴 때까지 대상 서버에 온 요청은 하나도 없어야 한다.
    const during = target.hits.filter((h) => h.t > limited.t && h.t < pauseEnd - 20);
    expect(during).toEqual([]);
    const after = target.hits.filter((h) => h.t > limited.t);
    expect(after.length).toBe(8); // 두 작업 × 요청 4개. 제한이 풀린 뒤에만 나갔다.
    expect(await lab.deadLetter.count()).toBe(0);
  });
});

suite('큐 워커: retry·fail-now 처분과 DLQ', () => {
  it('TRANSIENT는 백오프하며 3번 시도한 뒤 DLQ에 kind TRANSIENT, attemptsMade 3으로 남는다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    // 닫힌 포트: 연결 거부(ECONNREFUSED)는 분류기가 TRANSIENT로 본다.
    await lab.startWorker('w1', realCollect(`http://127.0.0.1:${await closedPort()}`));
    // 시도 횟수(3)는 약속 그대로 두고 백오프만 줄인다. 기본(지수 1초)이면 3초를 기다린다.
    const id = await lab.add(DEMO02, at(0), at(24), { backoff: { type: 'fixed', delay: 50 } });
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });

    const job = await lab.queue.getJob(id);
    expect(job?.attemptsMade).toBe(3);
    expect(parseFailedReason(job?.failedReason).kind).toBe('TRANSIENT');
    expect(lab.events.filter((e) => e.event === 'retry').map((e) => e.attemptsMade)).toEqual([0, 1]);

    const dead = await lab.deadLetter.getJob(id);
    expect(dead?.data).toMatchObject({ originalId: id, kind: 'TRANSIENT', attemptsMade: 3, raw: null });
    expect(dead?.data.request).toEqual(job?.data);
    expect(await lab.deadLetter.count()).toBe(1);
  });

  it('AUTH_FAILED는 재시도 없이 DLQ로 가고, 같은 로그인 ID의 다음 작업은 로그인하지 않는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    const lab = await makeLab();
    // 비밀번호가 바뀐 상황. 대상 서버는 비밀번호 오류 5회에 계정을 잠근다.
    await lab.startWorker('w1', realCollect(target.origin, { COLLECTOR_DEMO01_PASSWORD: 'changed-elsewhere' }));
    const ids: string[] = [];
    for (let day = 0; day < 5; day += 1) ids.push(await lab.add(DEMO01, at(day * 24), at(day * 24 + 23)));
    const states = await lab.waitFinished(ids);
    expect(Object.values(states)).toEqual(Array(5).fill('failed'));

    // 대상 서버가 받은 로그인은 1번뿐이다. 차단기가 없으면 5번이고 계정이 잠긴다.
    expect(target.hits.filter((h) => h.path === '/login')).toHaveLength(1);
    expect(target.hits).toHaveLength(1);
    for (const id of ids) {
      const job = await lab.queue.getJob(id);
      expect(job?.attemptsMade).toBe(1);
      expect(parseFailedReason(job?.failedReason).kind).toBe('AUTH_FAILED');
    }
    const dead = (await lab.deadLetter.getJobs(['waiting'])).map((j) => j.data);
    expect(dead).toHaveLength(5);
    expect(dead.every((d) => d.kind === 'AUTH_FAILED' && d.attemptsMade === 1)).toBe(true);
    expect(dead.filter((d) => d.detail.startsWith('차단기:'))).toHaveLength(4);
    expect(lab.events.filter((e) => e.event === 'auth-blocked')).toHaveLength(4);
    expect(await lab.redis.get(authBlockKey(lab.queue.name, 'demo01'))).not.toBeNull();

    // 계정이 잠기지 않았다: 올바른 비밀번호는 여전히 통과한다.
    const res = await fetch(`${target.origin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'demo01', password: 'demo-pass-01' }),
    });
    expect(res.status).toBe(200);
  });

  it('IP_BLOCKED는 D2에서 Retry-After만큼 큐를 멈추고, 차단 중 대기 작업을 실패시키지 않고 풀린 뒤 끝낸다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    // 창 안에 4개(demo02 작업 하나)까지, 초과 1회에 바로 1초 차단. 두 번째 작업의 로그인이 403
    // IP_BLOCKED(Retry-After 1)를 받고, 차단이 풀리면 대상 서버가 카운터를 비우므로 들어간다.
    await target.configure({
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 10, maxRequests: 4, blockAfter: 1, blockDurationSec: 1 },
    });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const ids = [await lab.add(DEMO02, at(0), at(24)), await lab.add(DEMO02, at(0), at(48)), await lab.add(DEMO02, at(0), at(72))];
    const states = await lab.waitFinished(ids);
    // fail-now였을 때는 1초 차단 동안 뒤의 두 작업이 영구 failed가 됐다(리뷰 r3).
    expect(Object.values(states)).toEqual(['completed', 'completed', 'completed']);

    const blocked = lab.events.filter((e) => e.event === 'rate-limited');
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked.every((e) => e.event === 'rate-limited' && e.kind === 'IP_BLOCKED' && e.attemptsMade === 0 && e.waitMs === 1000)).toBe(true);
    expect(target.hits.filter((h) => h.status === 403)).toHaveLength(blocked.length);
    expect(await lab.deadLetter.count()).toBe(0);
    for (const id of ids) expect((await lab.queue.getJob(id))?.attemptsMade).toBe(1);
  });

  it('BullMQ가 프로세서 없이 실패시킨 작업(멈춤 한도 초과)도 DLQ에 kind null로 남는다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    let calls = 0;
    const id = await lab.add(DEMO02, at(0), at(24));
    // 처리 중 워커가 두 번 죽으면 BullMQ(6.3.8 moveStalledJobsToWait)가 작업 해시에 이 필드를
    // 남기고 대기로 돌린다. 워커 두 번을 실제로 죽이는 대신 그 결과를 직접 만든다. 그 뒤의 경로
    // (다음 워커가 프로세서 없이 실패시키고 failed 이벤트만 내는 것)는 BullMQ 그대로다. 실제로
    // 죽이는 경로는 증거 문서(d2-pipeline.md 4절, 리뷰 r4)에 있다.
    await lab.redis.hset(`bull:${lab.queue.name}:${id}`, 'defa', 'job stalled more than allowable limit');
    await lab.startWorker('w1', async () => {
      calls += 1;
      return { ok: true, rows: [], pages: 1 };
    });
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });
    await waitUntil(() => lab.events.some((e) => e.event === 'dead-letter'));

    expect(calls).toBe(0);
    const dead = (await lab.deadLetter.getJob(id))?.data;
    expect(dead?.kind).toBeNull();
    expect(dead?.detail).toContain('job stalled more than allowable limit');
    expect(dead?.request).toEqual((await lab.queue.getJob(id))?.data);
  });

  it('fail-now에서 DLQ 쓰기가 한 번 실패해도 다시 수집하지 않고, failed 이벤트에서 DLQ를 마저 쓴다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const realAdd = lab.deadLetter.add.bind(lab.deadLetter);
    let adds = 0;
    lab.deadLetter.add = (async (...args: Parameters<typeof realAdd>) => {
      adds += 1;
      if (adds === 1) throw new Error("READONLY You can't write against a read only replica.");
      return realAdd(...args);
    }) as typeof lab.deadLetter.add;
    let calls = 0;
    await lab.startWorker('w1', async () => {
      calls += 1;
      return { ok: false, kind: 'UNKNOWN', detail: '1차 인증 2xx 본문이 예상과 다르다', raw: { status: 200, headers: {}, body: Buffer.from('{}') } };
    });
    const id = await lab.add(DEMO02, at(0), at(24), { backoff: { type: 'fixed', delay: 20 } });
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });
    await waitUntil(() => lab.events.some((e) => e.event === 'dead-letter'));

    // 예전에는 쓰기 오류가 일반 오류로 나가 BullMQ가 다시 돌렸다(collect 2회, 리뷰 r5).
    expect(calls).toBe(1);
    expect((await lab.queue.getJob(id))?.attemptsMade).toBe(1);
    expect(lab.events.map((e) => e.event)).toEqual(['dead-letter-error', 'dead-letter']);
    expect((await lab.deadLetter.getJob(id))?.data).toMatchObject({ kind: 'UNKNOWN', attemptsMade: 1 });
  });

  it('차단기 기록이 실패해도 AUTH_FAILED 작업은 재시도하지 않아 비밀번호가 다시 나가지 않는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    const lab = await makeLab();
    const redis = lab.redis;
    // 차단기 SET만 실패시키는 연결. 나머지 명령은 진짜 연결로 보낸다.
    const flaky = new Proxy(redis, {
      get(obj, prop) {
        if (prop === 'set') return async () => { throw new Error('READONLY'); };
        const value = Reflect.get(obj, prop, obj) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    });
    const connection = createRedis('worker', REDIS_URL as string);
    const worker = createCollectionWorker({
      connection,
      deps: {
        collect: realCollect(target.origin, { COLLECTOR_DEMO01_PASSWORD: 'changed-elsewhere' }),
        redis: flaky,
        queue: lab.queue,
        deadLetter: lab.deadLetter,
        clock: systemClock,
        log: (event) => lab.events.push({ ...event, worker: 'w1', t: Date.now() }),
      },
    });
    cleanups.push(async () => {
      await worker.close();
      connection.disconnect();
    });
    const id = await lab.add(DEMO01, at(0), at(24), { backoff: { type: 'fixed', delay: 20 } });
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });
    await sleep(200);

    expect(target.hits.filter((h) => h.path === '/login')).toHaveLength(1);
    const job = await lab.queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
    expect(parseFailedReason(job?.failedReason).kind).toBe('AUTH_FAILED');
    expect(job?.failedReason).toContain('차단기 기록 실패');
    expect(lab.events.some((e) => e.event === 'auth-block-error')).toBe(true);
    expect(await redis.get(authBlockKey(lab.queue.name, 'demo01'))).toBeNull();
  });

  it('1차 인증의 UNKNOWN(모르는 423)도 차단기를 걸고, 인증 단계의 TRANSIENT는 걸지 않는다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const logins: string[] = [];
    // 로그인 ID별로 다른 응답을 주는 가짜 전송. demo01은 423(분류기가 모르는 상태 코드),
    // demo02는 연결 리셋(TRANSIENT).
    const transportFor = (loginId: string): Transport => async (req) => {
      if (req.path === '/login') {
        logins.push(loginId);
        if (loginId === 'demo01') return { status: 423, headers: {}, body: Buffer.from('{"error":"LOCKED_BY_POLICY"}') };
        return { network: { code: 'ECONNRESET', message: 'socket hang up' } };
      }
      return { status: 500, headers: {}, body: Buffer.from('') };
    };
    await lab.startWorker('w1', (data) =>
      collect({ transport: transportFor(data.loginId), clock: systemClock }, data.loginId, data.accountNo, data.from, data.to),
    );
    const unknownIds: string[] = [];
    for (let day = 0; day < 3; day += 1) unknownIds.push(await lab.add(DEMO01, at(day * 24), at(day * 24 + 23)));
    const transientId = await lab.add(DEMO02, at(0), at(24), { backoff: { type: 'fixed', delay: 20 } });
    const states = await lab.waitFinished([...unknownIds, transientId]);
    expect(Object.values(states)).toEqual(['failed', 'failed', 'failed', 'failed']);

    // demo01: 로그인 1번, 뒤의 두 작업은 차단기에 막혔다. 차단 사유 종류는 UNKNOWN이다.
    expect(logins.filter((l) => l === 'demo01')).toHaveLength(1);
    const block = JSON.parse((await lab.redis.get(authBlockKey(lab.queue.name, 'demo01'))) as string) as { kind: string };
    expect(block.kind).toBe('UNKNOWN');
    const dead = await Promise.all(unknownIds.map(async (id) => (await lab.deadLetter.getJob(id))?.data));
    expect(dead.map((d) => d?.kind)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(dead.filter((d) => d?.detail.startsWith('차단기:'))).toHaveLength(2);
    // demo02: TRANSIENT는 환경 문제라 막지 않는다. attempts(3)만큼 로그인했다.
    expect(logins.filter((l) => l === 'demo02')).toHaveLength(3);
    expect(await lab.redis.get(authBlockKey(lab.queue.name, 'demo02'))).toBeNull();
  });

  it('사람이 실패 작업을 다시 돌려 또 실패하면 DLQ 항목을 새 내용으로 갱신한다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    let calls = 0;
    await lab.startWorker('w1', async () => {
      calls += 1;
      return { ok: false, kind: 'TRANSIENT', detail: `HTTP 503 (호출 ${calls})` };
    });
    const id = await lab.add(DEMO02, at(0), at(24), { backoff: { type: 'fixed', delay: 20 } });
    await lab.waitFinished([id]);
    const first = (await lab.deadLetter.getJob(id))?.data;
    expect(first?.detail).toBe('HTTP 503 (호출 3)');

    await sleep(20); // failedAt이 밀리초 단위라 같은 값이 나오지 않게 한다.
    await (await lab.queue.getJob(id))?.retry('failed');
    await waitUntil(() => lab.events.filter((e) => e.event === 'dead-letter').length === 2);
    await lab.waitFinished([id]);

    const second = (await lab.deadLetter.getJob(id))?.data;
    expect(await lab.deadLetter.count()).toBe(1);
    // bullmq 6.3.8의 retry()는 시도 수를 되돌리지 않는다. 다시 돈 첫 시도가 곧 마지막 시도다.
    expect(calls).toBe(4);
    expect(second?.detail).toBe('HTTP 503 (호출 4)');
    expect(second?.attemptsMade).toBe(4);
    expect(second?.failedAt).not.toBe(first?.failedAt);
  });

  it('DLQ에 남기는 원본에서 세션 토큰을 가린다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const secret = 'sid-live-3f9a1c';
    const body = Buffer.from('{"unexpected":true}');
    // 가리기 전 원본을 그대로 돌려주는 수집 함수. 세션 층은 경계에서 이미 가리므로, 실제
    // 수집 함수로는 워커가 가리는지를 볼 수 없다.
    const failure: Failure = {
      ok: false,
      kind: 'UNKNOWN',
      detail: '2차 인증 2xx 본문이 예상과 다르다',
      raw: { status: 200, headers: { 'set-cookie': `SID=${secret}; Path=/; HttpOnly`, 'content-type': 'application/json' }, body },
    };
    await lab.startWorker('w1', async () => failure);
    const id = await lab.add(DEMO01, at(0), at(24));
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });

    const dead = await lab.deadLetter.getJob(id);
    expect(dead?.data.kind).toBe('UNKNOWN');
    expect(dead?.data.attemptsMade).toBe(1);
    const raw = dead?.data.raw as { status: number; headers: Record<string, string>; bodyBase64: string };
    expect(raw.headers['set-cookie']).toBe('SID=[REDACTED]; Path=/; HttpOnly');
    expect(Buffer.from(raw.bodyBase64, 'base64')).toEqual(body);
    // Redis에 저장된 모양 그대로 훑는다. 원래 큐의 작업 해시(failedReason 포함)도 본다.
    const stored = JSON.stringify([
      await lab.redis.hgetall(`bull:${lab.deadLetter.name}:${id}`),
      await lab.redis.hgetall(`bull:${lab.queue.name}:${id}`),
    ]);
    expect(stored).not.toContain(secret);
    expect(stored).toContain('[REDACTED]');
  });

  it('자격증명이 없는 로그인 ID는 설정 오류로 분류 없이(kind null) 한 번에 DLQ로 간다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin, {}));
    const id = await lab.add({ loginId: 'nobody', accountNo: '000-00-000000', count: 0 }, at(0), at(24));
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });

    const job = await lab.queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
    expect(parseFailedReason(job?.failedReason)).toEqual({ kind: null, detail: '설정 오류: 자격증명을 찾을 수 없다: nobody' });
    expect((await lab.deadLetter.getJob(id))?.data).toMatchObject({ kind: null, attemptsMade: 1 });
    expect(target.hits).toEqual([]);
  });
});

suite('큐 워커: 멱등과 분배', () => {
  it('같은 작업을 다시 넣어도, 지우고 다시 넣어 다시 돌아도 결과 행이 늘지 않는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const from = at(3 * 24);
    const to = at(8 * 24);
    const id = await lab.add(DEMO01, from, to);
    await lab.waitFinished([id]);
    const key = resultsKey(lab.queue.name, id);
    const first = await lab.redis.hgetall(key);
    expect(Object.keys(first)).toHaveLength(expectedRows(DEMO01, from, to));
    expect(Object.keys(first).length).toBeGreaterThan(0);

    // 첫 겹: 같은 ID가 남아 있으면 BullMQ가 새로 만들지 않는다. 프로세서가 다시 돌지 않는다.
    await lab.add(DEMO01, from, to);
    await sleep(300);
    expect(lab.events.filter((e) => e.event === 'completed')).toHaveLength(1);

    // 둘째 겹: 작업을 지우고 다시 넣으면 프로세서가 다시 돈다. 결과는 seq 필드라 그대로다.
    await (await lab.queue.getJob(id))?.remove();
    await lab.add(DEMO01, from, to);
    await lab.waitFinished([id]);
    expect(lab.events.filter((e) => e.event === 'completed')).toHaveLength(2);
    expect(await lab.redis.hgetall(key)).toEqual(first);
  });

  it('워커 2개가 20건을 나눠 처리하고, 결과 작업 20개의 행 수가 원장과 맞는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    await lab.startWorker('w2', realCollect(target.origin));

    const jobs: { id: string; demo: Demo; from: string; to: string }[] = [];
    for (let i = 0; i < 10; i += 1) {
      // demo01: 날짜를 하루씩 밀어 가며 사흘. demo02: 같은 시작에서 끝을 6시간씩 늘린다.
      const a = { demo: DEMO01, from: at(i * 24), to: at(i * 24 + 72) };
      const b = { demo: DEMO02, from: at(0), to: at(6 * (i + 1)) };
      for (const j of [a, b]) jobs.push({ ...j, id: await lab.add(j.demo, j.from, j.to) });
    }
    const states = await lab.waitFinished(jobs.map((j) => j.id));
    expect(Object.values(states).filter((s) => s === 'completed')).toHaveLength(20);

    let total = 0;
    for (const j of jobs) {
      const rows = await lab.redis.hlen(resultsKey(lab.queue.name, j.id));
      expect(rows).toBe(expectedRows(j.demo, j.from, j.to));
      const job = await lab.queue.getJob(j.id);
      expect((job?.returnvalue as ProcessorResult).count).toBe(rows);
      total += rows;
    }
    expect(total).toBe(jobs.reduce((sum, j) => sum + expectedRows(j.demo, j.from, j.to), 0));

    const byWorker = { w1: 0, w2: 0 };
    for (const e of lab.events) if (e.event === 'completed') byWorker[e.worker as 'w1' | 'w2'] += 1;
    expect(byWorker.w1 + byWorker.w2).toBe(20);
    expect(byWorker.w1).toBeGreaterThan(0);
    expect(byWorker.w2).toBeGreaterThan(0);
    expect(await lab.deadLetter.count()).toBe(0);
  });
});

/** 대상 서버가 받은 거래내역 요청을 `페이지(상태)` 모양으로. 429·403만 상태를 붙인다. */
function pageTrace(hits: Hit[]): string[] {
  return hits.filter((h) => h.path === '/transactions').map((h) => (h.status === 200 ? String(h.page) : `${h.page}(${h.status})`));
}

suite('큐 워커: 이어받기와 진행 기반 상한(#19)', () => {
  const ALL = { from: '2026-01-01 00:00:00', to: '2026-12-31 23:59:59' };

  it('대상 서버 기본 임계값(W=10초, N=5)에서 속도 제한을 켜도 demo01 전체 작업이 받은 페이지부터 이어 가며 완료되고 결과가 원장과 같다', { timeout: 45_000 }, async () => {
    const target = await startTarget();
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 10, maxRequests: 5 } });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const id = await lab.add(DEMO01, ALL.from, ALL.to);
    expect(await lab.waitFinished([id], 40_000)).toEqual({ [id]: 'completed' });

    // 137행 = 7페이지 + 끝을 확인하는 빈 8페이지. 주기마다 로그인 2 + 페이지 3개가 창(5)을 채우고
    // 다음 페이지에서 429다. 예전에는 매 주기 1페이지부터 다시 받아 4페이지에서 끝없이 막혔다.
    expect(pageTrace(target.hits)).toEqual(['1', '2', '3', '4(429)', '4', '5', '6', '7(429)', '7', '8']);
    expect(target.hits.filter((h) => h.path === '/login')).toHaveLength(3);
    expect(await readResults(lab.redis, lab.queue.name, id)).toEqual(buildLedger(DEMO01.accountNo, DEMO01.count));
    expect(((await lab.queue.getJob(id))?.returnvalue as ProcessorResult).count).toBe(137);
    const limited = lab.events.filter((e) => e.event === 'rate-limited');
    expect(limited.map((e) => e.attemptsMade)).toEqual([0, 0]);
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('출발지 차단을 함께 켜도, 차단 주기를 지나 받은 페이지부터 이어 가며 완료된다', { timeout: 45_000 }, async () => {
    const target = await startTarget();
    // W·N·M은 기본값. 차단 시간만 3초로 줄였다(기본 30초면 이 테스트가 50초다).
    await target.configure({
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 10, maxRequests: 5, blockAfter: 3, blockDurationSec: 3 },
    });
    // 작업 하나로는 429가 두 번뿐이라(아래 4·7페이지) M=3에 닿지 않고 차단이 나지 않는다. 같은
    // 출발지의 다른 클라이언트가 창을 다 쓰고 429를 두 번 받은 상태를 먼저 만든다. 그러면 작업의
    // 첫 요청(로그인)이 세 번째 429 자리라 403 IP_BLOCKED다.
    for (let i = 0; i < 7; i += 1) await fetch(`${target.origin}/transactions`);
    expect(target.hits.map((h) => h.status)).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const mark = target.hits.length;

    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const id = await lab.add(DEMO01, ALL.from, ALL.to);
    expect(await lab.waitFinished([id], 40_000)).toEqual({ [id]: 'completed' });

    const after = target.hits.slice(mark);
    expect(after[0]).toMatchObject({ path: '/login', status: 403 });
    // 차단이 풀리면 대상 서버가 카운터를 비운다. 그 뒤는 차단 없는 기본 임계값과 같다.
    expect(pageTrace(after)).toEqual(['1', '2', '3', '4(429)', '4', '5', '6', '7(429)', '7', '8']);
    const limited = lab.events.filter((e): e is Extract<Logged, { event: 'rate-limited' }> => e.event === 'rate-limited');
    expect(limited.map((e) => [e.kind, e.waitMs])).toEqual([
      ['IP_BLOCKED', 3000],
      ['RATE_LIMITED', 10_000],
      ['RATE_LIMITED', 10_000],
    ]);
    expect(await readResults(lab.redis, lab.queue.name, id)).toEqual(buildLedger(DEMO01.accountNo, DEMO01.count));
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('워커 2개가 창을 나눠 쓰며 한 작업이 주기마다 한 페이지도 못 받아도, 큐 전체가 나아가는 한 두 작업 모두 완료한다', { timeout: 40_000 }, async () => {
    const target = await startTarget();
    // 창 2초에 5개, 429 세 번에 2초 차단. 기본값(10초·30초)과 모양은 같고 시간만 줄였다.
    await target.configure({
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 2, maxRequests: 5, blockAfter: 3, blockDurationSec: 2 },
    });
    const lab = await makeLab();
    const LATE = { from: '2026-01-02 00:00:00', to: ALL.to };
    const lateStarts: number[] = [];
    const real = realCollect(target.origin);
    // 늦은 작업은 0.1초 늦게 출발한다. 두 작업이 같은 주기에 출발하면 이른 작업이 창(로그인 2 +
    // 페이지 3)을 먼저 다 쓰고, 늦은 작업은 로그인에서 429·403을 받는다. 경쟁을 고정해서 늦은
    // 작업이 처음 세 주기를 한 페이지도 없이 지나게 한다(작업 단위로 세면 여기서 NO_PROGRESS다).
    const collectFn = async (data: CollectionJobData, options: CollectOptions) => {
      if (data.from === LATE.from) {
        lateStarts.push(options.startPage ?? 1);
        await sleep(100);
      }
      return real(data, options);
    };
    await lab.startWorker('w1', collectFn);
    await lab.startWorker('w2', collectFn);
    const early = await lab.add(DEMO01, ALL.from, ALL.to);
    const late = await lab.add(DEMO01, LATE.from, LATE.to);
    expect(await lab.waitFinished([early, late], 35_000)).toEqual({ [early]: 'completed', [late]: 'completed' });

    expect(lateStarts.slice(0, 3)).toEqual([1, 1, 1]);
    expect(lab.events.some((e) => e.event === 'rate-limited' && e.kind === 'IP_BLOCKED')).toBe(true);
    const ledger = buildLedger(DEMO01.accountNo, DEMO01.count);
    expect(await readResults(lab.redis, lab.queue.name, early)).toEqual(ledger);
    expect(await readResults(lab.redis, lab.queue.name, late)).toEqual(ledger.filter((r) => r.at >= LATE.from));
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('앞선 사고가 남긴 진행 상태(연속 3)가 있어도 회복된 큐의 첫 주기에 작업을 실패시키지 않는다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 2, maxRequests: 5 } });
    const lab = await makeLab();
    // d3-resume.md 5절이 끝난 상태 그대로다(pages 21, seen 21, cycles 3). until 0은 정지가 한참 전에 끝났다는 뜻이다.
    await lab.redis.hset(progressKey(lab.queue.name), { pages: 21, seen: 21, cycles: 3, until: 0 });
    // 창을 먼저 다 써 둔다. 두 작업의 첫 로그인이 페이지 하나 받기 전에 429다(이 주기는 정말 무진행이다).
    for (let i = 0; i < 5; i += 1) await fetch(`${target.origin}/transactions`);
    await lab.startWorker('w1', realCollect(target.origin));
    await lab.startWorker('w2', realCollect(target.origin));
    const ids = [await lab.add(DEMO02, at(0), at(24)), await lab.add(DEMO02, at(0), at(48))];
    expect(await lab.waitFinished(ids)).toEqual({ [ids[0] as string]: 'completed', [ids[1] as string]: 'completed' });
    expect(target.hits.slice(5, 7).map((h) => [h.path, h.status])).toEqual([
      ['/login', 429],
      ['/login', 429],
    ]);
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('페이지 없이 끝난 완료도 진행으로 센다(빈 계좌, 빈 끝 페이지만 남은 이어받기)', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const calls = new Map<string, number>();
    // 작업마다 첫 호출은 429, 두 번째는 페이지 없이 완료. 완료를 진행으로 세지 않으면 429가 연속 주기로만 쌓인다.
    await lab.startWorker('w1', async (data) => {
      const n = (calls.get(data.from) ?? 0) + 1;
      calls.set(data.from, n);
      if (n === 1) return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
      return { ok: true, rows: [], pages: 1 };
    });
    const ids: string[] = [];
    for (let day = 2; day <= 6; day += 1) ids.push(await lab.add(DEMO01, `2026-01-0${day} 00:00:00`, ALL.to));
    const states = await lab.waitFinished(ids);
    expect(Object.values(states)).toEqual(Array(5).fill('completed'));
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('다른 워커가 받은 페이지는 그 결과를 쓰기 전에도 진행으로 센다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    // 직전까지 연속 2(K=3). 이번 주기에 아무도 못 받았으면 NO_PROGRESS가 맞다.
    await lab.redis.hset(progressKey(lab.queue.name), { pages: 0, seen: 0, cycles: 2, until: Date.now() });
    // 페이지를 받은 워커의 결과 쓰기(HSET)가 0.3초 걸린다. 그 사이 다른 워커가 429를 받는다.
    const slow = new Proxy(lab.redis, {
      get(obj, prop) {
        if (prop === 'hset') {
          return async (...args: unknown[]) => {
            await sleep(300);
            return (obj.hset as (...a: unknown[]) => Promise<number>)(...args);
          };
        }
        const value = Reflect.get(obj, prop, obj) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    });
    const row: Transaction = { seq: 1, at: '2026-01-02 01:00:00', memo: '급여', withdrawal: 0, deposit: 1000, balance: 1000 };
    let received!: () => void;
    const pageReceived = new Promise<void>((r) => (received = r));
    const PAGED = '2026-01-02 00:00:00';
    const bCalls: number[] = [];
    const collectFn = async (data: CollectionJobData, options: CollectOptions): Promise<CollectResult> => {
      if (data.from === PAGED) {
        // 페이지를 받았다. onPage가 결과를 다 쓸 때까지 0.3초다.
        setTimeout(received, 20);
        await options.onPage?.([row], 1);
        return { ok: true, rows: [row], pages: 2 };
      }
      bCalls.push(bCalls.length + 1);
      if (bCalls.length === 1) {
        await pageReceived; // 다른 워커가 페이지를 받은 20ms 뒤의 429
        return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
      }
      return { ok: true, rows: [], pages: 1 };
    };
    await lab.startWorker('w1', collectFn, { redis: slow });
    await lab.startWorker('w2', collectFn, { redis: slow });
    const ids = [await lab.add(DEMO01, PAGED, ALL.to), await lab.add(DEMO01, '2026-01-03 00:00:00', ALL.to)];
    expect(await lab.waitFinished(ids)).toEqual({ [ids[0] as string]: 'completed', [ids[1] as string]: 'completed' });
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('같은 주기 안에서도 앞선 제한 뒤에 받은 페이지가 있으면 진행으로 센다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    await lab.redis.hset(progressKey(lab.queue.name), { pages: 0, seen: 0, cycles: 2, until: Date.now() });
    const row: Transaction = { seq: 1, at: '2026-01-02 01:00:00', memo: '급여', withdrawal: 0, deposit: 1000, balance: 1000 };
    const FIRST = '2026-01-02 00:00:00';
    let bCalls = 0;
    // A: 이번 주기의 첫 429. 그때까지 아무도 페이지를 못 받았으니 연속 3이고 A는 NO_PROGRESS가 맞다.
    // B: A가 DLQ로 간 뒤(같은 1초 정지 안) 페이지를 하나 받고 429. 주기는 같아도 큐는 나아갔다.
    const collectFn = async (data: CollectionJobData, options: CollectOptions): Promise<CollectResult> => {
      if (data.from === FIRST) return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 1 };
      bCalls += 1;
      if (bCalls === 1) {
        await waitUntil(() => lab.events.some((e) => e.event === 'dead-letter'));
        await options.onPage?.([row], 1);
        return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
      }
      return { ok: true, rows: [], pages: 2 };
    };
    await lab.startWorker('w1', collectFn);
    await lab.startWorker('w2', collectFn);
    const first = await lab.add(DEMO01, FIRST, ALL.to);
    const second = await lab.add(DEMO01, '2026-01-03 00:00:00', ALL.to);
    expect(await lab.waitFinished([first, second])).toEqual({ [first]: 'failed', [second]: 'completed' });
    expect((await lab.deadLetter.getJob(first))?.data.kind).toBe('NO_PROGRESS');
    expect(await lab.deadLetter.getJob(second)).toBeUndefined();
  });

  // 이어받는 실행이 4페이지를 받고 결과를 쓰는 자리에서 워커가 죽는다. 'after'는 행을 쓴 뒤·체크포인트
  // 전(같은 페이지를 다시 쓰게 된다), 'before'는 행을 쓰기 전(체크포인트가 행보다 먼저면 그 페이지가
  // 빠진다). 죽음은 결과 쓰기를 영영 돌아오지 않게 하고 워커를 강제로 닫아 만든다. 잠금이 풀리면
  // 다른 워커의 멈춤 검사가 작업을 대기로 돌린다. 프로세스를 실제로 죽이는 경로는 확인하지 않았다(테스트·실측 모두
  // 같은 프로세스 안의 흉내다).
  it.each([
    ['after', 80],
    ['before', 60],
  ] as const)('이어받는 도중 워커가 죽어도(결과 쓰기 %s) 다른 워커가 이어받아 끝내고 결과 행이 늘지 않는다', { timeout: TIMEOUT }, async (when, rowsAtDeath) => {
    const target = await startTarget();
    // 창 1초에 5개. 첫 주기는 1~3페이지, 4페이지 429. 두 번째 주기가 4페이지부터 이어받는다.
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 1, maxRequests: 5 } });
    const lab = await makeLab();
    let hsets = 0;
    let died!: () => void;
    const dead = new Promise<void>((r) => (died = r));
    const dying = new Proxy(lab.redis, {
      get(obj, prop) {
        if (prop === 'hset') {
          return async (...args: unknown[]) => {
            hsets += 1;
            // 1~3번째는 첫 주기의 1~3페이지, 4번째가 이어받은 4페이지다.
            if (hsets !== 4) return (obj.hset as (...a: unknown[]) => Promise<number>)(...args);
            if (when === 'after') await (obj.hset as (...a: unknown[]) => Promise<number>)(...args);
            died();
            return new Promise(() => {});
          };
        }
        const value = Reflect.get(obj, prop, obj) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    });
    // w1의 멈춤 검사 주기도 줄인다. 멈춤 검사는 큐 전체에서 `stalled-check` 키(수명 = 검사한 워커의
    // stalledInterval)로 한 번씩만 돈다. w1이 기본 30초로 먼저 돌면 w2의 검사가 30초 동안 건너뛰어진다
    // (bullmq 6.3.8 moveStalledJobsToWait-9.lua).
    const w1 = await lab.startWorker('w1', realCollect(target.origin), { redis: dying, stalled: { lockDuration: 1000, stalledInterval: 200 } });
    const id = await lab.add(DEMO01, ALL.from, ALL.to);
    await dead;
    await w1.close(true);
    const key = resultsKey(lab.queue.name, id);
    expect(await lab.redis.hlen(key)).toBe(rowsAtDeath);
    expect(pageTrace(target.hits)).toEqual(['1', '2', '3', '4(429)', '4']);

    const starts: number[] = [];
    const real = realCollect(target.origin);
    await lab.startWorker(
      'w2',
      (data, options) => {
        starts.push(options.startPage ?? 1);
        return real(data, options);
      },
      { stalled: { stalledInterval: 200 } },
    );
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'completed' });

    // 체크포인트는 4페이지에 머물러 있었다. 4페이지를 한 번 더 받고 썼지만 seq 필드라 행이 늘지 않았다.
    expect(starts[0]).toBe(4);
    expect(await readResults(lab.redis, lab.queue.name, id)).toEqual(buildLedger(DEMO01.accountNo, DEMO01.count));
    expect(((await lab.queue.getJob(id))?.returnvalue as ProcessorResult).count).toBe(137);
    expect(await lab.deadLetter.count()).toBe(0);
  });

  it('N=2(로그인 비용 이하)면 한 페이지도 못 받는 주기가 K(기본 3)번 이어진 뒤 DLQ에 NO_PROGRESS로 남는다', { timeout: 20_000 }, async () => {
    const target = await startTarget();
    // 창 1초에 요청 2개. 로그인 2요청이 창을 다 써서 매 주기 1페이지에서 429다.
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 1, maxRequests: 2 } });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const id = await lab.add(DEMO01, ALL.from, ALL.to);
    expect(await lab.waitFinished([id], 15_000)).toEqual({ [id]: 'failed' });

    expect(pageTrace(target.hits)).toEqual(['1(429)', '1(429)', '1(429)']);
    // 속도 제한은 여전히 시도 횟수를 깎지 않았다. 세 번째 주기에서 한 번에 failed로 갔다.
    expect(lab.events.filter((e) => e.event === 'rate-limited').map((e) => e.attemptsMade)).toEqual([0, 0, 0]);
    const job = await lab.queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
    expect(parseFailedReason(job?.failedReason).kind).toBe('NO_PROGRESS');
    const dead = (await lab.deadLetter.getJob(id))?.data;
    expect(dead).toMatchObject({ originalId: id, kind: 'NO_PROGRESS', attemptsMade: 1, raw: null });
    expect(await lab.deadLetter.count()).toBe(1);
    expect(await lab.redis.hlen(resultsKey(lab.queue.name, id))).toBe(0);
  });

  it('상한에 닿은 뒤 대기 중이던 작업도 한 주기를 더 보내 보고 같은 NO_PROGRESS로 끝난다', { timeout: 20_000 }, async () => {
    const target = await startTarget();
    await target.configure({ switches: { rateLimit: true }, thresholds: { windowSec: 1, maxRequests: 2 } });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const ids = [await lab.add(DEMO01, ALL.from, ALL.to), await lab.add(DEMO01, '2026-01-02 00:00:00', ALL.to)];
    expect(await lab.waitFinished(ids, 15_000)).toEqual({ [ids[0] as string]: 'failed', [ids[1] as string]: 'failed' });

    // 상한(3)까지 세 주기, 대기 작업이 한 주기. 대기 작업을 꺼낼 때 미리 실패시켰다면 3이다.
    expect(pageTrace(target.hits)).toEqual(['1(429)', '1(429)', '1(429)', '1(429)']);
    const dead = (await lab.deadLetter.getJobs(['waiting'])).map((j) => j.data.kind);
    expect(dead).toEqual(['NO_PROGRESS', 'NO_PROGRESS']);
  });

  it('한 페이지라도 받은 주기가 끼면 진행 없는 주기 수를 처음부터 센다', { timeout: TIMEOUT }, async () => {
    const lab = await makeLab();
    const row: Transaction = { seq: 1, at: '2026-01-02 01:00:00', memo: '급여', withdrawal: 0, deposit: 1000, balance: 1000 };
    const limited: CollectResult = { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
    const starts: number[] = [];
    // 진행 없음, (1페이지 받고) 제한, 진행 없음 두 번, 성공. 진행 없는 주기가 연달아 셋이 되는
    // 자리가 없으므로 K=3에서 끝까지 가야 한다. 두 번째 주기를 진행 없음으로 세면 네 번째에서 DLQ다.
    await lab.startWorker('w1', async (_data, options) => {
      starts.push(options.startPage ?? 1);
      if (starts.length === 2) {
        await options.onPage?.([row], 1);
        return limited;
      }
      if (starts.length < 5) return limited;
      return { ok: true, rows: [], pages: 2 };
    });
    const id = await lab.add(DEMO01, ALL.from, ALL.to);
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'completed' });

    expect(starts).toEqual([1, 1, 2, 2, 2]);
    expect(await lab.deadLetter.count()).toBe(0);
    expect(((await lab.queue.getJob(id))?.returnvalue as ProcessorResult).count).toBe(1);
  });
});
