/**
 * 응답 분류기 테스트. 이슈 #11의 핵심은 애매한 응답 목록이고, 그 목록을 여기서 고정한다.
 *
 * 헤더와 본문은 대상 서버(`target/app.ts`)가 실제로 내는 모양을 따른다. 200 본문은
 * 대상 서버 렌더러와 인코더가 만든 실제 EUC-KR 바이트다.
 */

import { describe, expect, it } from 'vitest';

import { DEMO_ACCOUNTS } from '../../target/accounts.js';
import {
  TRANSACTIONS_CONTENT_TYPE,
  buildLedger,
  encodeEucKr,
  renderTransactionsHtml,
  selectPage,
} from '../../target/transactions.js';
import { DEFAULT_RATE_LIMIT_WAIT_SEC, classify } from './classify.js';
import type { ClassifyInput, Headers, RawResponse } from './classify.js';
import { FIRST_REMEDY } from './errors.js';

const ACCOUNT = DEMO_ACCOUNTS[0]!;
const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Headers = {}): RawResponse {
  return { status, headers: { 'content-type': JSON_TYPE, ...headers }, body: Buffer.from(JSON.stringify(body)) };
}

function html(page: number, count = ACCOUNT.txCount): RawResponse {
  const bytes = encodeEucKr(renderTransactionsHtml(selectPage(ACCOUNT.accountNo, count, page)));
  return { status: 200, headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE }, body: bytes };
}

function network(network: { code?: string; name?: string; message: string }): ClassifyInput {
  return { network };
}

/** 로그인 화면처럼 200이지만 거래 표가 없는 응답. 세션이 풀려 로그인 화면으로 돌려보내는 기관이 흔하다. */
const LOGIN_PAGE: RawResponse = {
  status: 200,
  headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE },
  body: encodeEucKr(`<!doctype html>
<html lang="ko">
<head><meta charset="euc-kr"><title>로그인</title></head>
<body>
  <form id="login" method="post" action="/login">
    <label>아이디 <input name="id"></label>
    <label>비밀번호 <input name="password" type="password"></label>
  </form>
</body>
</html>
`),
};

describe('응답 분류기: 속도 제한', () => {
  it('429 + Retry-After는 그 값을 대기 시간으로 쓴다', () => {
    const result = classify(json(429, { error: 'RATE_LIMITED' }, { 'retry-after': '7' }));
    expect(result).toMatchObject({ ok: false, kind: 'RATE_LIMITED', retryAfterSec: 7 });
  });

  it('429에 Retry-After가 없어도 속도 제한이고, 기본 대기와 헤더 없음을 남긴다', () => {
    // 헤더가 없다고 UNKNOWN으로 보내면 속도 제한 한 번에 작업이 DLQ로 간다.
    const result = classify(json(429, {}));
    expect(result).toMatchObject({
      ok: false,
      kind: 'RATE_LIMITED',
      retryAfterSec: DEFAULT_RATE_LIMIT_WAIT_SEC,
      detail: expect.stringContaining('헤더 없음'),
    });
  });

  it('Retry-After가 날짜 형식이면 해석하지 않고 기본 대기를 쓴다', () => {
    const result = classify(json(429, {}, { 'retry-after': 'Wed, 23 Sep 2026 03:00:00 GMT' }));
    expect(result).toMatchObject({
      kind: 'RATE_LIMITED',
      retryAfterSec: DEFAULT_RATE_LIMIT_WAIT_SEC,
      detail: expect.stringContaining('해석 불가'),
    });
  });
});

describe('응답 분류기: 401은 헤더로 갈린다', () => {
  it('401 + X-Session-Expired는 세션 만료다', () => {
    const result = classify(json(401, { error: 'SESSION_EXPIRED' }, { 'x-session-expired': '1' }));
    expect(result).toMatchObject({ kind: 'SESSION_EXPIRED' });
  });

  it('401 + X-Auth-Failed는 자격증명 실패다', () => {
    const result = classify(json(401, { error: 'BAD_CREDENTIALS' }, { 'x-auth-failed': '1' }));
    expect(result).toMatchObject({ kind: 'AUTH_FAILED', detail: expect.stringContaining('BAD_CREDENTIALS') });
  });

  it('두 헤더가 함께 오면 자격증명 실패로 읽는다', () => {
    // 세션 만료로 읽고 재인증하면 계정이 잠긴다. 틀려도 되돌릴 수 있는 쪽을 고른다.
    const result = classify(json(401, {}, { 'x-session-expired': '1', 'x-auth-failed': '1' }));
    expect(result).toMatchObject({ kind: 'AUTH_FAILED' });
  });

  it('헤더 이름의 대소문자와 값에 상관없이 X-Auth-Failed가 있으면 자격증명 실패다', () => {
    expect(classify(json(401, { error: 'LOCKED' }, { 'X-Auth-Failed': '1' }))).toMatchObject({ kind: 'AUTH_FAILED' });
    expect(classify(json(401, {}, { 'x-auth-failed': '0' }))).toMatchObject({ kind: 'AUTH_FAILED' });
  });

  it('헤더 없는 401 + NO_SESSION은 인증부터 하면 되므로 세션 만료로 묶는다', () => {
    const result = classify(json(401, { error: 'NO_SESSION' }));
    expect(result).toMatchObject({ kind: 'SESSION_EXPIRED', detail: expect.stringContaining('NO_SESSION') });
    expect(result).not.toHaveProperty('raw');
  });

  it('헤더도 알려진 본문도 없는 401은 추측하지 않고 UNKNOWN이다', () => {
    const input: RawResponse = { status: 401, headers: {}, body: Buffer.from('<html>unauthorized</html>') };
    expect(classify(input)).toMatchObject({ kind: 'UNKNOWN', raw: input, detail: expect.stringContaining('401') });
  });
});

