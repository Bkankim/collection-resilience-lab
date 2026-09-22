/**
 * HTTP 응답 하나를 실패 종류 일곱 가지 중 하나로 나눈다. 성공이면 파싱한 페이지를 준다.
 *
 * `errors.ts`의 표는 "종류마다 무엇을 할지"이고, 이 파일은 "이 응답이 어느 종류인지"다.
 * 표만 있고 이 함수가 없으면 실패를 나눈다는 말은 아직 주장이다.
 *
 * 입력을 전송 계층과 떼어 놓았다. undici 응답 객체를 직접 받으면 이 함수를 검증하려고
 * 매번 서버를 띄워야 한다. 상태 코드·헤더·본문 바이트만 받으면 실제로 받아 둔 바이트를
 * 그대로 넣어서 판정을 재현할 수 있다.
 *
 * 판정 원칙: **모르면 추측하지 않는다.** 애매한 응답을 그럴듯한 종류에 넣으면 그 종류의
 * 대응이 자동으로 돈다. UNKNOWN은 원본을 남기고 사람에게 넘기는 것이 대응이라, 틀려도
 * 비용이 가장 작다.
 */

import type { FailureKind } from './errors.js';
import { parseTransactionsHtml } from './parse.js';
import type { TransactionPage } from './parse.js';

export type Headers = Record<string, string | string[] | undefined>;

/** 받은 응답 그대로. 헤더 이름은 undici처럼 소문자를 기대하지만, 대소문자와 상관없이 읽는다. */
export type RawResponse = {
  status: number;
  headers: Headers;
  body: Buffer;
};

/** 응답을 받기 전에 끊긴 경우. Node·undici 오류에서 판정에 쓰는 필드만 옮겨 담는다. */
export type NetworkFailure = {
  network: { code?: string; name?: string; message: string };
};

export type ClassifyInput = RawResponse | NetworkFailure;

/** 원본을 남겨야 하는 종류. `FIRST_REMEDY`에서 `CAPTURE_RAW`로 시작하는 두 종류와 같다. */
export type CaptureKind = 'PARSE_FAILED' | 'UNKNOWN';

export type Failure =
  | {
      ok: false;
      kind: Exclude<FailureKind, CaptureKind>;
      detail: string;
      /** RATE_LIMITED·IP_BLOCKED에는 항상 있다. TRANSIENT는 서버가 줬을 때만. */
      retryAfterSec?: number;
    }
  | {
      ok: false;
      kind: CaptureKind;
      detail: string;
      /**
       * 원본. 저장은 워커가 한다. 타입으로 필수로 둬서 원본 없는 UNKNOWN이
       * 컴파일되지 않게 했다. 원본 없이 사람에게 넘기면 사람이 볼 것이 없다.
       */
      raw: ClassifyInput;
    };

export type Classification = { ok: true; page: TransactionPage } | Failure;

/**
 * 429에 `Retry-After`가 없을 때 쓰는 대기 시간(초).
 *
 * 10초는 대상 서버 속도 제한 창(W)의 기본값이다. 슬라이딩 창이라 한 창 길이를
 * 기다리면 창이 비는 것이 보장된다. 짧게 잡아서 틀리면 429를 한 번 더 받을 뿐이고
 * RATE_LIMITED는 시도 횟수를 깎지 않는다. 길게 잡아서 틀리면 큐 전체가 그 시간만큼
 * 논다. 틀릴 때의 비용이 짧은 쪽이 작다.
 */
export const DEFAULT_RATE_LIMIT_WAIT_SEC = 10;

/**
 * 연결 단계에서 끊긴 오류 중 잠시 뒤 다시 하면 되는 것.
 *
 * DNS 실패(`ENOTFOUND`)는 넣지 않았다. 호스트 이름이 틀린 설정 오류일 때가 많고,
 * TRANSIENT로 두면 설정 오류가 재시도 횟수만큼 조용히 반복된다.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** `AbortSignal.timeout()`이 끊으면 이 이름이 온다. 사용자가 끊은 `AbortError`와 다르다. */
const TRANSIENT_NETWORK_NAMES = new Set(['TimeoutError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError']);

/** EUC-KR로 해석해도 되는 charset 레이블. 대상 서버는 `euc-kr`을 준다. */
const EUC_KR_LABELS = new Set(['euc-kr', 'cp949', 'ks_c_5601-1987', 'x-windows-949', 'windows-949']);

