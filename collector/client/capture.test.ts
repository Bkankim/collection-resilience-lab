import { describe, expect, it } from 'vitest';

import { REDACTED, redactFailure, redactForCapture } from './capture.js';
import type { Failure, RawResponse } from './classify.js';

const body = Buffer.from('{"level":"full"}');

describe('원본 저장 전 가리기', () => {
  it('set-cookie는 값만 가리고 이름과 속성은 남긴다', () => {
    const raw: RawResponse = {
      status: 200,
      headers: { 'set-cookie': ['lab_session=FULL-SECRET; Path=/; HttpOnly; Max-Age=1800', 'b=2'] },
      body,
    };
    expect(redactForCapture(raw)).toEqual({
      ...raw,
      headers: { 'set-cookie': [`lab_session=${REDACTED}; Path=/; HttpOnly; Max-Age=1800`, `b=${REDACTED}`] },
    });
  });

  it('cookie와 authorization도 가리고, 헤더 이름의 대소문자와 상관없이 본다', () => {
    const raw: RawResponse = {
      status: 401,
      headers: { Cookie: 'a=1; b=2', Authorization: 'Bearer abc.def', 'Set-Cookie': 'x=y', 'content-type': 'text/html' },
      body,
    };
    expect(redactForCapture(raw)).toMatchObject({
      headers: {
        Cookie: `a=${REDACTED}; b=${REDACTED}`,
        Authorization: `Bearer ${REDACTED}`,
        'Set-Cookie': `x=${REDACTED}`,
        'content-type': 'text/html',
      },
    });
  });

  it('본문과 상태 코드는 그대로 두고, 원본 객체를 바꾸지 않는다', () => {
    const raw: RawResponse = { status: 200, headers: { 'set-cookie': 'a=1' }, body };
    const redacted = redactForCapture(raw);
    expect(redacted).toMatchObject({ status: 200, body });
    expect(raw.headers['set-cookie']).toBe('a=1');
  });

  it('여러 번 불러도 결과가 같다. 워커가 저장 직전에 다시 불러도 된다', () => {
    const raw: RawResponse = { status: 200, headers: { 'set-cookie': 'a=1; Path=/' }, body };
    expect(redactForCapture(redactForCapture(raw))).toEqual(redactForCapture(raw));
  });

  it('원본이 없는 실패와 네트워크 오류는 그대로 둔다', () => {
    const transient: Failure = { ok: false, kind: 'TRANSIENT', detail: 'HTTP 503' };
    expect(redactFailure(transient)).toBe(transient);
    const network = { network: { code: 'ENOTFOUND', message: 'x' } };
    expect(redactForCapture(network)).toBe(network);
  });
});