describe('응답 분류기: 403은 차단과 우리 흐름 오류를 가른다', () => {
  it('403 + Retry-After는 출발지 차단이다', () => {
    const result = classify(json(403, { error: 'IP_BLOCKED', origin: '127.0.0.1', retryAfterSec: 30 }, { 'retry-after': '30' }));
    expect(result).toMatchObject({ kind: 'IP_BLOCKED', retryAfterSec: 30 });
  });

  it.each(['Wed, 23 Sep 2026 03:00:00 GMT', '', '30s', '1.5'])(
    '403 + 해석할 수 없는 Retry-After %j도 헤더가 있으므로 출발지 차단이고 기본 대기를 쓴다',
    (value) => {
      const result = classify(json(403, { error: 'IP_BLOCKED' }, { 'retry-after': value }));
      expect(result).toMatchObject({
        kind: 'IP_BLOCKED',
        retryAfterSec: DEFAULT_RATE_LIMIT_WAIT_SEC,
        detail: expect.stringContaining('해석 불가'),
      });
    },
  );

  it('2차 인증 전 조회(OTP_REQUIRED)는 세션 만료가 아니라 UNKNOWN이다', () => {
    // SESSION_EXPIRED는 시도 횟수를 깎지 않는다. 흐름 버그를 재인증으로 덮으면 끝없이 돈다.
    const result = classify(json(403, { error: 'OTP_REQUIRED' }));
    expect(result).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('OTP_REQUIRED') });
  });

  it('계좌 불일치(ACCOUNT_MISMATCH)도 UNKNOWN이다', () => {
    expect(classify(json(403, { error: 'ACCOUNT_MISMATCH' }))).toMatchObject({ kind: 'UNKNOWN' });
  });

  it('2차 인증 코드 거부(OTP_REJECTED)는 다음 코드로 다시 하면 되는 일시 실패다', () => {
    expect(classify(json(403, { error: 'OTP_REJECTED' }))).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('본문이 IP_BLOCKED라도 Retry-After가 없으면 차단으로 단정하지 않는다', () => {
    // 대상 서버는 차단에 항상 Retry-After를 싣는다. 없으면 계약이 깨진 응답이다.
    expect(classify(json(403, { error: 'IP_BLOCKED' }))).toMatchObject({ kind: 'UNKNOWN' });
  });
});

