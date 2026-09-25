/**
 * 큐 워커의 프로세서. 작업 하나를 받아 수집하고, 결과를 쓰거나 실패를 처분한다.
 *
 * 실패에 무엇을 던질지는 `queue.ts`의 `DISPOSITION` 표만 따른다. 워커가 따로 판단하면
 * 표와 코드가 어긋나고, 어긋난 쪽이 AUTH_FAILED를 세 번 돌려 계정을 잠근다(#12 리뷰 재현).
 * 이 파일이 표에 없는 판단을 하는 곳은 세 군데다. 자격증명 차단기(작업을 가로질러 봐야 해서
 * 표 한 칸으로 표현이 안 된다), 분류되지 않은 예외(표 바깥의 실패), 그리고 BullMQ가 프로세서
 * 밖에서 실패시킨 작업(`onFailed`)이다.
 *
 * 의존성(수집 함수, Redis, 큐, 시계)을 주입받는다. 테스트가 실제 대상 서버를 붙이거나,
 * 대상 서버로는 만들기 어려운 실패(세션 토큰이 실린 UNKNOWN)를 가짜 수집 함수로 넣는다.
 */

import { Queue, RateLimitError, UnrecoverableError, Worker } from 'bullmq';
import type { Job, WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { redactForCapture } from '../client/capture.js';
import type { ClassifyInput, Failure } from '../client/classify.js';
import { DEFAULT_RATE_LIMIT_WAIT_SEC } from '../client/classify.js';
import type { Clock } from '../client/clock.js';
import type { FailureKind } from '../client/errors.js';
import type { CollectOptions, CollectResult } from '../client/session.js';
import {
  DISPOSITION,
  authBlockKey,
  deadLetterQueueName,
  formatFailedReason,
  parseFailedReason,
  resultsKey,
} from '../queue.js';
import type { CapturedRaw, CollectionJobData, DeadLetterData } from '../queue.js';

/** 프로세서가 남기는 사건. 진입점은 JSON 한 줄로 찍고, 테스트는 모아서 본다. */
export type WorkerEvent =
  | { event: 'completed'; jobId: string; attemptsMade: number; rows: number }
  | { event: 'rate-limited'; jobId: string; attemptsMade: number; kind: FailureKind; waitMs: number; detail: string }
  | { event: 'retry'; jobId: string; attemptsMade: number; kind: FailureKind | null; detail: string }
  | { event: 'dead-letter'; jobId: string; attemptsMade: number; kind: FailureKind | null; detail: string }
  | { event: 'dead-letter-error'; jobId: string; detail: string }
  | { event: 'auth-block-error'; jobId: string; detail: string }
  | { event: 'auth-blocked'; jobId: string; loginId: string };

export type ProcessorDeps = {
  /**
   * 수집 함수. 기본 조립은 `session.ts`의 `collect`에 undici 전송을 붙인 것(`index.ts`).
   * `options`는 이어받기(#19)다. 시작 페이지와, 페이지마다 결과·체크포인트를 쓰는 `onPage`를
   * 넘긴다. 무시하는 수집 함수(테스트의 가짜)는 처음부터 다 받아 돌려주면 된다.
   */
  collect: (data: CollectionJobData, options: CollectOptions) => Promise<CollectResult>;
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

/** `retry` 처분의 오류. 표 바깥의 예외와 구분해 바깥 catch가 DLQ를 두 번 쓰지 않게 한다. */
class DispositionError extends Error {}

/** 차단기 키에 남기는 값. 뒤따르는 작업이 무엇 때문에 막혔는지 DLQ에 옮겨 적는다. */
type AuthBlock = { jobId: string; kind: FailureKind; detail: string; at: string };

export type CollectionHandlers = {
  /** BullMQ 프로세서. */
  process: (job: Job<CollectionJobData>) => Promise<ProcessorResult>;
  /**
   * Worker의 `failed` 이벤트에 붙인다. 프로세서가 던진 실패는 이미 처분을 마쳤으므로 건너뛰고,
   * 두 경우만 DLQ에 쓴다.
   *
   * 1. **BullMQ가 프로세서를 부르지 않고 실패시킨 작업.** 처리 중 워커가 죽어 멈춘 작업
   *    (stalled)이 `maxStalledCount`(기본 1)를 넘으면, 6.3.8은 작업 해시에 `defa`(미뤄 둔
   *    실패 사유)를 남기고 대기로 돌린다. 다음에 꺼낸 워커는 프로세서 대신
   *    `UnrecoverableError('job stalled more than allowable limit')`로 실패시키고 `failed`
   *    이벤트만 낸다(`worker.js` `getUnrecoverableErrorMessage`). 프로세서가 모르는 실패라
   *    여기가 유일한 자리다. 분류가 없으므로 kind null이다.
   * 2. **처분은 정했는데 DLQ 쓰기가 실패한 작업.** 프로세서는 재시도를 막으려고 처분대로
   *    던지고(`recordDead` 주석), 못 쓴 항목을 여기서 한 번 더 쓴다.
   */
  onFailed: (job: Job<CollectionJobData> | undefined, error: Error) => Promise<void>;
};

export function createCollectionHandlers(deps: ProcessorDeps): CollectionHandlers {
  const { redis, queue, deadLetter, clock } = deps;
  const log = deps.log ?? (() => {});

  if (deadLetter.name !== deadLetterQueueName(queue.name)) {
    // 이름이 어긋나면 DLQ 항목이 사람이 보지 않는 큐에 쌓인다. 조용히 틀리는 자리라 던진다.
    throw new RangeError(`DLQ 이름은 ${deadLetterQueueName(queue.name)}여야 한다: ${deadLetter.name}`);
  }

  // `failed` 이벤트는 프로세서가 던진 그 오류 객체를 그대로 싣는다(`worker.js` `handleFailed`).
  // 객체로 "프로세서가 처분을 마친 실패"와 "BullMQ가 따로 만든 실패"를 가른다.
  const thrown = new WeakSet<Error>();
  const unwritten = new WeakMap<Error, DeadLetterData>();

  async function processCollection(job: Job<CollectionJobData>): Promise<ProcessorResult> {
    const jobId = job.id as string;
    try {
      return await run(job, jobId);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      // 처분 표를 지난 것은 그대로 올려 보낸다. 특히 RateLimitError를 감싸면 BullMQ가 알아보지
      // 못해 보통 실패로 세고 시도 횟수를 깎는다.
      if (error instanceof DispositionError || error instanceof UnrecoverableError || error instanceof RateLimitError) {
        thrown.add(error);
        throw error;
      }
      // 표 바깥의 예외(결과 쓰기 중 Redis 오류 등). 일시적일 수 있어 BullMQ의 재시도에
      // 맡기고, 마지막 시도라면 분류 없이 DLQ에 남긴다. 남기지 않으면 원래 큐의 실패
      // 목록에만 있고 DLQ에서는 보이지 않는다.
      if (isLastAttempt(job)) throw await recordDead(error, job, jobId, null, error.message);
      log({ event: 'retry', jobId, attemptsMade: job.attemptsMade, kind: null, detail: error.message });
      thrown.add(error);
      throw error;
    }
  }

  async function run(job: Job<CollectionJobData>, jobId: string): Promise<ProcessorResult> {
    const data = job.data;

    // 차단기는 수집보다 먼저 본다. 여기를 지나면 로그인 요청이 나간다.
    const blocked = await redis.get(authBlockKey(queue.name, data.loginId));
    if (blocked !== null) {
      log({ event: 'auth-blocked', jobId, loginId: data.loginId });
      const kind = blockedKind(blocked);
      const detail =
        `차단기: ${data.loginId}는 이전 작업의 ${kind}로 막혀 있어 로그인하지 않았다(${blocked}). ` +
        `자격증명을 고친 뒤 ${authBlockKey(queue.name, data.loginId)} 키를 지우고, 이 작업을 다시 돌리거나 지워야 한다`;
      throw await recordDead(new UnrecoverableError(formatFailedReason(kind, detail)), job, jobId, kind, detail);
    }

    let result: CollectResult;
    try {
      result = await deps.collect(data, {
        startPage: data.checkpoint?.nextPage ?? 1,
        onPage: async (rows, page) => {
          // **행을 먼저, 체크포인트를 나중에 쓴다.** 둘 사이에 워커가 죽으면 다시 시작한 쪽이
          // 같은 페이지를 한 번 더 받아 같은 seq에 덮어쓸 뿐이다. 반대 순서면 체크포인트만
          // 넘어가고 그 페이지의 행이 영영 빠진다.
          await writeResults(jobId, rows);
          await job.updateData({ ...job.data, checkpoint: { nextPage: page + 1 } });
        },
      });
    } catch (error) {
      // `collect`가 던지는 것은 자격증명 없음·공유키 형식 오류·기간 형식 오류(RangeError)다.
      // 수집 실패가 아니라 배치 설정이나 호출하는 쪽의 버그라서 일곱 종 어디에도 맞지 않고,
      // 다시 해도 풀리지 않는다. 분류 없이(kind null) 한 번에 끝낸다.
      if (error instanceof RangeError) {
        const detail = `설정 오류: ${error.message}`;
        throw await recordDead(new UnrecoverableError(detail), job, jobId, null, detail);
      }
      throw error;
    }

    if (result.ok) {
      // `onPage`를 부르지 않는 수집 함수도 있어 한 번 더 쓴다. seq 필드라 늘지 않는다.
      await writeResults(jobId, result.rows);
      // 건수는 이번 실행이 받은 행이 아니라 저장소 전체다. 이어받았으면 앞 주기에 쓴 행이
      // 이번 `result.rows`에 없다.
      const count = await redis.hlen(resultsKey(queue.name, jobId));
      log({ event: 'completed', jobId, attemptsMade: job.attemptsMade, rows: count });
      return { count };
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

    switch (DISPOSITION[kind]) {
      case 'rate-limit': {
        // 큐 전체를 멈춘다. Worker에 `limiter`가 있어야 다른 워커도 멈춘다(`createCollectionWorker`).
        // 대기 시간은 서버가 준 Retry-After다. RATE_LIMITED·IP_BLOCKED에는 분류기가 항상 채우지만,
        // 타입이 선택 필드라 없을 때는 분류기의 기본값(대상 서버 창 W)을 쓴다.
        //
        // IP_BLOCKED가 여기로 오는 것은 D2의 임시 처분이다(`queue.ts` DISPOSITION 주석). 출발지가
        // 하나라 전환할 곳이 없고, 대상 서버 차단은 Retry-After 뒤 스스로 풀린다. #14에서 출발지
        // 전환(FIRST_REMEDY의 ROTATE_EGRESS)이 들어오면 이 칸이 바뀐다.
        const waitSec = 'retryAfterSec' in failure && failure.retryAfterSec !== undefined ? failure.retryAfterSec : DEFAULT_RATE_LIMIT_WAIT_SEC;
        const waitMs = Math.max(1, Math.round(waitSec * 1000));
        log({ event: 'rate-limited', jobId, attemptsMade: job.attemptsMade, kind, waitMs, detail });
        await queue.rateLimit(waitMs);
        throw Worker.RateLimitError();
      }
      case 'retry': {
        // 마지막 시도면 BullMQ가 이 던짐으로 작업을 failed로 옮긴다. 그 전에 DLQ에 넣는다.
        const error = new DispositionError(formatFailedReason(kind, detail));
        if (isLastAttempt(job)) throw await recordDead(error, job, jobId, kind, detail);
        log({ event: 'retry', jobId, attemptsMade: job.attemptsMade, kind, detail });
        throw error;
      }
      case 'fail-now': {
        let note = '';
        if (blocksLogin(failure)) {
          // 차단기를 DLQ보다 **먼저** 건다. 차단기 쓰기가 실패해도 이 작업은 아래에서 재시도
          // 없이 끝나므로 비밀번호가 다시 나가지 않는다. 다만 같은 로그인 ID의 다른 작업은
          // 막히지 않으므로 사유에 남겨 사람이 보게 한다.
          const value: AuthBlock = { jobId, kind, detail, at: new Date(clock()).toISOString() };
          try {
            await redis.set(authBlockKey(queue.name, job.data.loginId), JSON.stringify(value));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log({ event: 'auth-block-error', jobId, detail: message });
            note = ` [차단기 기록 실패: ${message}. 같은 로그인 ID의 다른 작업은 막히지 않았다]`;
          }
        }
        const error = new UnrecoverableError(formatFailedReason(kind, detail + note));
        throw await recordDead(error, job, jobId, kind, detail + note, 'raw' in failure ? failure.raw : undefined);
      }
    }
  }

  /**
   * DLQ에 쓰고, 던질 오류를 돌려준다. **DLQ 쓰기가 실패해도 처분을 바꾸지 않는다.**
   *
   * 예전에는 쓰기 오류가 그대로 바깥으로 나가 일반 오류가 됐고, BullMQ가 fail-now 작업을
   * 다시 돌려 collect(비밀번호 전송)가 한 번 더 나갔다(리뷰 r5 재현). 이제는 정해 둔 오류
   * (UnrecoverableError 등)를 그대로 던지고, 못 쓴 항목은 `onFailed`가 이 오류 객체로 찾아
   * 한 번 더 쓴다. 그것도 실패하면 로그에만 남는다. 원래 큐의 `failedReason`은 남아 있다.
   *
   * 원본은 **여기서 한 번** `redactForCapture`를 거친다(`capture.ts`의 "저장 직전 한 곳" 계약).
   */
  async function recordDead(
    error: Error,
    job: Job<CollectionJobData>,
    jobId: string,
    kind: FailureKind | null,
    detail: string,
    raw?: ClassifyInput,
  ): Promise<Error> {
    const entry: DeadLetterData = {
      originalId: jobId,
      kind,
      detail,
      attemptsMade: job.attemptsMade + 1,
      failedAt: new Date(clock()).toISOString(),
      request: job.data,
      raw: raw === undefined ? null : capture(redactForCapture(raw)),
    };
    if (!(await writeDead(entry))) unwritten.set(error, entry);
    thrown.add(error);
    return error;
  }

  /**
   * DLQ 항목을 쓴다. 같은 작업 ID가 이미 있으면 **내용을 갱신한다.** 사람이 실패 작업을
   * `job.retry()`로 다시 돌려 또 실패하면 새 사유·시각이 보여야 한다. `add`만 쓰면 BullMQ는
   * 같은 ID를 새로 만들지 않고 옛 항목이 그대로 남는다(리뷰 r1). 성공하면 true.
   */
  async function writeDead(entry: DeadLetterData): Promise<boolean> {
    const jobId = entry.originalId;
    try {
      const existing = await deadLetter.getJob(jobId);
      if (existing === undefined) {
        // 지우지 않는다. DLQ는 사람이 볼 곳이고, 원래 큐의 실패 작업도 지우지 않는다(`COLLECT_JOB_OPTIONS`).
        await deadLetter.add('dead', entry, { jobId, removeOnComplete: false, removeOnFail: false });
      } else {
        await existing.updateData(entry);
      }
      log({ event: 'dead-letter', jobId, attemptsMade: entry.attemptsMade, kind: entry.kind, detail: entry.detail });
      return true;
    } catch (error) {
      log({ event: 'dead-letter-error', jobId, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  async function onFailed(job: Job<CollectionJobData> | undefined, error: Error): Promise<void> {
    if (job === undefined) return;
    const entry = unwritten.get(error);
    if (entry !== undefined) {
      unwritten.delete(error);
      await writeDead(entry);
      return;
    }
    if (thrown.has(error)) return;
    // 프로세서가 모르는 실패다. 재시도로 가는 실패면 아직 DLQ 대상이 아니다.
    try {
      if ((await job.getState()) !== 'failed') return;
    } catch (stateError) {
      log({ event: 'dead-letter-error', jobId: String(job.id), detail: stateError instanceof Error ? stateError.message : String(stateError) });
      return;
    }
    const reason = job.failedReason ?? error.message;
    const parsed = parseFailedReason(reason);
    await writeDead({
      originalId: job.id as string,
      kind: parsed.kind,
      detail: `BullMQ가 프로세서 밖에서 실패시켰다: ${reason}`,
      attemptsMade: job.attemptsMade,
      failedAt: new Date(clock()).toISOString(),
      request: job.data,
      raw: null,
    });
  }

  return { process: processCollection, onFailed };
}

/**
 * 프로세서만 만든다. **`onFailed`가 빠지므로** BullMQ가 프로세서 밖에서 실패시킨 작업은 DLQ에
 * 남지 않는다. 워커는 `createCollectionWorker`로 만든다.
 */
export function createProcessor(deps: ProcessorDeps): CollectionHandlers['process'] {
  return createCollectionHandlers(deps).process;
}

/**
 * 같은 로그인 ID로 더 로그인하면 안 되는 실패인가.
 *
 * - AUTH_FAILED: 자격증명 거부. 다시 보내면 비밀번호 오류가 쌓여 계정이 잠긴다.
 * - 1차 인증(비밀번호를 보낸 단계)의 UNKNOWN: 구분 헤더 없는 401, 423처럼 분류기가 모르는
 *   응답이다. 분류기는 "모르는 401은 자격증명 거부일 수 있다"며 재인증을 피한다
 *   (`classify.ts` `classify401`). 워커도 같은 이유로 계정 단위로 막는다.
 *
 * TRANSIENT·RATE_LIMITED·IP_BLOCKED는 인증 단계에서 나도 막지 않는다. 환경 문제라 자격증명과
 * 상관이 없다. 2차 인증의 UNKNOWN도 막지 않는다. 대상 서버는 OTP 실패를 잠금에 세지 않고
 * (`target/accounts.ts` `verifyOtp`), 비밀번호는 이미 통과한 뒤다.
 */
function blocksLogin(failure: Failure): boolean {
  return failure.kind === 'AUTH_FAILED' || (failure.kind === 'UNKNOWN' && failure.authStage === 'login');
}

function blockedKind(value: string): FailureKind {
  try {
    const parsed = JSON.parse(value) as Partial<AuthBlock>;
    if (parsed.kind === 'UNKNOWN') return 'UNKNOWN';
  } catch {
    // 사람이 손으로 넣은 값일 수 있다. 막는다는 뜻만 읽는다.
  }
  return 'AUTH_FAILED';
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
 *
 * 조인 limiter도 429가 **난 뒤**의 간격은 지키지 못한다. `queue.rateLimit`이 limiter가 창을
 * 세는 키(`bull:<큐>:limiter`)를 조건 없이 `SET ... PX`로 덮어써서(bullmq 6.3.8
 * `redis-queue-backend.js` `setRateLimit`), 그 주기는 Retry-After 간격이 된다. 더 긴 쪽을 남기는
 * Lua로 막을 수 있지만 BullMQ 내부 키 모양에 묶이므로 하지 않았다.
 */
export const DEFAULT_WORKER_LIMITER: WorkerLimiter = { max: 100, duration: 1000 };

export type CollectionWorkerOptions = {
  deps: ProcessorDeps;
  /** 워커용 연결. `createRedis('worker')`로 만든 것(maxRetriesPerRequest null)이어야 한다. */
  connection: Redis;
  concurrency?: number;
  limiter?: WorkerLimiter;
  /** 잠금·멈춤 검사 주기. 멈춘 작업 경로를 짧게 재현하려는 테스트·실측용이다. */
  stalled?: Pick<WorkerOptions, 'lockDuration' | 'stalledInterval' | 'maxStalledCount'>;
};

/**
 * 워커를 만든다. 진입점과 테스트가 같은 옵션으로 만들게 하려고 여기에 뒀다. 테스트가
 * 따로 만들면 `limiter`를 빠뜨려도 테스트는 통과하고(워커 하나면 부른 워커 자신은 쉰다)
 * 운영에서만 큐 전체 정지가 사라진다. `failed` 이벤트 처리(`onFailed`)도 여기서 붙인다.
 *
 * **`maxStartedAttempts`는 켜지 않는다.** 속도 제한으로 되돌아갈 때마다 `attemptsStarted`가
 * 올라 그 상한에서 작업이 실패한다(스파이크 1번). 켜면 "속도 제한은 시도 횟수를 깎지
 * 않는다"(`CONSUMES_ATTEMPT`)가 다른 이름으로 깨진다.
 */
export function createCollectionWorker(options: CollectionWorkerOptions): Worker<CollectionJobData, ProcessorResult> {
  const { deps, connection } = options;
  const handlers = createCollectionHandlers(deps);
  const worker = new Worker<CollectionJobData, ProcessorResult>(deps.queue.name, handlers.process, {
    connection,
    concurrency: options.concurrency ?? 1,
    limiter: options.limiter ?? DEFAULT_WORKER_LIMITER,
    ...options.stalled,
  });
  // 이벤트 처리기는 던지지 않는다(`onFailed`가 쓰기 오류를 로그로 바꾼다). 던지면 처리되지
  // 않은 거부로 프로세스가 죽는다.
  worker.on('failed', (job, error) => void handlers.onFailed(job, error));
  return worker;
}
