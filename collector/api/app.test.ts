/**
 * 수집 요청 API 통합 테스트. 실제 Redis에 붙는다. 멱등과 상태가 BullMQ의 Redis 스크립트
 * 동작에 기대고 있어서 가짜 큐로는 검증하는 것이 없다.
 *
 * `REDIS_URL`이 없으면 건너뛴다. CI에서는 없으면 던진다(`redis-for-tests.ts`).
 * 테스트마다 큐 이름을 새로 만들어 서로의 작업이 섞이지 않게 하고, 끝나면 지운다.
 *
 * 워커는 이 이슈 범위가 아니다(#13). 완료·실패 상태를 보려고 테스트 안에서 가짜 프로세서를
 * 가진 최소 Worker를 띄운다. 실제 수집은 하지 않는다.
 */

import { randomUUID } from 'node:crypto';

import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';

import type { Transaction } from '../client/parse.js';
import { createRedis, formatFailedReason, resultsKey } from '../queue.js';
import type { CollectionJobData } from '../queue.js';
import { redisUrlForTests } from '../redis-for-tests.js';
import { buildApi, parseRequest, toStatus } from './app.js';

const REDIS_URL = redisUrlForTests();

const BODY = { loginId: 'demo01', accountNo: '000-11-222333', from: '2026-09-01', to: '2026-09-30' };