describe('응답 분류기: 일시 장애', () => {
  it.each([500, 502, 503, 504])('HTTP %i는 TRANSIENT다', (status) => {
    expect(classify({ status, headers: {}, body: Buffer.from('bad gateway') })).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('503 + Retry-After는 그 값을 싣는다', () => {
    expect(classify({ status: 503, headers: { 'retry-after': '5' }, body: Buffer.alloc(0) })).toMatchObject({
      kind: 'TRANSIENT',
      retryAfterSec: 5,
    });
  });

  it.each([
    { name: 'TimeoutError', message: 'The operation was aborted due to timeout' },
    { code: 'ECONNRESET', message: 'socket hang up' },
    { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:8081' },
    { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError', message: 'Headers Timeout Error' },
  ])('네트워크 오류 $code $name 은 TRANSIENT다', (error) => {
    expect(classify(network(error))).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('DNS 실패와 사용자가 끊은 요청은 UNKNOWN이다', () => {
    expect(classify(network({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND target' }))).toMatchObject({ kind: 'UNKNOWN' });
    expect(classify(network({ name: 'AbortError', message: 'This operation was aborted' }))).toMatchObject({ kind: 'UNKNOWN' });
  });
});

describe('응답 분류기: 200', () => {
  it('정상 거래 페이지는 성공이고 EUC-KR 한글 적요를 읽는다', () => {
    const result = classify(html(1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.rows).toEqual(buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount).slice(0, 20));
    expect(result.page.rows.some((row) => /[가-힣]/.test(row.memo))).toBe(true);
  });

  it('표는 있으나 행이 0개인 마지막 페이지 이후는 실패가 아니다', () => {
    const result = classify(html(8));
    expect(result).toMatchObject({ ok: true, page: { page: 8, total: 137, totalPages: 7, rows: [] } });
  });

  it('200인데 거래 표가 없는 로그인 화면은 PARSE_FAILED이고 원본을 싣는다', () => {
    const result = classify(LOGIN_PAGE);
    expect(result).toMatchObject({ ok: false, kind: 'PARSE_FAILED', raw: LOGIN_PAGE });
  });

  it('요약 줄은 있으나 표가 없으면 PARSE_FAILED다', () => {
    const text = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)).replace('id="transactions"', 'id="tx"');
    const result = classify({ status: 200, headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE }, body: encodeEucKr(text) });
    expect(result).toMatchObject({ kind: 'PARSE_FAILED', detail: expect.stringContaining('table#transactions') });
  });

  it('요약은 2페이지인데 행이 1페이지 것이면 PARSE_FAILED이고 원본을 싣는다', () => {
    const page2 = selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 2);
    const rows = selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1).rows;
    const input: RawResponse = {
      status: 200,
      headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE },
      body: encodeEucKr(renderTransactionsHtml({ ...page2, rows })),
    };
    expect(classify(input)).toMatchObject({ kind: 'PARSE_FAILED', raw: input, detail: expect.stringContaining('seq 1, 기대 21') });
  });

  it('요약의 data-* 숫자가 깨지면 PARSE_FAILED다', () => {
    const text = renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)).replace('data-total="137"', 'data-total=""');
    const result = classify({ status: 200, headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE }, body: encodeEucKr(text) });
    expect(result).toMatchObject({ kind: 'PARSE_FAILED', detail: expect.stringContaining('data-total') });
  });

  it('200 JSON 응답은 PARSE_FAILED다', () => {
    expect(classify({ ...json(200, { ok: true }), headers: {} })).toMatchObject({ kind: 'PARSE_FAILED' });
  });

  it('charset이 EUC-KR이 아니라고 선언되면 파싱하지 않는다', () => {
    const result = classify({ ...html(1), headers: { 'content-type': 'text/html; charset=utf-8' } });
    expect(result).toMatchObject({ kind: 'PARSE_FAILED', detail: expect.stringContaining('utf-8') });
  });
});

describe('응답 분류기: 그 밖', () => {
  it('400 BAD_PAGE는 우리 요청이 틀린 것이라 UNKNOWN이고 원본을 싣는다', () => {
    const input = json(400, { error: 'BAD_PAGE' });
    expect(classify(input)).toMatchObject({ kind: 'UNKNOWN', raw: input, detail: expect.stringContaining('BAD_PAGE') });
  });

  it('JSON이 아닌 본문에서도 예외를 던지지 않는다', () => {
    const garbage = Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x22]);
    for (const status of [400, 401, 403, 418]) {
      expect(() => classify({ status, headers: {}, body: garbage })).not.toThrow();
    }
  });

  it('원본을 남기는 대응을 가진 모든 판정에 원본이 실려 있다', () => {
    // 일곱 종류가 전부 나오는 입력을 여기서 직접 만든다. 다른 테스트가 쌓은 결과에
    // 기대면 이 테스트만 단독으로 돌릴 때 검사할 대상이 없어 뜻을 잃는다.
    const inputs: ClassifyInput[] = [
      json(429, {}, { 'retry-after': '3' }),
      json(403, { error: 'IP_BLOCKED' }, { 'retry-after': '30' }),
      json(401, {}, { 'x-session-expired': '1' }),
      json(401, {}, { 'x-auth-failed': '1' }),
      { status: 503, headers: {}, body: Buffer.alloc(0) },
      network({ code: 'ECONNRESET', message: 'socket hang up' }),
      LOGIN_PAGE,
      json(400, { error: 'BAD_PAGE' }),
      json(403, { error: 'OTP_REQUIRED' }),
      network({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND target' }),
    ];
    const kinds = new Set<string>();
    for (const input of inputs) {
      const result = classify(input);
      if (result.ok) throw new Error('실패 입력만 넣었다');
      kinds.add(result.kind);
      const captures = (FIRST_REMEDY[result.kind] as readonly string[]).includes('CAPTURE_RAW');
      if (captures) {
        expect('raw' in result && result.raw, `${result.kind}: ${result.detail}`).toBe(input);
      } else {
        expect(result, `${result.kind}: ${result.detail}`).not.toHaveProperty('raw');
      }
    }
    expect(kinds.size).toBe(7);
  });
});
