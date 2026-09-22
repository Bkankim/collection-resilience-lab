import { describe, expect, it } from 'vitest';

import { collect } from './client/session.js';
import type { Transport } from './client/transport.js';
import { FAILURE_KINDS } from './client/errors.js';
import { formatFailedReason, jobIdOf, normalizePeriod, parseFailedReason, resultsKey } from './queue.js';
import { redisUrlForTests } from './redis-for-tests.js';

describe('jobIdOf', () => {
  it('같은 계좌·기간이면 같은 ID이고, BullMQ가 받는 모양이다', () => {
    const a = jobIdOf('000-11-222333', '2026-09-01 00:00:00', '2026-09-30 23:59:59');
    expect(a).toBe(jobIdOf('000-11-222333', '2026-09-01 00:00:00', '2026-09-30 23:59:59'));
    // 정수로 읽히면 BullMQ가 거부하고, ':'도 거부한다. 접두사가 둘 다 막는다.
    expect(a).toMatch(/^col_[0-9a-f]{32}$/);
  });

  it('계좌·시작·끝 중 하나라도 다르면 다른 ID다', () => {
    const base = jobIdOf('000-11-222333', '2026-09-01 00:00:00', '2026-09-30 23:59:59');
    expect(jobIdOf('000-11-222334', '2026-09-01 00:00:00', '2026-09-30 23:59:59')).not.toBe(base);
    expect(jobIdOf('000-11-222333', '2026-09-02 00:00:00', '2026-09-30 23:59:59')).not.toBe(base);
    expect(jobIdOf('000-11-222333', '2026-09-01 00:00:00', '2026-09-29 23:59:59')).not.toBe(base);
  });

  it('경계를 옮겨 이어 붙이면 같아지는 입력도 다른 ID다', () => {
    expect(jobIdOf('1', '23', '4')).not.toBe(jobIdOf('12', '3', '4'));
  });
});

describe('normalizePeriod', () => {
  it('날짜만 주면 from은 00:00:00, to는 23:59:59로 채운다', () => {
    expect(normalizePeriod('2026-09-01', '2026-09-30')).toEqual({
      ok: true,
      from: '2026-09-01 00:00:00',
      to: '2026-09-30 23:59:59',
    });
    expect(normalizePeriod('2026-09-01 12:30:00', '2026-09-01 12:30:00')).toEqual({
      ok: true,
      from: '2026-09-01 12:30:00',
      to: '2026-09-01 12:30:00',
    });
  });

  it.each([
    ['형식', '2026/09/01', '2026-09-30'],
    ['문자열 아님', 20260901, '2026-09-30'],
    ['없음', undefined, '2026-09-30'],
    ['달력에 없는 날', '2026-02-30', '2026-03-01'],
    ['달력에 없는 시각', '2026-09-01 24:00:00', '2026-09-30'],
    ['from > to', '2026-09-30', '2026-09-01'],
    ['T 구분자', '2026-09-01T00:00:00', '2026-09-30'],
  ])('%s면 거절한다', (_label, from, to) => {
    expect(normalizePeriod(from, to).ok).toBe(false);
  });

  /**
   * API가 받은 기간을 세션이 던지면 요청은 202를 받고 작업은 워커에서 설정 오류로 죽는다.
   * 세션의 형식 검사(`normalizeBound`)는 내보내지 않은 함수라, 세션을 실제로 불러서 맞댄다.
   * 전송은 요청마다 연결 실패를 돌려준다. 세션은 기간을 먼저 검증하고 그다음 로그인하므로,
   * 던지면 형식 거절이고 실패 결과가 오면 형식은 통과한 것이다.
   */
  it('API가 받는 기간은 세션도 받는다(세션이 던지는 기간은 API도 거절한다)', async () => {
    const refused: Transport = async () => ({ network: { code: 'ECONNREFUSED', message: 'refused' } });
    const deps = { transport: refused, clock: () => 0, env: {} };
    const cases: [string, string][] = [
      ['2026-09-01', '2026-09-30'],
      ['2026-09-01 00:00:00', '2026-09-30 23:59:59'],
      ['2026-09-01', '2026-09-01 12:00:00'],
      ['2026/09/01', '2026-09-30'],
      ['2026-09-01T00:00:00', '2026-09-30'],
      ['2026-9-1', '2026-09-30'],
      ['2026-09-01 0:00:00', '2026-09-30'],
      ['', '2026-09-30'],
    ];
    for (const [from, to] of cases) {
      const api = normalizePeriod(from, to);
      const session = await collect(deps, 'demo01', '000-11-222333', from, to).then(
        () => 'accepted' as const,
        (error: unknown) => (error instanceof RangeError ? ('rejected' as const) : error),
      );
      if (api.ok) {
        expect(session, `${from} ~ ${to}`).toBe('accepted');
        // 정규화한 값도 세션이 받아야 한다. 큐에는 정규화한 값이 실린다.
        await expect(collect(deps, 'demo01', '000-11-222333', api.from, api.to)).resolves.toMatchObject({ ok: false });
      }
      if (session === 'rejected') expect(api.ok, `${from} ~ ${to}`).toBe(false);
    }
  });
});

describe('실패 기록 형식', () => {
  it('일곱 종류 모두 적은 그대로 읽힌다', () => {
    for (const kind of FAILURE_KINDS) {
      expect(parseFailedReason(formatFailedReason(kind, 'HTTP 401: 잠김'))).toEqual({ kind, detail: 'HTTP 401: 잠김' });
    }
  });

  it('분류 없이 죽은 작업은 kind가 null이고 메시지를 그대로 남긴다', () => {
    expect(parseFailedReason('자격증명을 찾을 수 없다: demo09')).toEqual({
      kind: null,
      detail: '자격증명을 찾을 수 없다: demo09',
    });
    expect(parseFailedReason(undefined)).toEqual({ kind: null, detail: '' });
  });
});

describe('resultsKey', () => {
  it('큐 이름으로 나뉜다', () => {
    expect(resultsKey('collections', 'col_1')).toBe('results:collections:col_1');
    expect(resultsKey('a', 'col_1')).not.toBe(resultsKey('b', 'col_1'));
  });
});

describe('redisUrlForTests', () => {
  it('REDIS_URL이 있으면 그것을 쓴다', () => {
    expect(redisUrlForTests({ REDIS_URL: 'redis://x:1', CI: 'true' })).toBe('redis://x:1');
  });
  it('로컬에서 없으면 건너뛴다', () => {
    expect(redisUrlForTests({})).toBeUndefined();
  });
  it('CI에서 없으면 조용히 건너뛰지 않고 던진다', () => {
    expect(() => redisUrlForTests({ CI: 'true' })).toThrow(/REDIS_URL/);
    expect(() => redisUrlForTests({ CI: 'true', REDIS_URL: '  ' })).toThrow(/REDIS_URL/);
  });
});
