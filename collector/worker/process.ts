/**
 * 큐 워커의 프로세서. 작업 하나를 받아 수집하고, 결과를 쓰거나 실패를 처분한다.
 *
 * 실패에 무엇을 던질지는 `queue.ts`의 `DISPOSITION` 표만 따른다. 워커가 따로 판단하면
 * 표와 코드가 어긋나고, 어긋난 쪽이 AUTH_FAILED를 세 번 돌려 계정을 잠근다(#12 리뷰 재현).
 * 이 파일이 표에 없는 판단을 하는 곳은 두 군데뿐이다. AUTH_FAILED 차단기(작업을 가로질러
 * 봐야 해서 표 한 칸으로 표현이 안 된다)와 분류되지 않은 예외(표 바깥의 실패)다.
 *
 * 의존성(수집 함수, Redis, 큐, 시계)을 주입받는다. 테스트가 실제 대상 서버를 붙이거나,
 * 대상 서버로는 만들기 어려운 실패(세션 토큰이 실린 UNKNOWN)를 가짜 수집 함수로 넣는다.
 */

import { Queue, RateLimitError, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { redactForCapture } from '../client/capture.js';
import type { ClassifyInput, Failure } from '../client/classify.js';
import { DEFAULT_RATE_LIMIT_WAIT_SEC } from '../client/classify.js';
import type { Clock } from '../client/clock.js';
import type { FailureKind } from '../client/errors.js';
import type { CollectResult } from '../client/session.js';
import {
  DISPOSITION,
  authBlockKey,
  deadLetterQueueName,
  formatFailedReason,
  resultsKey,
} from '../queue.js';
import type { CapturedRaw, CollectionJobData, DeadLetterData } from '../queue.js';

/** 프로세서가 남기는 사건. 진입점은 JSON 한 줄로 찍고, 테스트는 모아서 본다. */
export type WorkerEvent =
  | { event: 'completed'; jobId: string; attemptsMade: number; rows: number }
  | { event: 'rate-limited'; jobId: string; attemptsMade: number; waitMs: number; detail: string }
  | { event: 'retry'; jobId: string; attemptsMade: number; kind: FailureKind | null; detail: string }
  | { event: 'dead-letter'; jobId: string; attemptsMade: number; kind: FailureKind | null; detail: string }
  | { event: 'auth-blocked'; jobId: string; loginId: string };

export type ProcessorDeps = {
  /** 수집 함수. 기본 조립은 `session.ts`의 `collect`에 undici 전송을 붙인 것(`index.ts`). */
  collect: (data: CollectionJobData) => Promise<CollectResult>;
  /** 결과 저장소와 차단기를 읽고 쓰는 연결. */
  redis: Redis;
  /** 원래 큐. 이름으로 결과 키를 만들고, `rateLimit`으로 큐 전체를 멈춘다. */
  queue: Queue<CollectionJobData>;
  /** 실패 목록. 이름은 `deadLetterQueueName(queue.name)`이어야 한다. */
  deadLetter: Queue<DeadLetterData>;
  clock: Clock;
  log?: (event: WorkerEvent) => void;
};

export type ProcessorResult = { count: number };

/**
 * 표 바깥의 실패를 표 안의 것과 구분하려는 표시. `retry` 처분으로 던지는 오류는 이미
 * DLQ 처리를 마쳤으므로, 바깥 catch가 다시 처리하지 않게 한다.
 */
class DispositionError extends Error {}

export function createProcessor(deps: ProcessorDeps) {
  const { redis, queue, deadLetter, clock } = deps;
  const log = deps.log ?? (() => {});

  if (deadLetter.name !== deadLetterQueueName(queue.name)) {
    // 이름이 어긋나면 DLQ 항목이 사람이 보지 않는 큐에 쌓인다. 조용히 틀리는 자리라 던진다.
    throw new RangeError(`DLQ 이름은 ${deadLetterQueueName(queue.name)}여야 한다: ${deadLetter.name}`);
  }

  return async function processCollection(job: Job<CollectionJobData>): Promise<ProcessorResult> {
    const jobId = job.id as string;
    try {
      return await run(job, jobId);
    } catch (error) {
      // 처분 표를 지난 것은 그대로 올려 보낸다. 특히 RateLimitError를 감싸면 BullMQ가 알아보지
      // 못해 보통 실패로 세고 시도 횟수를 깎는다.
      if (error instanceof DispositionError || error instanceof UnrecoverableError || error instanceof RateLimitError) throw error;
      // 표 바깥의 예외(결과 쓰기 중 Redis 오류 등). 일시적일 수 있어 BullMQ의 재시도에
      // 맡기고, 마지막 시도라면 분류 없이 DLQ에 남긴다. 남기지 않으면 원래 큐의 실패
      // 목록에만 있고 DLQ에서는 보이지 않는다.
      const detail = error instanceof Error ? error.message : String(error);
      if (isLastAttempt(job)) await deadLetterOf(job, jobId, null, detail);
      else log({ event: 'retry', jobId, attemptsMade: job.attemptsMade, kind: null, detail });
      throw error;
    }
  };

  async function run(job: Job<CollectionJobData>, jobId: string): Promise<ProcessorResult> {
    const data = job.data;

    // 차단기는 수집보다 먼저 본다. 여기를 지나면 로그인 요청이 나간다.
    const blocked = await redis.get(authBlockKey(queue.name, data.loginId));
    if (blocked !== null) {
      log({ event: 'auth-blocked', jobId, loginId: data.loginId });
      const detail =
        `차단기: ${data.loginId}는 이전 작업의 AUTH_FAILED로 막혀 있어 로그인하지 않았다(${blocked}). ` +
        `자격증명을 고친 뒤 ${authBlockKey(queue.name, data.loginId)} 키를 지워야 풀린다`;
      await deadLetterOf(job, jobId, 'AUTH_FAILED', detail);
      throw new UnrecoverableError(formatFailedReason('AUTH_FAILED', detail));
    }

    let result: CollectResult;
    try {
      result = await deps.collect(data);
    } catch (error) {
      // `collect`가 던지는 것은 자격증명 없음·공유키 형식 오류·기간 형식 오류(RangeError)다.
      // 수집 실패가 아니라 배치 설정이나 호출하는 쪽의 버그라서 일곱 종 어디에도 맞지 않고,
      // 다시 해도 풀리지 않는다. 분류 없이(kind null) 한 번에 끝낸다.
      if (error instanceof RangeError) {
        const detail = `설정 오류: ${error.message}`;
        await deadLetterOf(job, jobId, null, detail);
        throw new UnrecoverableError(detail);
      }
      throw error;
    }

    if (result.ok) {
      await writeResults(jobId, result.rows);
      log({ event: 'completed', jobId, attemptsMade: job.attemptsMade, rows: result.rows.length });
      return { count: result.rows.length };
    }
    return dispose(job, jobId, result);
  }

  /**
   * 결과를 **반환하기 전에** 전부 쓴다(`queue.ts` `resultsKey` 약속). HSET 한 번에 모든
   * 필드를 넣으므로 Redis 안에서 원자적이다. 중간까지만 쓰인 해시를 API가 읽을 틈이 없다.
   *
   * 필드가 seq라서 같은 작업이 다시 돌아도(작업을 지우고 다시 넣은 경우, 결과를 쓴 뒤
   * 반환 전에 워커가 죽어 BullMQ가 다시 돌린 경우) 행이 늘지 않는다. 멱등의 두 번째 겹이다.
   * 결정론적 원장이라 같은 seq는 같은 값이고, 덮어써도 바뀌지 않는다.
   *
   * 행이 0개면 아무것도 쓰지 않는다. 빈 해시는 Redis에 존재할 수 없어서 "0건 완료"와 "안
   * 씀"이 키로는 같아 보인다. API는 작업 상태(completed)를 먼저 보고 해시를 읽으므로 0건이
   * 맞게 나간다.
   */
  async function writeResults(jobId: string, rows: readonly { seq: number }[]): Promise<void> {
    if (rows.length === 0) return;
    const fields: Record<string, string> = {};
    for (const row of rows) fields[String(row.seq)] = JSON.stringify(row);
    await redis.hset(resultsKey(queue.name, jobId), fields);
  }

  async function dispose(job: Job<CollectionJobData>, jobId: string, failure: Failure): Promise<never> {
    const { kind, detail } = failure;
    const reason = formatFailedReason(kind, detail);

    switch (DISPOSITION[kind]) {
      case 'rate-limit': {
        // 큐 전체를 멈춘다. Worker에 `limiter`가 있어야 다른 워커도 멈춘다(`createCollectionWorker`).
        // 대기 시간은 서버가 준 Retry-After다. RATE_LIMITED에는 분류기가 항상 채우지만, 타입이
        // 선택 필드라 없을 때는 분류기의 기본값(대상 서버 창 W)을 쓴다.
        const waitSec = 'retryAfterSec' in failure && failure.retryAfterSec !== undefined ? failure.retryAfterSec : DEFAULT_RATE_LIMIT_WAIT_SEC;
        const waitMs = Math.max(1, Math.round(waitSec * 1000));
        log({ event: 'rate-limited', jobId, attemptsMade: job.attemptsMade, waitMs, detail });
        await queue.rateLimit(waitMs);
        throw Worker.RateLimitError();
      }
      case 'retry': {
        // 마지막 시도면 BullMQ가 이 던짐으로 작업을 failed로 옮긴다. 그 전에 DLQ에 넣는다.
        if (isLastAttempt(job)) await deadLetterOf(job, jobId, kind, detail);
        else log({ event: 'retry', jobId, attemptsMade: job.attemptsMade, kind, detail });
        throw new DispositionError(reason);
      }
      case 'fail-now': {
        if (kind === 'AUTH_FAILED') {
          // 차단기를 DLQ보다 **먼저** 건다. DLQ 넣기가 실패하면 이 함수는 일반 오류로 끝나
          // BullMQ가 작업을 다시 돌리는데, 그때 차단기가 이미 있어야 로그인이 다시 나가지 않는다.
          await redis.set(
            authBlockKey(queue.name, job.data.loginId),
            JSON.stringify({ jobId, detail, at: new Date(clock()).toISOString() }),
          );
        }
        // IP_BLOCKED: D2는 출발지가 하나라 전환할 곳이 없어 여기로 온다. #14에서 출발지
        // 전환(FIRST_REMEDY의 ROTATE_EGRESS)이 들어오면 `DISPOSITION.IP_BLOCKED`가 바뀌고
        // 이 줄 대신 전환 경로를 탄다.
        await deadLetterOf(job, jobId, kind, detail, 'raw' in failure ? failure.raw : undefined);
        throw new UnrecoverableError(reason);
      }
    }
  }

  /**
   * DLQ에 넣는다. 원본은 **여기서 한 번** `redactForCapture`를 거친다(`capture.ts`의 "저장
   * 직전 한 곳" 계약). 세션 층도 경계에서 가리지만, 그 뒤에 원본을 만드는 자리가 생겨도
   * 저장하는 자리는 여기 하나라서 빠뜨리지 않는다.
   */
  async function deadLetterOf(
    job: Job<CollectionJobData>,
    jobId: string,
    kind: FailureKind | null,
    detail: string,
    raw?: ClassifyInput,
  ): Promise<void> {
    const attemptsMade = job.attemptsMade + 1;
    const entry: DeadLetterData = {
      originalId: jobId,
      kind,
      detail,
      attemptsMade,
      failedAt: new Date(clock()).toISOString(),
      request: job.data,
      raw: raw === undefined ? null : capture(redactForCapture(raw)),
    };
    // 지우지 않는다. DLQ는 사람이 볼 곳이고, 원래 큐의 실패 작업도 지우지 않는다(`COLLECT_JOB_OPTIONS`).
    await deadLetter.add('dead', entry, { jobId, removeOnComplete: false, removeOnFail: false });
    log({ event: 'dead-letter', jobId, attemptsMade, kind, detail });
  }
}

/**
 * 이번 시도가 마지막인가. 처리 중인 작업의 `attemptsMade`는 **이전에** 시도 횟수를 깎은
 * 실패 수다(스파이크 5번: 0, 1, 2). 이번 시도까지 세면 +1이다.
 */
function isLastAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

function capture(raw: ClassifyInput): CapturedRaw {
  if ('network' in raw) return { network: raw.network };
  return { status: raw.status, headers: raw.headers, bodyBase64: raw.body.toString('base64') };
}

export type WorkerLimiter = { max: number; duration: number };

/**
 * Worker의 `limiter` 기본값. **이 값의 역할은 처리량 제한이 아니라 "큐 전체 정지"를 켜는
 * 것이다.** `queue.rateLimit()`이 건 제한 키를 작업 꺼내기 스크립트가 보는 것은 `limiter`가
 * 있을 때뿐이다(스파이크 2·3번). 없으면 429를 받은 워커만 쉬고 다른 워커는 계속 보낸다.
 *
 * 대상 서버 기본 임계값(W=10초, N=5요청, `target/switches.ts`)과의 관계: 작업 하나가
 * 보내는 요청은 로그인 2 + 페이지 수 + 끝을 확인하는 빈 페이지 1이다(demo02 4개, demo01
 * 10개). 미리 한도 안에 머물려면 `max`를 "N ÷ 작업당 요청 수"로, `duration`을 W로 둬야
 * 하는데, 기본 임계값이면 10초에 작업 1개다. 속도 제한 스위치가 꺼진 기준선에서 200건에
 * 30분이 넘는다. 그래서 기본값은 느슨하게 두고(초당 100개, 사실상 제한 없음), 속도 제한은
 * 서버의 Retry-After만큼 큐를 멈추는 사후 대응으로 맞춘다.
 *
 * **느슨한 기본값의 대가(실측, `docs/evidence/d2-pipeline.md`).** 속도 제한을 켠 대상 서버에
 * 워커 2개면 제한이 풀리는 순간 두 워커가 같이 출발해 한 창(요청 5개)을 나눠 먹고 둘 다 다시
 * 429를 받는다. 시도 횟수를 깎지 않으므로 DLQ로도 가지 않고 10초마다 같은 일이 되풀이됐다
 * (TROUBLESHOOTING 4번). 속도 제한을 켜는 측정(#15)에서는 환경변수(`WORKER_LIMIT_MAX`,
 * `WORKER_LIMIT_DURATION_MS`)로 위 식대로 조인다. 1개/11초로 조이자 429 없이 끝났다.
 */
export const DEFAULT_WORKER_LIMITER: WorkerLimiter = { max: 100, duration: 1000 };

export type CollectionWorkerOptions = {
  deps: ProcessorDeps;
  /** 워커용 연결. `createRedis('worker')`로 만든 것(maxRetriesPerRequest null)이어야 한다. */
  connection: Redis;
  concurrency?: number;
  limiter?: WorkerLimiter;
};

/**
 * 워커를 만든다. 진입점과 테스트가 같은 옵션으로 만들게 하려고 여기에 뒀다. 테스트가
 * 따로 만들면 `limiter`를 빠뜨려도 테스트는 통과하고(워커 하나면 부른 워커 자신은 쉰다)
 * 운영에서만 큐 전체 정지가 사라진다.
 *
 * **`maxStartedAttempts`는 켜지 않는다.** 속도 제한으로 되돌아갈 때마다 `attemptsStarted`가
 * 올라 그 상한에서 작업이 실패한다(스파이크 1번). 켜면 "속도 제한은 시도 횟수를 깎지
 * 않는다"(`CONSUMES_ATTEMPT`)가 다른 이름으로 깨진다.
 */
export function createCollectionWorker(options: CollectionWorkerOptions): Worker<CollectionJobData, ProcessorResult> {
  const { deps, connection } = options;
  return new Worker<CollectionJobData, ProcessorResult>(deps.queue.name, createProcessor(deps), {
    connection,
    concurrency: options.concurrency ?? 1,
    limiter: options.limiter ?? DEFAULT_WORKER_LIMITER,
  });
}
