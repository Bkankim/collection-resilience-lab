/**
 * 세션 통합 테스트.
 *
 * `inject()`가 아니라 `listen({ port: 0 })`으로 대상 서버를 실제 포트에 띄우고 undici로
 * 붙는다(#9 코멘트의 결정). D1 결함 2건이 전부 inject가 지나지 않는 경계(쿠키 자)에서
 * 나왔다. 시계는 서버와 클라이언트가 같은 것을 쓰고 테스트가 소유한다. TOTP 코드와
 * 세션 만료가 둘 다 이 시계를 본다.
 */

import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_ACCOUNTS } from '../../target/accounts.js';
import { buildApp } from '../../target/app.js';
import { TRANSACTIONS_CONTENT_TYPE, buildLedger, encodeEucKr, renderTransactionsHtml, selectPage } from '../../target/transactions.js';
import { REDACTED } from './capture.js';
import type { ClassifyInput, RawResponse } from './classify.js';
import { CookieJar } from './cookies.js';
import { lookupCredentials } from './credentials.js';
import { CollectorSession, collect } from './session.js';
import { createUndiciTransport } from './transport.js';
import type { HttpRequest, Transport } from './transport.js';

const ACCOUNT = DEMO_ACCOUNTS[0]!;
const CREDS = lookupCredentials('demo01', {})!;
const START_MS = Date.UTC(2026, 8, 23, 3, 0, 0);

type Lab = {
  origin: string;
  clock: () => number;
  advance: (ms: number) => void;
  /** 요청마다 불리는 훅을 끼울 수 있는 전송. 기본은 그대로 통과. */
  transport: (hook?: (req: HttpRequest, res: ClassifyInput) => void) => Transport;
  configure: (body: unknown) => Promise<void>;
};

