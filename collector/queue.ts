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
 * 작업 ID. 계좌와 **정규화한** 기간의 해시다. 같은 계좌·기간이면 같은 ID가 나오고,
 * BullMQ는 같은 ID의 작업을 새로 만들지 않는다. 이것이 멱등의 첫 겹이다. 두 번째 겹은
 * 결과 저장소가 seq를 필드로 쓰는 것이다(#13). 작업이 다시 돌아도 결과가 늘지 않는다.
 *
 * 로그인 ID는 넣지 않는다. 같은 계좌·기간을 다른 로그인으로 요청해도 같은 거래내역이라
 * 같은 작업으로 본다. 먼저 들어온 요청의 로그인 ID로 수집한다.
 *
 * 정규화한 값을 쓰는 이유: `2026-09-01`과 `2026-09-01 00:00:00`은 같은 기간 시작인데
 * 문자열이 다르다. 원문을 해시하면 같은 요청이 두 작업이 된다.
 *
 * 모양 제약(bullmq 6.3.8 `job.js`, 실측): 정수로 읽히는 문자열은 "Custom Id cannot be
 * integers", `:`가 든 문자열은 "Custom Id cannot contain :"로 거부된다. 16진수 해시가
 * 우연히 숫자만으로 나오는 경우를 막으려고 `col_`을 앞에 붙인다. 128비트(32자)면 충돌은
 * 걱정할 크기가 아니다.
 */
export function jobIdOf(accountNo: string, from: string, to: string): string {
  // 이어 붙이지 않고 배열로 직렬화한다. 이어 붙이면 경계가 모호해져 다른 입력이 같은
  // 문자열이 될 수 있다.
  const digest = createHash('sha256').update(JSON.stringify([accountNo, from, to])).digest('hex');
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
export function formatFailedReason(kind: FailureKind, detail: string): string {
  return `${kind}: ${detail}`;
}

export type RecordedFailure = {
  /** null이면 워커가 분류하지 못한 실패다. 자격증명 없음 같은 설정 오류가 여기로 온다. */
  kind: FailureKind | null;
  detail: string;
};

export function parseFailedReason(reason: string | undefined): RecordedFailure {
  const text = reason ?? '';
  for (const kind of FAILURE_KINDS) {
    const prefix = `${kind}: `;
    if (text.startsWith(prefix)) return { kind, detail: text.slice(prefix.length) };
  }
  return { kind: null, detail: text };
}
