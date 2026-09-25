/**
 * 큐 워커의 프로세서. 작업 하나를 받아 수집하고, 결과를 쓰거나 실패를 처분한다.
 *
 * 실패에 무엇을 던질지는 `queue.ts`의 `DISPOSITION` 표만 따른다. 워커가 따로 판단하면
 * 표와 코드가 어긋나고, 어긋난 쪽이 AUTH_FAILED를 세 번 돌려 계정을 잠근다(#12 리뷰 재현).
 * 이 파일이 표에 없는 판단을 하는 곳은 네 군데다. 자격증명 차단기(작업을 가로질러 봐야 해서
 * 표 한 칸으로 표현이 안 된다), 분류되지 않은 예외(표 바깥의 실패), BullMQ가 프로세서 밖에서
 * 실패시킨 작업(`onFailed`), 그리고 진행 기반 상한(NO_PROGRESS, #19)이다. 마지막 것은 응답
 * 하나가 아니라 큐 전체의 여러 주기를 가로질러 보는 판단이라 표에 칸이 없다.
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
  progressKey,
  resultsKey,
} from '../queue.js';
import type { CapturedRaw, CollectionJobData, DeadLetterData, DeadLetterKind } from '../queue.js';

/** 프로세서가 남기는 사건. 진입점은 JSON 한 줄로 찍고, 테스트는 모아서 본다. */
export type WorkerEvent =
  | { event: 'completed'; jobId: string; attemptsMade: number; rows: number }
  | { event: 'rate-limited'; jobId: string; attemptsMade: number; kind: FailureKind; waitMs: number; detail: string }
  | { event: 'retry'; jobId: string; attemptsMade: number; kind: FailureKind | null; detail: string }
  | { event: 'dead-letter'; jobId: string; attemptsMade: number; kind: DeadLetterKind | null; detail: string }
  | { event: 'dead-letter-error'; jobId: string; detail: string }
  | { event: 'progress-count-error'; jobId: string; detail: string }
  | { event: 'resume-reset'; jobId: string; detail: string }
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
  /**
   * 진행 기반 상한(#19). 큐 전체에서 페이지도 완료도 없이 이어진 속도 제한·차단 주기가 이만큼이면
   * 그 주기에 제한을 받은 작업을 DLQ에 NO_PROGRESS로 보낸다. 기본 `DEFAULT_NO_PROGRESS_CYCLES`.
   */
  noProgressCycles?: number;
};