type Lab = {
  app: FastifyInstance;
  queue: Queue<CollectionJobData>;
  redis: Redis;
  /** 가짜 프로세서로 워커를 띄운다. 프로세서가 불린 횟수를 센다. */
  startWorker: (processor: (job: Job<CollectionJobData>) => Promise<unknown>) => { calls: () => number; worker: Worker };
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeLab(): Promise<Lab> {
  const url = REDIS_URL as string;
  const redis = createRedis('producer', url);
  const queue = new Queue<CollectionJobData>(`test-collections-${randomUUID()}`, { connection: redis });
  const app = buildApi({ queue, redis });
  const workers: Worker[] = [];
  const workerConnections: Redis[] = [];
  cleanups.push(async () => {
    await app.close();
    for (const w of workers) await w.close();
    for (const c of workerConnections) c.disconnect();
    const keys = await redis.keys(`results:${queue.name}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });
  return {
    app,
    queue,
    redis,
    startWorker: (processor) => {
      let calls = 0;
      const connection = createRedis('worker', url);
      workerConnections.push(connection);
      const worker = new Worker<CollectionJobData>(
        queue.name,
        async (job) => {
          calls += 1;
          return processor(job);
        },
        { connection },
      );
      workers.push(worker);
      return { calls: () => calls, worker };
    },
  };
}

async function post(app: FastifyInstance, body: unknown) {
  return app.inject({ method: 'POST', url: '/collections', payload: body as object });
}

async function get(app: FastifyInstance, id: string) {
  return app.inject({ method: 'GET', url: `/collections/${id}` });
}

/** 상태가 원하는 값이 될 때까지 짧게 조회한다. 워커가 비동기로 돌기 때문이다. */
async function waitForStatus(app: FastifyInstance, id: string, status: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await get(app, id);
    if (res.json().status === status) return res;
    if (Date.now() > deadline) throw new Error(`${id}가 ${status}가 되지 않았다: ${res.body}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function row(seq: number): Transaction {
  return { seq, at: `2026-09-0${seq} 10:00:00`, memo: `거래${seq}`, withdrawal: 0, deposit: 1000, balance: 1000 * seq };
}

describe('toStatus', () => {
  it('BullMQ 상태를 네 가지로 옮기고, 없는 작업은 undefined다', () => {
    expect(['waiting', 'delayed', 'prioritized', 'waiting-children'].map(toStatus)).toEqual([
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
    expect(toStatus('active')).toBe('running');
    expect(toStatus('completed')).toBe('completed');
    expect(toStatus('failed')).toBe('failed');
    expect(toStatus('unknown')).toBeUndefined();
  });
});

describe('parseRequest', () => {
  it.each([
    ['객체 아님', '[]'],
    ['loginId 없음', { ...BODY, loginId: undefined }],
    ['loginId 모양', { ...BODY, loginId: 'demo 01' }],
    ['accountNo 모양', { ...BODY, accountNo: 'abc' }],
    ['기간 형식', { ...BODY, from: '2026/09/01' }],
    ['달력에 없는 날', { ...BODY, from: '2026-02-30' }],
    ['from > to', { ...BODY, from: '2026-10-01' }],
    ['비밀 필드', { ...BODY, password: 'demo-pass-01' }],
  ])('%s면 거절한다', (_label, body) => {
    expect(parseRequest(typeof body === 'string' ? JSON.parse(body) : body).ok).toBe(false);
  });
});

describe.skipIf(REDIS_URL === undefined)('수집 요청 API (Redis)', () => {
  it('POST는 202와 작업 ID, Location을 바로 준다. 워커가 없어도 기다리지 않는다', async () => {
    const { app, queue } = await makeLab();
    const res = await post(app, BODY);

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.id).toMatch(/^col_[0-9a-f]{32}$/);
    expect(body.status).toBe('queued');
    expect(res.headers.location).toBe(`/collections/${body.id}`);
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });

    const status = await get(app, body.id);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      id: body.id,
      status: 'queued',
      request: { loginId: 'demo01', accountNo: '000-11-222333', from: '2026-09-01 00:00:00', to: '2026-09-30 23:59:59' },
      attemptsMade: 0,
    });
  });

  it('같은 계좌·기간을 두 번 요청하면 같은 ID이고 큐에 작업은 하나다', async () => {
    const { app, queue } = await makeLab();
    const first = (await post(app, BODY)).json();
    // 같은 기간을 다른 표기로, 다른 로그인 ID로 보낸다. 계좌·기간이 같으면 같은 작업이다.
    const second = await post(app, { ...BODY, loginId: 'demo02', from: '2026-09-01 00:00:00' });

    expect(second.statusCode).toBe(202);
    expect(second.json().id).toBe(first.id);
    const counts = await queue.getJobCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
    // 먼저 들어온 요청이 남는다. add가 돌려주는 객체에는 두 번째 데이터가 실려 오지만
    // 저장된 것은 바뀌지 않는다.
    expect((await get(app, first.id)).json().request.loginId).toBe('demo01');

    const other = (await post(app, { ...BODY, to: '2026-09-29' })).json();
    expect(other.id).not.toBe(first.id);
  });

  it('잘못된 본문은 400이고 큐에 아무것도 넣지 않는다', async () => {
    const { app, queue } = await makeLab();
    for (const body of [{ ...BODY, from: '2026-13-01' }, { ...BODY, password: 'x' }, { accountNo: '000-11-222333' }]) {
      const res = await post(app, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('BAD_REQUEST');
    }
    const counts = await queue.getJobCounts();
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('상태가 대기 → 처리중 → 완료로 바뀌고, 완료면 결과를 seq 순으로 준다', async () => {
    const { app, queue, redis, startWorker } = await makeLab();
    const { id } = (await post(app, BODY)).json();
    expect((await get(app, id)).json().status).toBe('queued');

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    startWorker(async (job) => {
      await gate;
      // 워커(#13)가 쓸 모양 그대로. 순서를 섞어 넣어 읽는 쪽이 seq로 정렬하는지 본다.
      const key = resultsKey(queue.name, job.id as string);
      for (const r of [row(3), row(1), row(2)]) await redis.hset(key, String(r.seq), JSON.stringify(r));
      return { count: 3 };
    });

    await waitForStatus(app, id, 'running');
    release();
    const done = (await waitForStatus(app, id, 'completed')).json();
    expect(done.result.count).toBe(3);
    expect(done.result.rows).toEqual([row(1), row(2), row(3)]);
    expect(done.failure).toBeUndefined();
  });

  it('완료된 작업이 남아 있으면 같은 요청은 같은 ID로 완료를 돌려주고 다시 수집하지 않는다', async () => {
    const { app, startWorker } = await makeLab();
    const worker = startWorker(async () => ({ count: 0 }));
    const { id } = (await post(app, BODY)).json();
    await waitForStatus(app, id, 'completed');

    const again = await post(app, BODY);
    expect(again.json()).toEqual({ id, status: 'completed' });
    // 새 작업이 생겼다면 워커가 곧 집어 간다. 그럴 시간을 준 뒤 센다.
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.calls()).toBe(1);
  });

  /**
   * 멱등의 경계. BullMQ는 "같은 ID가 **지금 있으면**" 새로 만들지 않을 뿐이다. 작업이
   * 지워지면 같은 요청이 새 작업이 되어 다시 돈다. 그래서 `COLLECT_JOB_OPTIONS`가 완료
   * 작업을 지우지 않는다. 결과가 두 배가 되지 않게 막는 두 번째 겹(seq 키)은 #13이 맡는다.
   */
  it('완료 작업이 지워진 뒤라면 같은 요청이 같은 ID로 다시 수집된다', async () => {
    const { app, queue, startWorker } = await makeLab();
    const worker = startWorker(async () => ({ count: 0 }));
    const { id } = (await post(app, BODY)).json();
    await waitForStatus(app, id, 'completed');

    await queue.remove(id);
    expect((await get(app, id)).statusCode).toBe(404);

    expect((await post(app, BODY)).json().id).toBe(id);
    await waitForStatus(app, id, 'completed');
    expect(worker.calls()).toBe(2);
  });

  it('실패하면 마지막 실패 분류를 주고, 같은 요청이 와도 다시 돌리지 않는다', async () => {
    const { app, startWorker } = await makeLab();
    // AUTH_FAILED는 재시도하면 계정이 잠긴다. 워커는 시도 횟수를 남기지 않고 끝낸다.
    const worker = startWorker(async () => {
      throw new UnrecoverableError(formatFailedReason('AUTH_FAILED', 'HTTP 401 + X-Auth-Failed'));
    });
    const { id } = (await post(app, BODY)).json();
    const failed = (await waitForStatus(app, id, 'failed')).json();
    expect(failed.failure).toEqual({ kind: 'AUTH_FAILED', detail: 'HTTP 401 + X-Auth-Failed' });
    expect(failed.result).toBeUndefined();

    expect((await post(app, BODY)).json()).toEqual({ id, status: 'failed' });
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.calls()).toBe(1);
  });

  it('없는 ID는 404다. 이 API가 만들지 않는 모양의 ID는 큐에 묻지도 않는다', async () => {
    const { app, queue } = await makeLab();
    // 다른 경로로 들어간 숫자 ID 작업이 있어도 보이지 않는다.
    const foreign = await queue.add('collect', { ...BODY, from: 'x', to: 'y' });
    for (const id of ['col_' + '0'.repeat(32), String(foreign.id), 'col_xyz']) {
      const res = await get(app, id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error).toBe('NOT_FOUND');
    }
  });
});
