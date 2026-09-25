/**
 * 수집 요청 API(#12)와 큐 워커(#13)가 함께 쓰는 약속. 큐 이름, 작업 데이터 모양, 작업 ID,
 * 결과 저장 위치, 실패를 남기는 형식이 여기 있다.
 *
 * 한 파일에 모은 이유는 두 쪽이 따로 정하면 어긋나기 때문이다. API가 `results:` 키에서
 * 읽는데 워커가 다른 키에 쓰면 둘 다 테스트를 통과하고 결과는 영영 비어 보인다.
 */

import { createHash } from 'node:crypto';

import { Redis } from 'ioredis';

import { FAILURE_KINDS } from './client/errors.js';
import type { FailureKind } from './client/errors.js';
import type { Transaction } from './client/parse.js';

export const COLLECTION_QUEUE = 'collections';
export const COLLECT_JOB = 'collect';

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

/**
 * 작업 데이터. **비밀을 싣지 않는다.** 비밀번호와 TOTP 공유키는 워커가 실행되는 자리에서
 * `credentials.ts`로 찾는다. 여기 실린 값은 Redis와 실패 목록(DLQ)에 그대로 남는다.
 *
 * `from`·`to`는 `YYYY-MM-DD HH:mm:ss`로 정규화한 값이다. `session.collect`가 그대로 받는다.
 */
export type CollectionJobData = {
  loginId: string;
  accountNo: string;
  from: string;
  to: string;
  /** 워커만 쓴다. 요청에는 없고, API 응답(`request`)에도 싣지 않는다. */
  checkpoint?: CollectionCheckpoint;
};

/** 요청 네 필드. 작업 데이터에서 워커 내부 상태(체크포인트)를 뺀 것이다. */
export type CollectionRequest = Pick<CollectionJobData, 'loginId' | 'accountNo' | 'from' | 'to'>;

/**
 * 작업 데이터에서 요청 네 필드만 뽑는다. 밖으로 내보내는 자리(API 상태 응답, DLQ 항목)는 이것을 쓴다.
 * 체크포인트를 그대로 실으면 API 응답 모양이 처리 중에 바뀌고, DLQ 항목의 request를 POST /collections에
 * 그대로 다시 내면 "모르는 필드: checkpoint"로 400이다(#19 최종 리뷰 13).
 */
export function requestOf(data: CollectionJobData): CollectionRequest {
  return { loginId: data.loginId, accountNo: data.accountNo, from: data.from, to: data.to };
}

/**
 * 이어받기 체크포인트(#19). 워커가 페이지를 받을 때마다 `job.updateData`로 남긴다.
 *
 * 속도 제한·출발지 차단 창보다 큰 작업(demo01 요청 10개 > N=5)은 매 주기 로그인부터 다시
 * 하면 영영 끝나지 않는다(TROUBLESHOOTING 4번). 받은 페이지의 행은 결과 저장소에 이미 있으므로
 * 다음 페이지 번호만 남기면 다시 시작한 쪽이 거기서 잇는다. 결과 해시가 seq 필드라 같은
 * 페이지를 다시 받아 써도 행이 늘지 않는다(`resultsKey`).
 */
export type CollectionCheckpoint = {
  /** 다시 시작할 때 받을 페이지. 이 앞 페이지의 행은 결과 저장소에 이미 있다. */
  nextPage: number;
  /**
   * 이 체크포인트를 남길 때 결과 저장소의 행 수(HLEN). 이어받기 전에 저장소가 이보다 적으면 앞 페이지의
   * 행이 사라진 것이라(사람이 결과 키를 지우고 다시 돌린 경우 등) 1페이지부터 다시 받는다. "키가
   * 있는가"로 보지 않는 이유: 앞 페이지가 기간으로 전부 걸러진 작업은 키가 없는 것이 정상이다.
   * 없으면(이 필드를 넣기 전의 체크포인트) 확인하지 않는다.
   */
  rows?: number;
  /** 처음 실행이 잰 페이지 상한(`totalPages + 1`). 이어받을 때 세션에 넘긴다(`CollectOptions.maxPage`). */
  maxPage?: number;
};

