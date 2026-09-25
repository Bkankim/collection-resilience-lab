/**
 * 큐 워커 진입점. 조립은 `process.ts`가 하고 여기서는 연결을 만들고 신호를 받는다.
 *
 * 워커를 여러 프로세스로 띄워 큐를 나눠 먹게 하는 것이 기본 배치다(M2: 워커가 나눠 처리).
 * 그래서 로그 한 줄마다 워커 이름(`WORKER_NAME`)과 pid를 붙인다. 어느 워커가 무엇을
 * 처리했는지와, 속도 제한 동안 두 워커가 모두 멈췄는지를 로그만으로 볼 수 있다.
 *
 * 환경변수:
 * - `TARGET_ORIGIN`: 대상 서버. 기본 `http://127.0.0.1:8080`.
 * - `REDIS_URL`: 기본 `redis://127.0.0.1:6379`.
 * - `QUEUE_NAME`: 기본 `collections`(API와 같은 큐).
 * - `WORKER_NAME`: 로그에 찍을 이름. 기본 `worker-<pid>`.
 * - `WORKER_CONCURRENCY`: 한 프로세스가 동시에 돌리는 작업 수. 기본 1.
 * - `WORKER_LIMIT_MAX`, `WORKER_LIMIT_DURATION_MS`: BullMQ `limiter`. 기본값과 대상 서버
 *   임계값의 관계는 `process.ts`의 `DEFAULT_WORKER_LIMITER` 주석.
 * - `WORKER_NO_PROGRESS_CYCLES`: 진행 기반 상한(#19). 새 페이지 없이 지나간 속도 제한·차단
 *   주기가 이만큼 이어지면 NO_PROGRESS로 DLQ에 보낸다. 기본 3(`DEFAULT_NO_PROGRESS_CYCLES`).
 */

import { Queue } from 'bullmq';

import { systemClock } from '../client/clock.js';
import { collect } from '../client/session.js';
import { createUndiciTransport } from '../client/transport.js';
import { COLLECTION_QUEUE, createRedis, deadLetterQueueName } from '../queue.js';
import type { CollectionJobData, DeadLetterData } from '../queue.js';
import { DEFAULT_NO_PROGRESS_CYCLES, DEFAULT_WORKER_LIMITER, createCollectionWorker } from './process.js';
import type { WorkerEvent } from './process.js';

const name = nonBlank(process.env.WORKER_NAME) ?? `worker-${process.pid}`;
const origin = nonBlank(process.env.TARGET_ORIGIN) ?? 'http://127.0.0.1:8080';
const queueName = nonBlank(process.env.QUEUE_NAME) ?? COLLECTION_QUEUE;
const concurrency = positiveInt('WORKER_CONCURRENCY', 1);
const limiter = {
  max: positiveInt('WORKER_LIMIT_MAX', DEFAULT_WORKER_LIMITER.max),
  duration: positiveInt('WORKER_LIMIT_DURATION_MS', DEFAULT_WORKER_LIMITER.duration),
};
const noProgressCycles = positiveInt('WORKER_NO_PROGRESS_CYCLES', DEFAULT_NO_PROGRESS_CYCLES);

function print(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), worker: name, pid: process.pid, ...record }));
}

// 큐·DLQ·결과 쓰기는 생산자 연결 하나를 같이 쓰고, 워커의 블로킹 연결은 따로 둔다.
// 블로킹 연결에 다른 명령을 섞으면 꺼내기를 기다리는 동안 그 명령이 막힌다.
const redis = createRedis('producer');
const workerConnection = createRedis('worker');
const queue = new Queue<CollectionJobData>(queueName, { connection: redis });
const deadLetter = new Queue<DeadLetterData>(deadLetterQueueName(queueName), { connection: redis });
const transport = createUndiciTransport({ origin });

const worker = createCollectionWorker({
  connection: workerConnection,
  concurrency,
  limiter,
  deps: {
    collect: (data, options) => collect({ transport, clock: systemClock }, data.loginId, data.accountNo, data.from, data.to, options),
    redis,
    queue,
    deadLetter,
    clock: systemClock,
    log: (event: WorkerEvent) => print(event),
    noProgressCycles,
  },
});

// 워커 자체의 오류(연결 끊김 등). 처리하지 않으면 EventEmitter가 던져 프로세스가 죽는다.
worker.on('error', (error) => print({ event: 'worker-error', detail: error.message }));

/**
 * 종료 신호에서 `worker.close()`로 처리 중인 작업이 끝나기를 기다린 뒤 연결을 닫는다.
 * 기다리지 않고 끊으면 처리 중이던 작업은 잠금이 풀린 뒤 멈춘 작업(stalled)으로 다시
 * 돌고, 그동안 대상 서버에 보낸 요청이 한 번 더 나간다. 결과는 seq 필드라 늘지 않지만
 * 속도 제한 창은 그만큼 먹는다.
 */
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void (async () => {
      print({ event: 'shutdown', signal });
      await worker.close();
      await queue.close();
      await deadLetter.close();
      workerConnection.disconnect();
      await redis.quit();
      print({ event: 'closed' });
      process.exit(0);
    })();
  });
}

await worker.waitUntilReady();
print({ event: 'ready', queue: queueName, origin, concurrency, limiter, noProgressCycles });

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

function positiveInt(key: string, fallback: number): number {
  const raw = nonBlank(process.env[key]);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // 틀린 값을 기본값으로 바꿔 주지 않는다. `WORKER_LIMIT_MAX=abc`가 조용히 100이 되면
  // 조였다고 믿는 측정이 조이지 않은 채 돈다.
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key}는 1 이상의 정수여야 한다: ${raw}`);
  return value;
}