export function classify(input: ClassifyInput): Classification {
  if ('network' in input) return classifyNetwork(input);

  const { status } = input;
  if (status === 200) return classifyOk(input);
  if (status === 429) return classifyRateLimited(input);
  if (status === 401) return classify401(input);
  if (status === 403) return classify403(input);
  if (status >= 500 && status <= 599) {
    // errors.ts의 TRANSIENT 정의가 "5xx"다. 500도 넣은 이유: 대상이 계속 500을 내는
    // 버그라도 TRANSIENT는 시도 횟수를 깎으므로 결국 멈춘다. 재시도가 무한히 돌지 않는다.
    const retryAfterSec = readRetryAfter(input.headers);
    return {
      ok: false,
      kind: 'TRANSIENT',
      detail: `HTTP ${status}`,
      ...(retryAfterSec.ok ? { retryAfterSec: retryAfterSec.value } : {}),
    };
  }

  // 400(BAD_PAGE·BAD_QUERY)과 그 밖의 코드는 상대가 막은 것이 아니라 우리 요청이
  // 틀린 것이다. 재시도해도 같은 답이 오므로 원본을 들고 사람에게 간다.
  return unknown(input, `처리 규칙이 없는 상태 코드 ${status}${errorCodeSuffix(input)}`);
}

function classifyNetwork(input: NetworkFailure): Classification {
  const { code, name, message } = input.network;
  if ((code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) || (name !== undefined && TRANSIENT_NETWORK_NAMES.has(name))) {
    return { ok: false, kind: 'TRANSIENT', detail: `네트워크 ${code ?? name}: ${message}` };
  }
  return unknown(input, `처리 규칙이 없는 네트워크 오류 code=${code ?? '-'} name=${name ?? '-'}: ${message}`);
}

function classifyOk(input: RawResponse): Classification {
  // charset이 EUC-KR이 아닌데 EUC-KR로 읽으면 숫자는 멀쩡하고 한글만 깨진다. 조용히
  // 틀리는 경로라 파싱 전에 막는다. charset이 아예 없으면 대상 서버 계약대로 EUC-KR로 본다.
  const charset = charsetOf(input.headers);
  if (charset !== undefined && !EUC_KR_LABELS.has(charset)) {
    return { ok: false, kind: 'PARSE_FAILED', detail: `charset이 EUC-KR이 아니다: ${charset}`, raw: input };
  }

  const parsed = parseTransactionsHtml(input.body);
  if (!parsed.ok) return { ok: false, kind: 'PARSE_FAILED', detail: parsed.detail, raw: input };
  // 행이 0개인 페이지도 여기로 온다. 요약 줄이 "마지막 페이지 이후"라고 말하고 행 수가
  // 거기 맞으면 정상이다. 이걸 실패로 보면 차단 없는 기준선 성공률이 100%가 안 나온다.
  return { ok: true, page: parsed.page };
}

function classifyRateLimited(input: RawResponse): Classification {
  const retryAfter = readRetryAfter(input.headers);
  if (retryAfter.ok) {
    return { ok: false, kind: 'RATE_LIMITED', detail: 'HTTP 429', retryAfterSec: retryAfter.value };
  }
  // 헤더가 없어도 429는 속도 제한이라는 뜻이 분명하다. 대기 시간만 모르는 것이라
  // UNKNOWN으로 보내지 않는다. 기본값을 썼다는 사실은 detail에 남겨 측정에서 보이게 한다.
  return {
    ok: false,
    kind: 'RATE_LIMITED',
    detail: `HTTP 429, Retry-After ${retryAfter.reason}. 기본 대기 ${DEFAULT_RATE_LIMIT_WAIT_SEC}초를 쓴다`,
    retryAfterSec: DEFAULT_RATE_LIMIT_WAIT_SEC,
  };
}

/**
 * 401은 대응이 정반대인 두 경우(재인증 vs 즉시 중단)가 같은 코드로 온다.
 *
 * `X-Auth-Failed`를 **먼저** 본다. 두 헤더가 함께 오는 모순된 응답이라도 중단 쪽으로
 * 기운다. 세션 만료로 잘못 읽고 재인증하면 비밀번호 오류가 쌓여 계정이 잠기고, 중단으로
 * 잘못 읽으면 작업 하나가 DLQ에 갈 뿐이다. 틀렸을 때 되돌릴 수 있는 쪽을 고른다.
 */
function classify401(input: RawResponse): Classification {
  if (headerPresent(input.headers, 'x-auth-failed')) {
    return { ok: false, kind: 'AUTH_FAILED', detail: `HTTP 401 + X-Auth-Failed${errorCodeSuffix(input)}` };
  }
  if (headerPresent(input.headers, 'x-session-expired')) {
    return { ok: false, kind: 'SESSION_EXPIRED', detail: 'HTTP 401 + X-Session-Expired' };
  }
  // 쿠키 없이 왔거나 폐기된 식별자로 왔을 때 대상 서버는 헤더 없이 `NO_SESSION`을 준다.
  // 세션이 없으니 인증부터 하면 되고, 비밀번호가 틀렸다는 신호는 없으므로 재인증이 안전하다.
  if (readErrorCode(input.body) === 'NO_SESSION') {
    return { ok: false, kind: 'SESSION_EXPIRED', detail: 'HTTP 401, 본문 NO_SESSION (세션 없음)' };
  }
  // 헤더도 본문도 모르는 401은 추측하지 않는다. 재인증으로 추측했다가 실제로는
  // 자격증명 거부였다면 그 추측이 계정을 잠근다.
  return unknown(input, `구분 헤더도 알려진 본문도 없는 401${errorCodeSuffix(input)}`);
}