/**
 * Redis 연결을 만든다. 워커용은 `maxRetriesPerRequest: null`이 필수다.
 *
 * BullMQ는 워커의 블로킹 연결에 이 값이 null이 아니면, 옵션 객체를 받았을 때는 덮어쓰고
 * **이미 만든 연결을 받았을 때는 던진다**(bullmq 6.3.8 `redis-connection.js`
 * `checkBlockingOptions`). 여기서는 연결을 직접 만들어 넘기므로 던지는 쪽이다.
 *
 * 연결을 옵션이 아니라 인스턴스로 넘기는 이유: bullmq 6은 ioredis를 선택적 peer로 두고
 * 옵션을 받으면 `require('ioredis')`로 찾는다. ESM 환경에서 `require`가 없으면 이 경로가
 * 막힌다고 소스 주석이 말한다. 인스턴스를 넘기면 로딩 경로와 상관이 없다.
 *
 * API(생산자)용 연결은 ioredis 기본값(maxRetriesPerRequest 20)을 둔다. Redis가 죽었을 때
 * 요청이 무한정 걸려 있지 않고 결국 실패하게 하려는 것이다. 즉시 503을 주는 것(#12의
 * 잘라 낸 항목)은 오프라인 큐까지 손봐야 해서 이 파일에서 하지 않는다.
 */
export function createRedis(role: 'producer' | 'worker', url: string = redisUrl()): Redis {
  return new Redis(url, role === 'worker' ? { maxRetriesPerRequest: null } : {});
}

export function redisUrl(env: Record<string, string | undefined> = process.env): string {
  const value = env.REDIS_URL;
  return value === undefined || value.trim() === '' ? DEFAULT_REDIS_URL : value;
}

/**
 * 작업 옵션. 워커(#13)가 시도 횟수를 어떻게 쓰는지는 거기서 정하고, 여기서는 상한만 둔다.
 *
 * **완료·실패 작업을 지우지 않는다.** 멱등이 BullMQ의 "같은 jobId가 있으면 새로 만들지
 * 않는다"에 기대고 있어서, 작업이 지워지면 같은 요청이 새 작업이 되어 다시 수집된다.
 * `removeOnComplete: true`로 실측하면 두 번째 요청에서 프로세서가 한 번 더 돌았다
 * (`docs/evidence/d2-api.md`). 나이·개수 기준 삭제(`{ age }`, `{ count }`)도 같은 문제를
 * 시점만 늦춰 가진다. 게다가 그 삭제는 다른 작업이 끝날 때만 평가되는 최선 노력이라
 * "언제부터 재수집되는가"를 말할 수 없다.
 *
 * 실패 작업을 남기는 이유는 하나 더 있다. 실패 목록이 곧 사람이 볼 곳(DLQ)이고, 같은
 * 요청이 다시 와도 실패 작업은 그대로 실패로 남는다(실측). AUTH_FAILED 작업을 요청만으로
 * 다시 돌리면 비밀번호 오류가 쌓여 계정이 잠긴다. 다시 돌리는 것은 사람이 한다.
 *
 * 대가는 Redis가 계속 커진다는 것이다. 보존 기한은 결과 저장소와 함께 정해야 해서(작업만
 * 지우면 결과가 고아가 되고, 결과만 지우면 완료인데 행이 없다) 여기서 정하지 않는다.
 */
export const COLLECT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: false,
  removeOnFail: false,
} as const;