const open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function makeLab(): Promise<Lab> {
  let now = START_MS;
  const clock = () => now;
  const app = buildApp({ clock });
  open.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const base = createUndiciTransport({ origin });
  return {
    origin,
    clock,
    advance: (ms) => {
      now += ms;
    },
    transport: (hook) => async (req) => {
      const res = await base(req);
      hook?.(req, res);
      return res;
    },
    configure: async (body) => {
      const res = await base({
        method: 'POST',
        path: '/admin/switches',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if ('network' in res || res.status !== 200) throw new Error('스위치 설정 실패');
    },
  };
}

/** 세션 만료만 켠다. 스위치 3개와 임계값 5개를 전부 명시한다(D1 증거 문서의 규칙). */
function expiryOn(sessionTtlSec: number) {
  return {
    switches: { rateLimit: false, ipBlock: false, sessionExpiry: true },
    thresholds: { windowSec: 10, maxRequests: 5, blockAfter: 3, blockDurationSec: 30, sessionTtlSec },
  };
}

/** `/auth/otp` 응답의 쿠키를 버리는 저장소. 승급 쿠키를 무시하는 흐름 버그를 재현한다. */
class DropsPromotedCookie extends CookieJar {
  broken = true;
  override store(setCookie: string | string[] | undefined, requestPath: string): void {
    if (this.broken && requestPath === '/auth/otp') return;
    super.store(setCookie, requestPath);
  }
}

const isPage = (req: HttpRequest, page: number) => req.path.startsWith('/transactions') && req.path.endsWith(`page=${page}`);

describe('수집 세션: 로그인', () => {
  it('2차 인증 뒤 저장소에는 승급된 식별자 하나만 남는다', async () => {
    const lab = await makeLab();
    const issued: string[] = [];
    const transport = lab.transport((_req, res) => {
      if (!('network' in res)) issued.push(...[res.headers['set-cookie'] ?? []].flat());
    });
    const session = new CollectorSession({ transport, credentials: CREDS, clock: lab.clock });

    expect(await session.login()).toBeUndefined();
    expect(issued).toHaveLength(2);
    const promoted = issued[1]!.split(';')[0]!;
    expect(issued[0]!.split(';')[0]).not.toBe(promoted);
    expect(session.jar.list()).toHaveLength(1);
    expect(session.jar.headerFor('/transactions')).toBe(promoted);
  });

  it('비밀번호가 틀리면 AUTH_FAILED를 돌려주고 다시 로그인하지 않는다', async () => {
    const lab = await makeLab();
    const session = new CollectorSession({
      transport: lab.transport(),
      credentials: { ...CREDS, password: 'wrong' },
      clock: lab.clock,
    });
    expect(await session.fetchPage(ACCOUNT.accountNo, 1)).toMatchObject({ ok: false, kind: 'AUTH_FAILED' });
    expect(session.stats.logins).toBe(1);
  });

  it('세션 수명이 로그인 흐름보다 짧으면 2차 인증 자리에서 흐름 버그로 올린다', async () => {
    // 재인증해도 같은 자리에서 또 막힌다. SESSION_EXPIRED로 돌려주면 끝없이 돈다.
    const lab = await makeLab();
    await lab.configure(expiryOn(1));
    const transport = lab.transport((req) => {
      if (req.path === '/login') lab.advance(2_000);
    });
    const session = new CollectorSession({ transport, credentials: CREDS, clock: lab.clock });
    const result = await session.fetchPage(ACCOUNT.accountNo, 1);
    expect(result).toMatchObject({ ok: false, kind: 'UNKNOWN', detail: expect.stringContaining('2차 인증에서 세션 실패') });
    expect(result).toHaveProperty('raw');
    expect(session.stats.logins).toBe(1);
  });
});

describe('수집 세션: 세션 만료와 재인증', () => {
  it('137건 전부를 한 세션으로 모으고 원장과 일치한다', async () => {
    const lab = await makeLab();
    const session = new CollectorSession({ transport: lab.transport(), credentials: CREDS, clock: lab.clock });
    const result = await session.collect(ACCOUNT.accountNo, '2026-01-01', '2026-12-31');
    expect(result).toMatchObject({ ok: true, pages: 8 });
    if (!result.ok) return;
    expect(result.rows).toEqual(buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount));
    expect(session.stats).toEqual({ logins: 1, reauths: 0, requests: 2 + 8 });
  });

  it('도중에 세션이 만료되면 재인증하고 그 페이지부터 이어 간다', async () => {
    const lab = await makeLab();
    await lab.configure(expiryOn(60));
    const pagesSent: string[] = [];
    const transport = lab.transport((req) => {
      if (req.path.startsWith('/transactions')) pagesSent.push(req.path.split('page=')[1]!);
      // 3페이지를 받은 직후 세션 수명(60초)을 넘긴다.
      if (isPage(req, 3)) lab.advance(61_000);
    });
    const session = new CollectorSession({ transport, credentials: CREDS, clock: lab.clock });
    const result = await session.collect(ACCOUNT.accountNo, '2026-01-01', '2026-12-31');

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.rows).toEqual(buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount));
    expect(session.stats).toMatchObject({ logins: 2, reauths: 1 });
    // 4페이지가 한 번 거절되고 재인증 뒤 다시 간다. 1페이지부터 다시 긁지 않는다.
    expect(pagesSent).toEqual(['1', '2', '3', '4', '4', '5', '6', '7', '8']);
  });

  it('승급 쿠키를 버리는 흐름 버그는 첫 요청에서 UNKNOWN으로 올리고 로그인은 한 번뿐이다', async () => {
    const lab = await makeLab();
    const session = new CollectorSession({
      transport: lab.transport(),
      credentials: CREDS,
      clock: lab.clock,
      jar: new DropsPromotedCookie(lab.clock),
    });
    const result = await session.fetchPage(ACCOUNT.accountNo, 1);
    expect(result).toMatchObject({ ok: false, kind: 'UNKNOWN', detail: expect.stringContaining('로그인 직후 첫 요청이 세션 실패') });
    expect(result).toHaveProperty('raw.status', 401);
    expect(session.stats.logins).toBe(1);
  });

  it('재인증 뒤에만 나타나는 흐름 버그도 무한 재인증 대신 UNKNOWN이고 로그인은 두 번뿐이다', async () => {
    const lab = await makeLab();
    await lab.configure(expiryOn(60));
    const jar = new DropsPromotedCookie(lab.clock);
    jar.broken = false;
    const session = new CollectorSession({ transport: lab.transport(), credentials: CREDS, clock: lab.clock, jar });

    expect(await session.fetchPage(ACCOUNT.accountNo, 1)).toMatchObject({ ok: true });
    jar.broken = true;
    lab.advance(61_000);

    const result = await session.fetchPage(ACCOUNT.accountNo, 2);
    expect(result).toMatchObject({ ok: false, kind: 'UNKNOWN', detail: expect.stringContaining('재인증 직후 첫 요청이 다시 세션 실패') });
    expect(session.stats).toMatchObject({ logins: 2, reauths: 1 });
  });
});