/**
 * 403은 대상 서버가 네 경우에 낸다. 출발지 차단(`Retry-After` 있음), 2차 인증 전
 * 조회(`OTP_REQUIRED`), 2차 인증 실패(`OTP_REJECTED`), 계좌 불일치(`ACCOUNT_MISMATCH`).
 *
 * 출발지 차단은 본문 문구가 아니라 `Retry-After` 유무로 가른다(이슈 #11 코멘트의 결정).
 * 문구는 공지 없이 바뀌고, 차단 판정은 대상 서버에서 항상 이 헤더와 함께 나간다.
 */
function classify403(input: RawResponse): Classification {
  const code = readErrorCode(input.body);
  const retryAfter = readRetryAfter(input.headers);
  if (retryAfter.ok) {
    return { ok: false, kind: 'IP_BLOCKED', detail: `HTTP 403 + Retry-After${errorCodeSuffix(input)}`, retryAfterSec: retryAfter.value };
  }

  if (code === 'OTP_REJECTED') {
    // 대상 서버는 OTP 실패를 잠금에 세지 않고(accounts.ts verifyOtp), 원인은 대개 30초
    // 경계에 걸린 코드다. 다음 코드로 다시 하면 풀린다. AUTH_FAILED로 보면 시계가 한
    // 칸 어긋난 것만으로 멀쩡한 작업이 DLQ에 간다. TRANSIENT는 시도 횟수를 깎으므로
    // 공유키가 정말 틀린 경우에도 재시도가 무한히 돌지는 않는다.
    return { ok: false, kind: 'TRANSIENT', detail: 'HTTP 403, 본문 OTP_REJECTED (2차 인증 코드 거부)' };
  }

  // OTP_REQUIRED는 SESSION_EXPIRED로 넣지 않는다. 2차 인증을 건너뛰고 조회했다는 뜻이라
  // 상대가 막은 것이 아니라 우리 흐름이 틀린 것이다. SESSION_EXPIRED는 시도 횟수를
  // 깎지 않으므로, 흐름 버그가 있으면 재인증 → 같은 버그 → 재인증이 끝없이 돌면서
  // 버그가 재시도 뒤에 숨는다. ACCOUNT_MISMATCH도 같은 이유로 여기로 온다.
  return unknown(input, `Retry-After 없는 403${errorCodeSuffix(input)}`);
}

function unknown(raw: ClassifyInput, detail: string): Failure {
  return { ok: false, kind: 'UNKNOWN', detail, raw };
}

/** 헤더 값을 대소문자와 상관없이 하나 꺼낸다. 같은 헤더가 여러 번 오면 첫 값을 쓴다. */
function header(headers: Headers, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * 구분 헤더는 값이 아니라 **있는지**로 본다. 대상 서버는 `1`을 싣지만, `0`이나 빈 값이
 * 왔을 때 "없음"으로 읽으면 자격증명 거부를 세션 만료로 읽는 쪽으로 틀린다.
 */
function headerPresent(headers: Headers, name: string): boolean {
  return header(headers, name) !== undefined;
}

type RetryAfter = { ok: true; value: number } | { ok: false; reason: string };

/**
 * `Retry-After`를 초로 읽는다. 초 단위 정수만 받는다.
 *
 * HTTP 날짜 형식은 받지 않는다. 날짜를 초로 바꾸려면 우리 시계와 상대 시계가 맞아야
 * 하는데, 그게 틀리면 음수나 몇 시간짜리 대기가 나온다. 대상 서버는 정수만 준다.
 */
function readRetryAfter(headers: Headers): RetryAfter {
  const raw = header(headers, 'retry-after');
  if (raw === undefined) return { ok: false, reason: '헤더 없음' };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: `해석 불가 ${JSON.stringify(raw)}` };
  return { ok: true, value: Number(trimmed) };
}

function charsetOf(headers: Headers): string | undefined {
  const contentType = header(headers, 'content-type');
  if (contentType === undefined) return undefined;
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase();
}

/**
 * JSON 본문의 `error` 필드. 본문이 JSON이 아니거나 필드가 없으면 undefined다.
 * 여기서 예외가 나면 분류기가 분류 대신 워커를 죽이므로, 파싱 실패는 값 없음으로 삼킨다.
 */
function readErrorCode(body: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

function errorCodeSuffix(input: RawResponse): string {
  const code = readErrorCode(input.body);
  return code === undefined ? '' : `, 본문 ${code}`;
}