/**
 * 진행 기반 상한의 기본값. 규칙은 이렇다(`COUNT_CYCLE`).
 *
 * - 주기 하나는 큐 정지 한 번이다. 같은 정지 안의 제한 여럿은 한 주기다.
 * - 진행은 큐의 어느 작업이든 페이지를 받거나 작업을 완료한 것이다. 페이지 없이 끝난 완료(빈 계좌,
 *   빈 끝 페이지만 남은 이어받기)도 진행이다.
 * - 직전 주기 뒤로 진행이 있었으면 연속 수는 0이다. 같은 주기 안에서 앞선 제한 뒤에 진행이 있었어도 0이다.
 * - 직전 정지가 끝난 지 `STALE_STREAK_MS`(60초)가 지나 온 제한은 연속이 아니다. 1부터 다시 센다.
 * - 연속 수가 이 값에 닿은 주기에 제한을 받은 작업이 NO_PROGRESS로 DLQ에 간다.
 *
 * 창(N)이 동시에 출발하는 워커들의 로그인 비용(워커당 2요청)보다 크면 주기마다 누군가는 한 페이지
 * 이상 받으므로 이 상한에 닿지 않는다. 닿는 것은 창이 로그인 비용 이하라 아무도 못 나아가는 경우다.
 * 3은 한두 주기의 우연(차단이 풀리는 순간과 요청이 엇갈린 주기)은 넘기고, 그 이상은 기다려도
 * 달라지지 않는다고 보는 값이다. 운영에서는 `WORKER_NO_PROGRESS_CYCLES`로 바꾼다.
 *
 * 남는 틈: 진행은 페이지를 받은 직후 한 번 왕복으로 센다. 그 한 번 왕복보다 짧은 간격으로 다른 워커의
 * 429가 먼저 주기를 세고, 마침 그 주기가 상한에 닿는 주기라면 그 작업은 NO_PROGRESS로 간다. 보통은
 * 상한 직전까지 무진행 주기가 이어진 뒤에만 생기지만, **NO_PROGRESS가 난 뒤 60초 안에는 연속 수가 이미
 * 상한 이상이라 회복된 큐의 첫 주기에서 이 경쟁에 지면 바로 DLQ다**(#19 최종 리뷰 7). 실측 조건(창 2초,
 * N=5, 워커 2개, 연속 3을 심음)에서 페이지 응답 2ms 뒤 429, 진행 세기가 eval보다 약 1ms 먼저였고 20회 중
 * 진 적은 없다. 회복된 큐에서 이 경쟁 말고 첫 주기가 무진행이 되는 길(첫 로그인이 429)은 창이 아직 차
 * 있다는 뜻이라 회복된 것이 아니고, 대기 작업과 같은 길로 끝나는 것이 규칙대로다.
 *
 * 처음에는 작업마다 셌다. 워커 2개가 한 창을 나눠 쓰면 주기마다 한 작업만 한 페이지를 받는데,
 * 계속 진 작업이 큐는 나아가는 중에 NO_PROGRESS로 갔다(d3-resume.md, 기본 임계값 실측).
 *
 * **이 상한은 공정성을 다루지 않는다.** 큐가 나아가는 동안 한 작업이 경쟁에서 계속 지면 그
 * 작업은 굶는다(starvation). 상한에 걸리지 않고, 다른 작업이 끝나 창이 비면 그때 나아간다.
 * 작업들이 계속 들어오는 큐에서 특정 작업이 얼마나 늦어지는지는 재지 않았다.
 */
export const DEFAULT_NO_PROGRESS_CYCLES = 3;

/**
 * 속도 제한·차단 주기 하나를 센다. 워커 프로세스 여럿이 부르므로 읽고 쓰기를 스크립트 하나로
 * 묶는다. 돌려주는 값은 큐 전체의 연속 무진행 주기 수다. `pages`는 페이지를 받거나 작업이
 * 완료될 때마다 오른다(`creditProgress`).
 *
 * - 직전 주기의 큐 정지(`until`)가 끝나기 전에 온 제한은 같은 주기다. 워커 2개가 같이 출발해
 *   같은 순간 429를 받으면 주기는 하나다. 다시 더하지 않는다. 다만 그 주기의 앞선 제한 뒤로 진행이
 *   있었으면(`pages > seen`) 0으로 되돌린다. 앞선 제한 때는 아직 아무도 못 받았어도, 같은 정지 안에서
 *   다른 워커가 받은 페이지가 있으면 큐는 나아간 것이다(#19 리뷰 3).
 * - 새 주기면, 직전 주기 뒤로 진행이 있었는지(`pages > seen`) 본다. 있었으면 0, 없으면 1을 더한다.
 * - **직전 정지가 끝난 지 `STALE_STREAK_MS`가 지났으면 이어진 주기가 아니다.** 연속 수를 0에서
 *   다시 센다. 사고가 이어지는 동안에는 정지가 풀리자마자 다음 요청이 나가 곧 다음 제한을 받는다.
 *   정지가 풀리고 한참 조용했다면 그 사이 큐가 비었거나 멈춰 있었던 것이고, 지난 사고의 연속 수를
 *   이어받으면 회복된 큐의 첫 제한에서 멀쩡한 작업이 NO_PROGRESS로 간다(#19 리뷰 1: d3-resume.md
 *   5절이 남긴 cycles 3). 새로 세면 첫 주기는 1이라 K가 2 이상이면 그 자리에서 끝나지 않는다.
 * - `until`은 더 긴 쪽을 남긴다. 같은 주기 안에서 429(10초) 뒤 403 차단(30초)이 오면 30초다.
 * - **큐 정지는 이 창에 맞춘다.** 스크립트는 연속 수와 함께 `until`까지 남은 시간을 돌려주고, 호출하는
 *   쪽은 자기 Retry-After가 아니라 그 시간으로 `queue.rateLimit`을 건다. `queue.rateLimit`은 앞선 정지를
 *   조건 없이 덮어쓰므로(bullmq 6.3.8 `setRateLimit`, SET PX), 자기 대기로 걸면 30초 차단 뒤의 5초 429가
 *   정지를 5초로 줄이고, 풀린 뒤 25초 동안의 무진행 주기가 같은 주기로 접혀 덜 세어졌다(#19 최종 리뷰 3).
 *   주기 창과 정지를 같은 값에서 꺼내므로 워커들의 세기·정지 순서가 엇갈려도(W1 세기 30초, W2 세기 5초,
 *   W2 정지, W1 정지) 모두 같은 `until`로 정지를 건다. 창보다 짧게도 길게도 멈추지 않는다.
 *
 * 시각은 Redis `TIME`이다. 워커 프로세스마다 시계가 다르면 같은 주기 판정이 어긋난다.
 */