/**
 * 작업 ID. 로그인 ID, 계좌, **정규화한** 기간의 해시다. 같은 요청이면 같은 ID가 나오고,
 * BullMQ는 같은 ID의 작업을 새로 만들지 않는다. 이것이 멱등의 첫 겹이다. 두 번째 겹은
 * 결과 저장소가 seq를 필드로 쓰는 것이다(#13). 작업이 다시 돌아도 결과가 늘지 않는다.
 *
 * **로그인 ID를 넣는다.** 처음에는 "같은 계좌·기간은 누가 요청해도 같은 거래내역"이라며
 * 뺐는데(커밋 de69730), 대상 서버는 로그인 하나에 계좌 하나를 묶는다. 다른 로그인으로 그
 * 계좌를 조회하면 403 ACCOUNT_MISMATCH이고 분류기는 UNKNOWN을 낸다. 로그인 ID를 빼면
 * 두 가지가 생긴다(#12 리뷰에서 재현).
 * - 권한 없는 로그인이 먼저 요청하면 그 계좌·기간의 작업이 실패로 남고, 실패 작업은
 *   지우지도 다시 돌리지도 않으므로 계좌 주인의 요청도 영원히 그 실패를 받는다.
 * - 계좌 주인이 먼저 요청해 완료되면 권한 없는 로그인이 같은 ID로 그 행을 받는다.
 * 수집의 성공과 결과를 볼 자격이 로그인 ID에 달려 있으므로 ID도 거기에 달려야 한다.
 *
 * 정규화한 값을 쓰는 이유: `2026-09-01`과 `2026-09-01 00:00:00`은 같은 기간 시작인데
 * 문자열이 다르다. 원문을 해시하면 같은 요청이 두 작업이 된다.
 *
 * 모양 제약(bullmq 6.3.8 `job.js`, 실측): 정수로 읽히는 문자열은 "Custom Id cannot be
 * integers", `:`가 든 문자열은 "Custom Id cannot contain :"로 거부된다. 16진수 해시가
 * 우연히 숫자만으로 나오는 경우를 막으려고 `col_`을 앞에 붙인다. 128비트(32자)면 충돌은
 * 걱정할 크기가 아니다.
 */
export function jobIdOf(loginId: string, accountNo: string, from: string, to: string): string {
  // 이어 붙이지 않고 배열로 직렬화한다. 이어 붙이면 경계가 모호해져 다른 입력이 같은
  // 문자열이 될 수 있다.
  const digest = createHash('sha256').update(JSON.stringify([loginId, accountNo, from, to])).digest('hex');
  return `col_${digest.slice(0, 32)}`;
}

/** `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:mm:ss`. `session.ts`가 받는 형식과 같다. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export type Period = { ok: true; from: string; to: string } | { ok: false; detail: string };

/**
 * 요청 기간을 검증하고 `YYYY-MM-DD HH:mm:ss`로 정규화한다. 날짜만 주면 `from`은 그날
 * 00:00:00, `to`는 23:59:59다. `session.ts`의 `normalizeBound`와 같은 규칙이다.
 *
 * 그 함수를 가져다 쓰지 않은 이유: 내보내지 않은 함수이고, 이미 리뷰가 끝난 클라이언트를
 * 형식 검증 하나 때문에 고치지 않기로 했다. 두 규칙이 어긋나면 API가 받은 요청을 워커가
 * 던지게 되므로 `queue.test.ts`가 둘을 맞대어 본다.
 *
 * 세션보다 엄격한 것이 둘 있다. 달력에 없는 날짜(2월 30일)와 `from > to`는 400이다.
 * 세션은 형식만 보므로 그런 기간을 받으면 조용히 빈 결과를 낸다. 요청을 받는 자리에서
 * 막는 것이 싸다.
 */
export function normalizePeriod(from: unknown, to: unknown): Period {
  const lower = normalizeBound(from, '00:00:00', 'from');
  if (!lower.ok) return lower;
  const upper = normalizeBound(to, '23:59:59', 'to');
  if (!upper.ok) return upper;
  // 고정 길이 형식이라 문자열 비교가 곧 시각 비교다.
  if (lower.value > upper.value) return { ok: false, detail: `from이 to보다 늦다: ${lower.value} > ${upper.value}` };
  return { ok: true, from: lower.value, to: upper.value };
}

