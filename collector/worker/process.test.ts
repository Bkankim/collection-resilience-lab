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
import type { CollectResult } from '../client/session.js';
import { createUndiciTransport } from '../client/transport.js';
import {
  COLLECT_JOB,
  COLLECT_JOB_OPTIONS,
  authBlockKey,
  createRedis,
  deadLetterQueueName,
  jobIdOf,
  parseFailedReason,
  resultsKey,
} from '../queue.js';
import type { CollectionJobData, DeadLetterData } from '../queue.js';
import { redisUrlForTests } from '../redis-for-tests.js';
import { createCollectionWorker } from './process.js';
import type { ProcessorResult, WorkerEvent } from './process.js';

const REDIS_URL = redisUrlForTests();
const suite = REDIS_URL === undefined ? describe.skip : describe;

const DEMO01 = { loginId: 'demo01', accountNo: '000-11-222333', count: 137 };
const DEMO02 = { loginId: 'demo02', accountNo: '000-44-555666', count: 12 };
type Demo = typeof DEMO01;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Hit = { t: number; method: string; path: string; status: number };

/** 대상 서버를 빈 포트에 띄운다. 관리 API는 요청 기록에서 뺀다(차단 판정도 받지 않는다). */
async function startTarget() {
  const app = buildApp();
  const hits: Hit[] = [];
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (path.startsWith('/admin')) return;
    hits.push({ t: Date.now(), method: request.method, path, status: reply.statusCode });
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
    for (const pattern of [`results:${name}:*`, `authblock:${name}:*`]) {
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
    async startWorker(workerName: string, collectFn: (data: CollectionJobData) => Promise<CollectResult>) {
      const connection = createRedis('worker', url);
      connections.push(connection);
      const worker = createCollectionWorker({
        connection,
        deps: {
          collect: collectFn,
          redis,
          queue,
          deadLetter,
          clock: systemClock,
          log: (event) => events.push({ ...event, worker: workerName, t: Date.now() }),
        },
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
  return (data: CollectionJobData) =>
    collect({ transport, clock: systemClock, ...(env === undefined ? {} : { env }) }, data.loginId, data.accountNo, data.from, data.to);
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
    await lab.startWorker('w1', async () => {
      calls += 1;
      if (calls <= 4) return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: 0.1 };
      return { ok: true, rows: [row], pages: 1 };
    });
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

  it('IP_BLOCKED는 D2에서 전환할 출발지가 없어 한 번에 DLQ로 간다', { timeout: TIMEOUT }, async () => {
    const target = await startTarget();
    // 창 안에 2개까지, 초과 1회에 바로 차단. 로그인 2개가 통과하고 1페이지가 403 IP_BLOCKED다.
    await target.configure({
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 10, maxRequests: 2, blockAfter: 1 },
    });
    const lab = await makeLab();
    await lab.startWorker('w1', realCollect(target.origin));
    const id = await lab.add(DEMO02, at(0), at(24));
    expect(await lab.waitFinished([id])).toEqual({ [id]: 'failed' });

    const job = await lab.queue.getJob(id);
    expect(job?.attemptsMade).toBe(1);
    expect(parseFailedReason(job?.failedReason).kind).toBe('IP_BLOCKED');
    expect((await lab.deadLetter.getJob(id))?.data).toMatchObject({ kind: 'IP_BLOCKED', attemptsMade: 1 });
    expect(target.hits.map((h) => h.status)).toEqual([200, 200, 403]);
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