const COUNT_CYCLE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local pages = tonumber(redis.call('HGET', KEYS[1], 'pages') or '0')
local seen = tonumber(redis.call('HGET', KEYS[1], 'seen') or '0')
local cycles = tonumber(redis.call('HGET', KEYS[1], 'cycles') or '0')
local untilMs = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
if now >= untilMs then
  if now > untilMs + tonumber(ARGV[2]) then cycles = 0 end
  if pages > seen then cycles = 0 else cycles = cycles + 1 end
  redis.call('HSET', KEYS[1], 'seen', pages, 'cycles', cycles)
elseif pages > seen then
  cycles = 0
  redis.call('HSET', KEYS[1], 'seen', pages, 'cycles', cycles)
end
local newUntil = math.max(untilMs, now + tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'until', newUntil)
return {cycles, newUntil - now}
`;

/**
 * 직전 정지가 끝나고 이만큼 제한이 없었으면 연속이 끊긴 것으로 본다(`COUNT_CYCLE`). 사고가 이어지는
 * 동안 정지가 풀린 뒤 다음 제한까지는 로그인 두 요청 남짓(실측 수 ms)이다. 60초는 그보다 넉넉하고,
 * 지난 사고의 상태를 이어받을 만큼 짧다.
 */
const STALE_STREAK_MS = 60_000;

export type ProcessorResult = { count: number };

/** `retry` 처분의 오류. 표 바깥의 예외와 구분해 바깥 catch가 DLQ를 두 번 쓰지 않게 한다. */
class DispositionError extends Error {}

/** `onPage`의 결과·체크포인트 저장 오류. 수집 함수 밖의 설정 오류(`RangeError`)와 가른다. */
class PersistenceError extends Error {}

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
  const noProgressLimit = deps.noProgressCycles ?? DEFAULT_NO_PROGRESS_CYCLES;
  // K는 2 이상의 정수다(#19 최종 리뷰 8). 60초 넘게 끊긴 연속은 1부터 세므로 K=1이면 멀쩡한 큐의 첫 429에서
  // 바로 DLQ다. 0이면 모든 제한이 DLQ, NaN이면 비교가 늘 거짓이라 상한이 조용히 꺼진다. 설정 오류라 던진다.
  if (!Number.isSafeInteger(noProgressLimit) || noProgressLimit < 2) {
    throw new RangeError(`진행 기반 상한(noProgressCycles, WORKER_NO_PROGRESS_CYCLES)은 2 이상의 정수여야 한다: ${noProgressLimit}`);
  }

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

    // 결과 저장소의 수명 규칙(#19 최종 리뷰 1·12). 1페이지부터 받는 실행은 같은 작업 ID의 옛 결과를
    // 먼저 지운다. 남겨 두면 작업을 지우고 다시 넣었을 때 옛 실행의 행이 건수와 결과에 섞인다. 이어받는
    // 실행은 앞 페이지의 행이 아직 있는지(`checkpoint.rows`) 본다. 모자라면 1페이지부터 다시 받는다.
    const key = resultsKey(queue.name, jobId);
    let checkpoint = data.checkpoint;
    if (checkpoint !== undefined && checkpoint.nextPage > 1) {
      const have = await redis.hlen(key);
      if (have < (checkpoint.rows ?? 0)) {
        log({ event: 'resume-reset', jobId, detail: `결과 ${have}행 < 체크포인트 ${checkpoint.rows}행(${checkpoint.nextPage}페이지). 1페이지부터 다시 받는다` });
        checkpoint = undefined;
      }
    }
    if (checkpoint === undefined || checkpoint.nextPage <= 1) {
      await redis.del(key);
      if (data.checkpoint !== undefined) {
        const { checkpoint: _dropped, ...request } = data;
        await job.updateData(request);
      }
    }

    let result: CollectResult;
    try {
      result = await deps.collect(job.data, {
        startPage: checkpoint?.nextPage ?? 1,
        ...(checkpoint?.maxPage === undefined ? {} : { maxPage: checkpoint.maxPage }),
        onPage: async (rows, page, maxPage) => {
          try {
            // 진행은 **받자마자** 센다. 결과·체크포인트 쓰기(두 번 왕복) 뒤에 세면 그 사이 다른 워커가
            // 받은 429가 먼저 주기를 세어, 이미 받은 페이지를 다음 주기로 넘긴다(#19 리뷰 1b). 쓰기 전에
            // 죽어도 진행이 한 번 더 세어질 뿐이고, 그것은 상한을 늦출 뿐 행을 만들지 않는다.
            await creditProgress();
            // **행을 먼저, 체크포인트를 나중에 쓴다.** 둘 사이에 워커가 죽으면 다시 시작한 쪽이
            // 같은 페이지를 한 번 더 받아 같은 seq에 덮어쓸 뿐이다. 반대 순서면 체크포인트만
            // 넘어가고 그 페이지의 행이 영영 빠진다.
            await writeResults(jobId, rows);
            const written = await redis.hlen(key);
            const cap = maxPage ?? checkpoint?.maxPage;
            await job.updateData({ ...job.data, checkpoint: { nextPage: page + 1, rows: written, ...(cap === undefined ? {} : { maxPage: cap }) } });
          } catch (error) {
            // 저장 중의 오류는 표 바깥의 일반 오류다(재시도). 아래 catch의 RangeError(설정 오류) 가지로
            // 새지 않게 감싼다(#19 최종 리뷰 9: ioredis·JSON이 RangeError를 던지면 '설정 오류'로 한 번에 DLQ였다).
            throw new PersistenceError(error instanceof Error ? error.message : String(error), { cause: error });
          }
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
      // 완료도 진행이다. 빈 계좌(1페이지가 빈 페이지)나 끝을 확인하는 빈 페이지만 남은 이어받기는
      // 페이지를 하나도 받지 않고 끝나는데, 세지 않으면 그런 완료가 섞인 사이의 제한이 전부 연속
      // 무진행으로 쌓인다(#19 리뷰 2).
      await creditProgress();
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

  /** 큐 전체의 진행을 하나 센다(`progressKey`의 `pages`, `COUNT_CYCLE`). */
  async function creditProgress(): Promise<void> {
    await redis.hincrby(progressKey(queue.name), 'pages', 1);
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
        // 타입이 선택 필드라 없을 때는 분류기의 기본값(대상 서버 창 W)을 쓴다. 큐 정지는 이 값이 아니라
        // 같은 주기에서 가장 늦게 끝나는 Retry-After까지다(`COUNT_CYCLE`).
        //
        // IP_BLOCKED가 여기로 오는 것은 D2의 임시 처분이다(`queue.ts` DISPOSITION 주석). 출발지가
        // 하나라 전환할 곳이 없고, 대상 서버 차단은 Retry-After 뒤 스스로 풀린다. #14에서 출발지
        // 전환(FIRST_REMEDY의 ROTATE_EGRESS)이 들어오면 이 칸이 바뀐다.
        const waitSec = 'retryAfterSec' in failure && failure.retryAfterSec !== undefined ? failure.retryAfterSec : DEFAULT_RATE_LIMIT_WAIT_SEC;
        const waitMs = Math.max(1, Math.round(waitSec * 1000));
        log({ event: 'rate-limited', jobId, attemptsMade: job.attemptsMade, kind, waitMs, detail });

        // 진행 기반 상한(#19). 큐 전체의 연속 무진행 주기 수를 센다(`COUNT_CYCLE`, `progressKey`).
        // 시도 횟수 상한을 두지 않는 이유는 "환경이 막은 실패는 작업 탓이 아니다"(`CONSUMES_ATTEMPT`)
        // 와 충돌해서다. 이 상한은 환경 때문에 느린 것(주기마다 누군가 몇 페이지씩 나아간다)은
        // 두고, 아무도 못 나아가는 것(창이 로그인 비용 이하)만 잡는다.
        //
        // 상한에 닿은 뒤 대기 중이던 작업도 같은 길로 끝난다. 꺼낼 때 미리 실패시키지 않고 한 번은
        // 보내 본다. 그 주기에도 아무도 못 받으면 연속 수가 상한 이상이라 여기서 NO_PROGRESS다.
        // 미리 실패시키면 연속 수를 되돌릴 페이지를 받을 기회가 없어서, 환경이 풀린 뒤에도 대기
        // 작업이 전부 DLQ로 빠진다. 대가는 대기 작업마다 한 주기(로그인 한 번)다.
        //
        // 체크포인트는 여기서 쓰지 않는다. `onPage`가 페이지마다 이미 남겼고, 던지기 전에 끝났다.
        //
        // **세기가 실패해도 속도 제한은 속도 제한이다.** 예전에는 eval 오류가 표 바깥의 일반 오류로 새서
        // 시도 횟수를 깎고, 마지막 시도면 kind null로 DLQ에 갔고, 큐도 멈추지 않았다(#19 최종 리뷰 4 재현:
        // attempts 1 작업이 첫 429에서 failed). 세지 못한 주기는 세지 않은 채로 둔다. 그 작업의 Retry-After만큼
        // 멈추고 대기로 돌린다. 세지 못한 주기로는 NO_PROGRESS를 내지 않는다(상한이 한 주기 늦어질 뿐이다).
        let cycles = 0;
        let pauseMs = waitMs;
        try {
          [cycles, pauseMs] = (await redis.eval(COUNT_CYCLE, 1, progressKey(queue.name), waitMs, STALE_STREAK_MS)) as [number, number];
        } catch (error) {
          log({ event: 'progress-count-error', jobId, detail: error instanceof Error ? error.message : String(error) });
        }
        // 제한은 NO_PROGRESS로 끝낼 때도 건다. 이 작업을 끝내도 환경은 여전히 막혀 있어서, 걸지
        // 않으면 다음 작업이 바로 출발해 429를 또 받는다(출발지 차단 누적에도 들어간다).
        // 정지 길이는 자기 Retry-After가 아니라 주기 창(`until`)까지다(`COUNT_CYCLE` 주석).
        //
        // 이 호출이 실패하면(#19 최종 리뷰 5) 여전히 표 바깥의 일반 오류로 새서 시도를 깎는다. 정지 없이
        // RateLimitError를 던지면 작업이 곧바로 다시 꺼내져 막힌 대상에 로그인을 되풀이하므로, 그쪽이 더
        // 나쁘다고 보고 그대로 둔다. 이미 센 주기는 남는다.
        await queue.rateLimit(Math.max(1, pauseMs));
        if (cycles >= noProgressLimit) {
          const nextPage = job.data.checkpoint?.nextPage ?? 1;
          const reason =
            `큐 전체에서 속도 제한·차단 주기 ${cycles}번 연속 새 페이지 없음(이 작업은 ${nextPage}페이지에서 멈춤). ` +
            `창이 동시에 출발하는 워커들의 로그인 비용(워커당 2요청) 이하인지 대상 서버 임계값을 확인할 것. ` +
            `마지막 실패 ${kind}: ${detail}`;
          throw await recordDead(new UnrecoverableError(formatFailedReason('NO_PROGRESS', reason)), job, jobId, 'NO_PROGRESS', reason);
        }
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
    kind: DeadLetterKind | null,
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