describe('수집 세션: 기간과 전송', () => {
  const ledger = buildLedger(ACCOUNT.accountNo, ACCOUNT.txCount);

  it('기간은 양끝을 포함하고, 1초 밖은 뺀다', async () => {
    const lab = await makeLab();
    const from = ledger[10]!.at;
    const to = ledger[30]!.at;
    const result = await collect({ transport: lab.transport(), clock: lab.clock, env: {} }, 'demo01', ACCOUNT.accountNo, from, to);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.rows.map((r) => r.seq)).toEqual(ledger.slice(10, 31).map((r) => r.seq));

    const shifted = (at: string, sec: number) =>
      new Date(Date.parse(`${at.replace(' ', 'T')}Z`) + sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const narrow = await collect(
      { transport: lab.transport(), clock: lab.clock, env: {} },
      'demo01',
      ACCOUNT.accountNo,
      shifted(from, 1),
      shifted(to, -1),
    );
    if (!narrow.ok) throw new Error(narrow.detail);
    expect(narrow.rows.map((r) => r.seq)).toEqual(ledger.slice(11, 30).map((r) => r.seq));
  });

  it('날짜만 주면 끝 날짜의 하루 전체를 포함한다', async () => {
    const lab = await makeLab();
    const day = ledger[20]!.at.slice(0, 10);
    const result = await collect({ transport: lab.transport(), clock: lab.clock, env: {} }, 'demo01', ACCOUNT.accountNo, day, day);
    if (!result.ok) throw new Error(result.detail);
    expect(result.rows).toEqual(ledger.filter((r) => r.at.startsWith(day)));
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('기간 형식이 틀리면 조용히 빈 결과를 주지 않고 던진다', async () => {
    const lab = await makeLab();
    const session = new CollectorSession({ transport: lab.transport(), credentials: CREDS, clock: lab.clock });
    await expect(session.collect(ACCOUNT.accountNo, '2026/01/01', '2026-12-31')).rejects.toThrow(RangeError);
    expect(session.stats.requests).toBe(0);
  });

  it('모르는 로그인 ID는 설정 오류라 던진다', async () => {
    const lab = await makeLab();
    await expect(collect({ transport: lab.transport(), clock: lab.clock, env: {} }, 'nobody', ACCOUNT.accountNo, '2026-01-01', '2026-01-02')).rejects.toThrow(
      '자격증명',
    );
  });

  it('302에 실린 Set-Cookie를 저장하고, 따라가지 않고 UNKNOWN과 원본을 돌려준다', async () => {
    // 대상 서버에는 302가 없어 주입한 전송으로만 확인한다(#9 코멘트: 302 추종은 범위 밖).
    const calls: string[] = [];
    const redirect: RawResponse = {
      status: 302,
      headers: { location: '/login', 'set-cookie': ['lab_session=from-302; Path=/; Max-Age=1800'] },
      body: Buffer.alloc(0),
    };
    const transport: Transport = async (req) => {
      calls.push(`${req.method} ${req.path}`);
      if (req.path === '/login') return { status: 200, headers: {}, body: Buffer.from('{"next":"otp"}') };
      if (req.path === '/auth/otp') return { status: 200, headers: {}, body: Buffer.from('{"level":"FULL"}') };
      return redirect;
    };
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    const result = await session.fetchPage(ACCOUNT.accountNo, 1);

    // 원본은 싣되 세션 식별자는 가린다(capture.ts). 위치와 상태 코드는 그대로다.
    expect(result).toMatchObject({
      ok: false,
      kind: 'UNKNOWN',
      raw: { status: 302, headers: { location: '/login', 'set-cookie': [`lab_session=${REDACTED}; Path=/; Max-Age=1800`] } },
      detail: expect.stringContaining('302'),
    });
    expect(session.jar.headerFor('/transactions')).toBe('lab_session=from-302');
    expect(calls).toEqual(['POST /login', 'POST /auth/otp', `GET /transactions?account=${ACCOUNT.accountNo}&page=1`]);
  });

  it('네트워크 오류는 분류된 TRANSIENT로 돌아오고 던지지 않는다', async () => {
    const transport = createUndiciTransport({ origin: 'http://127.0.0.1:1' });
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    expect(await session.fetchPage(ACCOUNT.accountNo, 1)).toMatchObject({ ok: false, kind: 'TRANSIENT' });
  });

  it('인증 2xx 본문이 예상과 달라 UNKNOWN이 되면 원본의 세션 식별자를 가린다', async () => {
    const transport: Transport = async (req) =>
      req.path === '/login'
        ? { status: 200, headers: { 'set-cookie': 'lab_session=PRIMARY-SECRET; Path=/' }, body: Buffer.from('{"next":"otp"}') }
        : { status: 200, headers: { 'set-cookie': 'lab_session=FULL-SECRET-ID; Path=/' }, body: Buffer.from('{"level":"full"}') };
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    const failure = await session.login();
    expect(failure).toMatchObject({ kind: 'UNKNOWN', raw: { headers: { 'set-cookie': `lab_session=${REDACTED}; Path=/` } } });
    expect(JSON.stringify(failure)).not.toContain('SECRET');
  });

  it('TOTP 공유키가 틀린 자격증명으로는 세션을 만들지 않고, 요청도 하나도 나가지 않는다', () => {
    const calls: string[] = [];
    const transport: Transport = async (req) => {
      calls.push(req.path);
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    };
    expect(() => new CollectorSession({ transport, credentials: { ...CREDS, totpSecret: 'SHORT' }, clock: () => START_MS })).toThrow(
      RangeError,
    );
    expect(calls).toEqual([]);
  });
});

describe('수집 세션: 끝나지 않는 페이지 넘김을 막는다', () => {
  /** 인증은 통과시키고 거래내역은 `page`에 따라 만든 HTML을 주는 가짜 전송. */
  function fakeServer(render: (page: number) => string) {
    const pageRequests: number[] = [];
    const transport: Transport = async (req) => {
      if (req.path === '/login') return { status: 200, headers: {}, body: Buffer.from('{"next":"otp"}') };
      if (req.path === '/auth/otp') return { status: 200, headers: {}, body: Buffer.from('{"level":"FULL"}') };
      const page = Number(req.path.split('page=')[1]);
      pageRequests.push(page);
      if (pageRequests.length > 50) throw new Error('끝나지 않는다');
      return { status: 200, headers: { 'content-type': TRANSACTIONS_CONTENT_TYPE }, body: encodeEucKr(render(page)) };
    };
    return { transport, pageRequests };
  }

  it('?page=를 무시하고 매번 1페이지를 주는 서버에는 2페이지에서 UNKNOWN으로 멈춘다', async () => {
    // 1페이지 응답은 그 자체로 멀쩡해서 파서를 통과한다. 빈 페이지가 영영 오지 않는다.
    const { transport, pageRequests } = fakeServer(() => renderTransactionsHtml(selectPage(ACCOUNT.accountNo, ACCOUNT.txCount, 1)));
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    const result = await session.collect(ACCOUNT.accountNo, '2026-01-01', '2026-12-31');
    expect(result).toMatchObject({ ok: false, kind: 'UNKNOWN', detail: expect.stringContaining('요청 000-11-222333 2페이지, 응답 000-11-222333 1페이지') });
    expect(result).toHaveProperty('raw.status', 200);
    expect(pageRequests).toEqual([1, 2]);
  });

  it('다른 계좌의 페이지를 주면 UNKNOWN이다', async () => {
    const { transport } = fakeServer((page) => renderTransactionsHtml(selectPage(DEMO_ACCOUNTS[1]!.accountNo, 12, page)));
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    const result = await session.collect(ACCOUNT.accountNo, '2026-01-01', '2026-12-31');
    expect(result).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('000-44-555666') });
  });

  it('총 건수가 페이지마다 늘어 빈 페이지가 안 오면 첫 totalPages + 1에서 멈춘다', async () => {
    // 매 페이지가 요청한 번호이고 요약과도 맞아서 앞의 검사를 모두 통과한다.
    const { transport, pageRequests } = fakeServer((page) => renderTransactionsHtml(selectPage(ACCOUNT.accountNo, (page + 1) * 20, page)));
    const session = new CollectorSession({ transport, credentials: CREDS, clock: () => START_MS });
    const result = await session.collect(ACCOUNT.accountNo, '2026-01-01', '2026-12-31');
    expect(result).toMatchObject({ kind: 'UNKNOWN', detail: expect.stringContaining('totalPages + 1(3)') });
    expect(pageRequests).toEqual([1, 2, 3]);
  });
});