function normalizeBound(
  value: unknown,
  time: string,
  name: string,
): { ok: true; value: string } | { ok: false; detail: string } {
  const bad = { ok: false as const, detail: `${name} 형식은 YYYY-MM-DD 또는 YYYY-MM-DD HH:mm:ss여야 한다: ${JSON.stringify(value)}` };
  if (typeof value !== 'string') return bad;
  const full = DATE_ONLY.test(value) ? `${value} ${time}` : value;
  const m = DATE_TIME.exec(full);
  if (m === null) return bad;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date는 넘친 값을 다음 달로 굴린다. 되돌려 읽어 같은지 보는 것이 달력 검사다.
  const same =
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s;
  if (!same) return { ok: false, detail: `${name} 값이 달력에 없는 시각이다: ${JSON.stringify(value)}` };
  return { ok: true, value: full };
}

/**
 * 결과 저장소 키. Redis 해시 하나에 필드는 `seq`, 값은 `Transaction` JSON이다. 쓰는 쪽은
 * 워커(#13)다. seq를 필드로 두면 같은 페이지를 두 번 저장해도 행이 늘지 않는다.
 *
 * **워커는 프로세서가 반환하기 전에 결과를 전부 쓴다.** API는 작업이 completed면 이 해시를
 * 결과로 읽는다. 반환한 뒤에 쓰면 완료인데 행이 비었거나 모자란 응답이 나간다.
 *
 * 큐 이름을 키에 넣었다. 같은 Redis를 쓰는 큐가 둘이면(테스트, 측정 시나리오) 같은
 * 계좌·기간이 같은 작업 ID를 내므로, ID만으로 키를 만들면 서로의 결과를 덮는다.
 */
export function resultsKey(queueName: string, jobId: string): string {
  return `results:${queueName}:${jobId}`;
}

/** 결과 행을 seq 순으로 읽는다. 키가 없으면 빈 배열이다. */
export async function readResults(redis: Redis, queueName: string, jobId: string): Promise<Transaction[]> {
  const hash = await redis.hgetall(resultsKey(queueName, jobId));
  return Object.values(hash)
    .map((value) => JSON.parse(value) as Transaction)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * 최종 실패를 남기는 형식. 워커(#13)는 마지막 실패 분류를 `KIND: detail` 모양의 오류
 * 메시지로 던지고, BullMQ가 그것을 `job.failedReason`에 남긴다.
 *
 * 따로 키를 두지 않고 `failedReason`을 쓰는 이유: BullMQ가 실패 목록과 함께 이미 보관하고
 * 작업을 지울 때 함께 지운다. 따로 두면 수명을 또 맞춰야 한다.
 *
 * `detail`에는 원본을 싣지 않는다. 원본(CAPTURE_RAW)은 크고, 가려야 할 헤더가 있다
 * (`capture.ts`). 원본을 어디에 둘지는 #13이 정한다.
 */
export function formatFailedReason(kind: DeadLetterKind, detail: string): string {
  return `${kind}: ${detail}`;
}

/**
 * 최종 실패에 남는 종류. 분류기의 일곱 종에 워커가 붙이는 NO_PROGRESS 하나를 더한다.
 *
 * NO_PROGRESS(#19): 큐 전체가 속도 제한·출발지 차단 주기를 워커의 상한(기본 3)번 연달아 거치는
 * 동안 어느 작업도 페이지를 받거나 완료하지 못했을 때, 그 주기에 제한을 받은 작업이다(`progressKey`).
 * 창(N)이 로그인 비용 이하면 영원히 한 페이지도 못 받는데, 속도 제한은 시도 횟수를 깎지 않아
 * (`CONSUMES_ATTEMPT`) 저절로 끝나지 않는다.
 *
 * **`FailureKind`에 넣지 않는다.** 분류기의 일곱 종은 응답 하나를 보고 정하는 것이고
 * `FIRST_REMEDY`·`CONSUMES_ATTEMPT`·`DISPOSITION`이 그 일곱 종에 대한 표다. NO_PROGRESS는
 * 여러 주기를 가로질러 본 판단이라 응답 하나로는 나올 수 없고, 표에 칸을 만들면 분류기가
 * 낼 수 없는 종류에 처분을 정하는 셈이 된다. 이름이 붙는 자리는 최종 실패(`failedReason`,
 * DLQ)뿐이다.
 */
export type DeadLetterKind = FailureKind | 'NO_PROGRESS';

const DEAD_LETTER_KINDS: readonly DeadLetterKind[] = [...FAILURE_KINDS, 'NO_PROGRESS'];

export type RecordedFailure = {
  /** null이면 워커가 분류하지 못한 실패다. 자격증명 없음 같은 설정 오류가 여기로 온다. */
  kind: DeadLetterKind | null;
  detail: string;
};

export function parseFailedReason(reason: string | undefined): RecordedFailure {
  const text = reason ?? '';
  for (const kind of DEAD_LETTER_KINDS) {
    const prefix = `${kind}: `;
    if (text.startsWith(prefix)) return { kind, detail: text.slice(prefix.length) };
  }
  return { kind: null, detail: text };
}

/**
 * 실패 종류별 처분. 워커(#13)가 수집 실패를 받았을 때 BullMQ에 **무엇을 던지는가**.
 *
 * 이 표가 없으면 `COLLECT_JOB_OPTIONS.attempts`(3)와 `CONSUMES_ATTEMPT.AUTH_FAILED`(true)를
 * 그대로 읽은 워커가 일반 Error를 던지고, AUTH_FAILED가 세 번 돌아 계정이 잠긴다(#12 리뷰
 * 재현: 프로세서 3회). `CONSUMES_ATTEMPT`는 "시도 횟수를 깎는 실패인가"이지 "다시 해도
 * 되는가"가 아니다. 다시 해도 되는지는 여기서 정한다.
 *
 * - `rate-limit`: `await queue.rateLimit(ms)` 뒤 `throw Worker.RateLimitError()`. 시도 횟수를
 *   깎지 않는다. **Worker 옵션에 `limiter: { max, duration }`이 필수다.** 없으면 부른 워커만
 *   쉬고 같은 큐의 다른 워커는 제한 창 안에서 계속 꺼낸다. `worker.rateLimit()`은 6.3.8에서
 *   deprecated라 `queue.rateLimit()`을 쓴다. **`maxStartedAttempts`는 켜지 않는다.** 속도
 *   제한으로 되돌아갈 때마다 `attemptsStarted`가 올라 그 상한에서 작업이 실패한다
 *   (셋 다 `docs/evidence/d2-bullmq-spike.md`).
 * - `retry`: 일반 Error. `attempts`만큼 백오프하며 다시 한다. 시도 횟수를 깎는다.
 * - `fail-now`: `UnrecoverableError`. 남은 시도와 상관없이 한 번에 failed로 가고(스파이크 5번),
 *   실패 목록이 곧 DLQ다. 메시지는 `formatFailedReason` 모양이어야 `failedReason`에서 읽힌다.
 *
 * 종류별 근거:
 * - RATE_LIMITED: 큐 전체를 멈춘다(`FIRST_REMEDY` PAUSE_QUEUE).
 * - IP_BLOCKED: 대응은 출발지 전환인데 D2에는 출발지가 하나뿐이다. **D2의 임시 처분으로
 *   rate-limit을 쓴다.** 대상 서버 차단은 `blockDurationSec` 뒤 스스로 풀리고 Retry-After를
 *   준다(`target/switches.ts`). 처음에는 "같은 출발지로 기다려도 풀리지 않는다"며 fail-now로
 *   뒀는데 대상 서버와 사실이 달랐고, 일시 차단 2초 동안 대기 작업 5건이 전부 영구 failed가
 *   됐다(#13 리뷰 r3 재현). 실패 작업은 지우지 않고 작업 ID가 같으면 새로 만들지 않으므로,
 *   차단이 풀린 뒤 같은 요청을 다시 넣어도 failed로 남는다. 큐 전체를 Retry-After만큼 멈추면
 *   시도 횟수를 깎지 않는다는 `CONSUMES_ATTEMPT.IP_BLOCKED`(false)와도 맞는다. 다만 차단이
 *   풀리자마자 다시 막히면 속도 제한과 같은 끝나지 않는 반복이 됐다(TROUBLESHOOTING 4번). #19 뒤로는
 *   받은 페이지부터 이어받고, 큐 전체가 나아가지 못하면 진행 기반 상한이 NO_PROGRESS로 끊는다.
 *   #14에서 출발지 전환(ROTATE_EGRESS)이 들어오면 이 칸이 바뀐다.
 * - SESSION_EXPIRED: 정상 흐름에서는 밖으로 나오지 않는다. `collect` 안에서 재인증하고 그
 *   페이지를 한 번 다시 보내며, 재인증 직후 또 세션 실패면 UNKNOWN으로 올려 내보낸다
 *   (`session.ts` `#fetchPage`·`#login`). 다만 1차 인증(`/login`) 응답이 세션 실패로
 *   분류되면 올리지 않고 그대로 나온다. 그때는 재인증을 또 해 봐야 같은 자리에서 막히므로
 *   `fail-now`로 둔다. `retry`로 두면 시도 횟수를 깎지 않는다는 약속과도 어긋난다.
 * - TRANSIENT: 잠시 뒤 다시 하면 된다.
 * - AUTH_FAILED: 다시 하면 계정이 잠긴다.
 * - PARSE_FAILED·UNKNOWN: 코드를 고쳐야 풀린다. 원본을 남기고 사람에게 넘긴다.
 */
export type Disposition = 'rate-limit' | 'retry' | 'fail-now';

export const DISPOSITION = {
  RATE_LIMITED: 'rate-limit',
  IP_BLOCKED: 'rate-limit',
  SESSION_EXPIRED: 'fail-now',
  AUTH_FAILED: 'fail-now',
  TRANSIENT: 'retry',
  PARSE_FAILED: 'fail-now',
  UNKNOWN: 'fail-now',
} as const satisfies Record<FailureKind, Disposition>;

/**
 * 실패 목록(DLQ) 큐 이름. 워커(#13)가 최종 실패를 여기 한 건씩 넣는다.
 *
 * 원래 큐의 실패 목록(`failedReason`)만으로는 모자란 이유: 거기는 문자열 하나라 원본을
 * 실을 자리가 없다. PARSE_FAILED·UNKNOWN의 대응은 원본을 남기는 것(`FIRST_REMEDY`의
 * CAPTURE_RAW)이고, 사람이 코드를 고치려면 원본이 있어야 한다. 원래 큐의 실패는 그대로
 * 두고(API가 상태를 거기서 읽는다) 같은 내용과 원본을 이 큐에 한 번 더 남긴다.
 *
 * 이 큐를 꺼내는 워커는 없다. 항목은 대기 상태로 쌓이고 사람이 읽는다. 작업 ID는 원래
 * 작업 ID와 같다. 같은 작업이 두 번 실패 처리를 지나도(DLQ에 넣은 뒤 던지기 전에 워커가
 * 죽는 경우) 항목이 하나만 남는다.
 */
export function deadLetterQueueName(queueName: string): string {
  return `${queueName}-dead`;
}

/**
 * 원본 응답을 DLQ에 싣는 모양. 본문은 base64다. 대상 서버 본문은 EUC-KR이라 UTF-8
 * 문자열로 바꾸면 되돌릴 수 없게 깨진다. 사람이 볼 때는 디코딩하는 한 단계가 늘지만,
 * 파서를 고친 뒤 같은 바이트를 다시 넣어 볼 수 있다.
 */
export type CapturedRaw =
  | { status: number; headers: Record<string, string | string[] | undefined>; bodyBase64: string }
  | { network: { code?: string; name?: string; message: string } };

export type DeadLetterData = {
  originalId: string;
  /** null이면 분류하지 못한 실패다. 자격증명 없음 같은 설정 오류가 여기로 온다. */
  kind: DeadLetterKind | null;
  detail: string;
  /** 이번 시도를 포함한 시도 수. 원래 작업이 failed로 간 뒤의 `attemptsMade`와 같다. */
  attemptsMade: number;
  /** ISO 8601 UTC. */
  failedAt: string;
  /** 요청 네 필드(`requestOf`). 작업 데이터에는 비밀이 없다(위 `CollectionJobData`). 체크포인트는 싣지 않는다. */
  request: CollectionRequest;
  /** PARSE_FAILED·UNKNOWN에만 있다. **`redactForCapture`를 거친 값**이다. */
  raw: CapturedRaw | null;
};

/**
 * AUTH_FAILED 차단기 키. 값이 있으면 그 로그인 ID의 작업은 로그인을 보내지 않고 바로
 * 실패한다. 워커가 쓰고, 지우는 것은 사람이다(`redis-cli DEL`).
 *
 * 작업 하나가 AUTH_FAILED를 받으면 그 작업은 다시 돌지 않는다(`DISPOSITION`). 그런데 같은
 * 로그인 ID의 **다른** 작업(기간이 다른 요청)은 저마다 로그인을 한 번씩 보내고, 대상
 * 서버는 비밀번호 오류 5회에 계정을 잠근다. 작업 하나만 보는 층(`credentials.ts`)은 이것을
 * 막을 수 없어서 작업을 가로질러 보는 이 키가 필요하다.
 *
 * 만료를 두지 않는다. 비밀번호가 틀린 것은 시간이 지나도 풀리지 않고, 만료로 풀면 풀릴
 * 때마다 한 번씩 틀린 비밀번호가 나가 결국 계정이 잠긴다. 자격증명을 고친 사람이 지운다.
 *
 * 큐 이름을 넣은 이유는 결과 키와 같다. 테스트 큐의 차단이 운영 큐를 막지 않게 한다.
 */
export function authBlockKey(queueName: string, loginId: string): string {
  return `authblock:${queueName}:${loginId}`;
}

/**
 * 큐 전체의 진행 상태 키(#19 진행 기반 상한). Redis 해시 하나에 필드 넷이다.
 *
 * - `pages`: 이 큐의 어느 작업이든 페이지를 받거나 완료할 때마다 1씩 오른다(이름과 달리 완료도 센다).
 * - `seen`: 직전에 주기를 셀 때의 `pages`.
 * - `cycles`: 큐 전체에서 진행 없이 이어진 주기 수. NO_PROGRESS는 이것만 본다.
 * - `until`: 직전 주기의 큐 정지가 끝나는 시각(Redis `TIME` 기준 ms). 이보다 이른 제한은 같은
 *   주기로 보고, 이보다 60초 넘게 늦은 제한은 연속이 끊긴 새 주기로 본다.
 *
 * 규칙 전체는 `worker/process.ts`의 `DEFAULT_NO_PROGRESS_CYCLES`·`COUNT_CYCLE` 주석에 있다.
 *
 * 작업마다 세지 않고 큐 전체로 세는 이유: 워커 2개가 같은 출발지로 동시에 출발하면 로그인 두 벌(4요청)이
 * 창(N=5)을 거의 다 써서 주기마다 한 작업만 한 페이지를 받는다. 작업마다 세면 경쟁에서 계속 진
 * 작업이 큐는 나아가는데도 NO_PROGRESS로 갔다(`docs/evidence/d3-resume.md`). 환경이 막혔는지는
 * 출발지, 곧 큐 전체의 성질이다.
 *
 * 키에 만료(TTL)를 두지 않고, 오래된 연속은 스크립트가 `until`을 보고 끊는다. 필드 넷짜리 해시
 * 하나이고, 남겨 두면 사고가 끝난 뒤에도 마지막 상태를 읽을 수 있다.
 */
export function progressKey(queueName: string): string {
  return `progress:${queueName}`;
}
