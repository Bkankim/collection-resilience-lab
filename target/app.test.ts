/**
 * 대상 서버 통합 테스트.
 *
 * 포트를 열지 않고 `app.inject()`로 요청을 넣는다. 시각은 테스트가 소유하므로
 * "T초 뒤 차단이 풀린다"를 T초 기다려서가 아니라 시계를 밀어서 확인한다.
 *
 * `inject`의 `remoteAddress`가 `request.socket.remoteAddress`로 그대로 들어가서,
 * 출발지별 판정도 Docker 없이 검증된다.
 */

import iconv from 'iconv-lite';
import { generateSync } from 'otplib';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_ACCOUNTS, MAX_PASSWORD_FAILURES } from './accounts.js';
import { buildApp } from './app.js';
import { SESSION_COOKIE_MAX_AGE_SEC } from './sessions.js';
import { PAGE_SIZE, buildLedger } from './transactions.js';

const ACCOUNT = DEMO_ACCOUNTS[0]!;
const OTHER = DEMO_ACCOUNTS[1]!;
const START_MS = Date.UTC(2026, 8, 23, 3, 0, 0);

type Lab = {
  app: FastifyInstance;
  now: () => number;
  advance: (ms: number) => void;
};

const open: FastifyInstance[] = [];

function makeLab(): Lab {
  let now = START_MS;
  const app = buildApp({ clock: () => now });
  open.push(app);
  return {
    app,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

/** `Set-Cookie`에서 `name=value` 부분만 떼어 다음 요청의 `Cookie`로 쓴다. */
function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0] ?? '';
}

async function configure(
  lab: Lab,
  body: { switches?: Record<string, boolean>; thresholds?: Record<string, number> },
) {
  const res = await lab.app.inject({ method: 'POST', url: '/admin/switches', payload: body });
  expect(res.statusCode).toBe(200);
  return res;
}

function otpFor(lab: Lab, secret: string): string {
  // otplib의 epoch은 초 단위다. 주입한 시계는 밀리초라서 여기서 나눈다.
  return generateSync({ secret, epoch: Math.floor(lab.now() / 1000) });
}

async function loginOnly(lab: Lab, extra: InjectOptions = {}) {
  return lab.app.inject({
    method: 'POST',
    url: '/login',
    payload: { id: ACCOUNT.id, password: ACCOUNT.password },
    ...extra,
  });
}

/** 로그인 → OTP까지 끝낸 뒤 쓸 수 있는 쿠키를 돌려준다. */
async function fullSession(lab: Lab, extra: InjectOptions = {}): Promise<string> {
  const loginRes = await loginOnly(lab, extra);
  expect(loginRes.statusCode).toBe(200);

  const otpRes = await lab.app.inject({
    method: 'POST',
    url: '/auth/otp',
    headers: { cookie: cookieFrom(loginRes.headers) },
    payload: { token: otpFor(lab, ACCOUNT.totpSecret) },
    ...extra,
  });
  expect(otpRes.statusCode).toBe(200);
  return cookieFrom(otpRes.headers);
}

describe('#6 로그인과 2차 인증, 세션 발급', () => {
  it('로그인 → OTP → 거래내역 조회가 한 번에 통과한다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    const res = await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('세션 쿠키에 HttpOnly·Path·Max-Age가 붙는다', async () => {
    const lab = makeLab();
    const res = await loginOnly(lab);

    const raw = res.headers['set-cookie'];
    const header = String(Array.isArray(raw) ? raw[0] : raw);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toMatch(/Max-Age=\d+/);
  });

  it('로그인하면 들고 온 세션 식별자를 버리고 새로 발급한다', async () => {
    const lab = makeLab();
    const first = await loginOnly(lab);
    const carried = cookieFrom(first.headers);

    const second = await loginOnly(lab, { headers: { cookie: carried } });
    expect(cookieFrom(second.headers)).not.toBe(carried);

    // 승급시키지 않는 것만으로는 부족하다. 옛 식별자가 살아 있으면 공격자가
    // 그걸로 계속 요청할 수 있으므로 폐기까지 확인한다.
    const reused = await lab.app.inject({
      method: 'POST',
      url: '/auth/otp',
      headers: { cookie: carried },
      payload: { token: otpFor(lab, ACCOUNT.totpSecret) },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('2차 인증을 통과할 때도 식별자를 새로 발급한다', async () => {
    const lab = makeLab();
    const loginRes = await loginOnly(lab);
    const beforeOtp = cookieFrom(loginRes.headers);

    const otpRes = await lab.app.inject({
      method: 'POST',
      url: '/auth/otp',
      headers: { cookie: beforeOtp },
      payload: { token: otpFor(lab, ACCOUNT.totpSecret) },
    });
    expect(otpRes.statusCode).toBe(200);
    expect(cookieFrom(otpRes.headers)).not.toBe(beforeOtp);

    const reused = await lab.app.inject({
      method: 'GET',
      url: '/transactions',
      headers: { cookie: beforeOtp },
    });
    expect(reused.statusCode).toBe(401);
  });

  it('인증 없이 조회하면 401이다', async () => {
    const lab = makeLab();
    const res = await lab.app.inject({ method: 'GET', url: '/transactions' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-session-expired']).toBeUndefined();
    expect(res.headers['x-auth-failed']).toBeUndefined();
  });

  it('1차만 통과한 세션으로 조회하면 403이다', async () => {
    const lab = makeLab();
    const loginRes = await loginOnly(lab);

    const res = await lab.app.inject({
      method: 'GET',
      url: '/transactions',
      headers: { cookie: cookieFrom(loginRes.headers) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('OTP가 틀리면 403이고 세션은 1차 상태로 남는다', async () => {
    const lab = makeLab();
    const loginRes = await loginOnly(lab);
    const cookie = cookieFrom(loginRes.headers);

    const res = await lab.app.inject({
      method: 'POST',
      url: '/auth/otp',
      headers: { cookie },
      payload: { token: '000000' },
    });
    expect(res.statusCode).toBe(403);

    // 같은 쿠키로 올바른 코드를 넣으면 통과한다. OTP 실패가 세션을 죽이지 않는다.
    const retry = await lab.app.inject({
      method: 'POST',
      url: '/auth/otp',
      headers: { cookie },
      payload: { token: otpFor(lab, ACCOUNT.totpSecret) },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('자격증명 거부는 401 + X-Auth-Failed로 구분된다', async () => {
    const lab = makeLab();
    const res = await lab.app.inject({
      method: 'POST',
      url: '/login',
      payload: { id: ACCOUNT.id, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-auth-failed']).toBe('1');
    expect(res.headers['x-session-expired']).toBeUndefined();
  });

  it(`비밀번호를 ${MAX_PASSWORD_FAILURES}번 틀리면 계정이 잠기고 올바른 비밀번호도 거부된다`, async () => {
    const lab = makeLab();
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i += 1) {
      const res = await lab.app.inject({
        method: 'POST',
        url: '/login',
        payload: { id: ACCOUNT.id, password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['x-auth-failed']).toBe('1');
    }

    const locked = await loginOnly(lab);
    expect(locked.statusCode).toBe(401);
    expect(locked.headers['x-auth-failed']).toBe('1');
    expect(locked.json()).toMatchObject({ error: 'LOCKED' });
  });

  it('없는 계정은 잠금 카운터를 올리지 않는다', async () => {
    const lab = makeLab();
    for (let i = 0; i < MAX_PASSWORD_FAILURES + 3; i += 1) {
      const res = await lab.app.inject({
        method: 'POST',
        url: '/login',
        payload: { id: 'nobody', password: 'x' },
      });
      // 잠긴 계정과 없는 계정을 응답으로 구분할 수 없어야 한다.
      expect(res.json()).toMatchObject({ error: 'BAD_CREDENTIALS' });
    }
    // 실재하는 계정은 멀쩡하다.
    expect((await loginOnly(lab)).statusCode).toBe(200);
  });
});

describe('#7 거래내역 조회와 EUC-KR 응답', () => {
  async function fetchPage(lab: Lab, cookie: string, page?: number) {
    const url = page === undefined ? '/transactions' : `/transactions?page=${page}`;
    const res = await lab.app.inject({ method: 'GET', url, headers: { cookie } });
    return { res, html: iconv.decode(res.rawPayload, 'euc-kr') };
  }

  it('응답이 EUC-KR로 인코딩되고 charset이 명시된다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    const { res, html } = await fetchPage(lab, cookie);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=euc-kr');

    // EUC-KR로 읽으면 한글이 나오고, UTF-8로 읽으면 안 나온다. 둘 다 확인해야
    // "UTF-8을 보내 놓고 charset만 euc-kr로 적은" 경우를 걸러낸다.
    expect(html).toContain('거래일시');
    expect(res.rawPayload.toString('utf8')).not.toContain('거래일시');
  });

  it('EUC-KR에 없는 문자를 물음표로 흘려보내지 않는다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    const { html } = await fetchPage(lab, cookie);

    // U+20A9(₩)는 CP949에 없어서 iconv-lite가 예외 없이 '?'(0x3F)로 바꾼다.
    // 바이트만 보면 정상이라 파싱까지 통과하고 금액 표기가 깨진 채 저장된다.
    // 쓰는 것은 U+FFE6(￦)이다.
    expect(html).toContain('￦');
    expect(html).not.toContain('?');
  });

  it('총 건수와 현재 페이지를 함께 싣는다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    const { html } = await fetchPage(lab, cookie, 2);

    expect(html).toContain(`data-total="${ACCOUNT.txCount}"`);
    expect(html).toContain('data-page="2"');
    expect(html).toContain(`data-page-size="${PAGE_SIZE}"`);
  });

  it('첫 페이지와 마지막 페이지의 행 수가 총 건수와 맞는다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    const lastPage = Math.ceil(ACCOUNT.txCount / PAGE_SIZE);

    const first = await fetchPage(lab, cookie, 1);
    expect(countRows(first.html)).toBe(PAGE_SIZE);

    const last = await fetchPage(lab, cookie, lastPage);
    expect(countRows(last.html)).toBe(ACCOUNT.txCount - (lastPage - 1) * PAGE_SIZE);
  });

  it('마지막 페이지 이후는 빈 목록이지만 표 구조는 그대로다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    const beyond = Math.ceil(ACCOUNT.txCount / PAGE_SIZE) + 1;
    const { res, html } = await fetchPage(lab, cookie, beyond);

    // 이게 깨지면 수집하는 쪽에서 "빈 페이지"와 "파싱 실패"가 똑같이 0건으로
    // 보이고, 차단 없는 기준선 성공률이 100%로 나오지 않는다.
    expect(res.statusCode).toBe(200);
    expect(countRows(html)).toBe(0);
    expect(html).toContain('<table id="transactions">');
    expect(html).toContain('<thead>');
    expect(html).toContain(`data-total="${ACCOUNT.txCount}"`);
  });

  it('같은 요청을 두 번 하면 바이트까지 같다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    const a = await lab.app.inject({ method: 'GET', url: '/transactions?page=3', headers: { cookie } });
    const b = await lab.app.inject({ method: 'GET', url: '/transactions?page=3', headers: { cookie } });
    expect(a.rawPayload.equals(b.rawPayload)).toBe(true);
  });

  it('페이지 번호가 잘못되면 1페이지로 바꿔 주지 않고 400을 준다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    for (const page of ['0', '-1', 'abc', '1.5']) {
      const res = await lab.app.inject({
        method: 'GET',
        url: `/transactions?page=${page}`,
        headers: { cookie },
      });
      expect(res.statusCode, `page=${page}`).toBe(400);
    }
  });

  it('잔액이 음수로 내려가지 않고 적요와 입출금 방향이 맞는다', async () => {
    // 해시로 적요와 방향을 따로 고르면 "카드대금 입금" 같은 행이 나온다.
    // 파싱만 보면 멀쩡해서 테스트가 없으면 끝까지 안 걸린다.
    const deposits = new Set(['급여', '이자', '계좌이체', '환급']);

    for (const account of DEMO_ACCOUNTS) {
      const ledger = buildLedger(account.accountNo, account.txCount);
      expect(ledger.length, account.id).toBe(account.txCount);

      for (const tx of ledger) {
        expect(tx.balance, `${account.id} seq ${tx.seq} 잔액`).toBeGreaterThanOrEqual(0);
        // 한 행은 입금이거나 출금이지 둘 다이거나 둘 다 아닐 수 없다.
        expect(tx.deposit > 0, `${account.id} seq ${tx.seq} 방향`).toBe(tx.withdrawal === 0);
        expect(deposits.has(tx.memo), `${account.id} seq ${tx.seq} 적요 ${tx.memo}`).toBe(tx.deposit > 0);
      }
    }
  });

  it('같은 쿼리 키가 두 번 오면 기본값으로 뭉개지 않고 400을 준다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    // Fastify는 중복 키를 배열로 준다. 그걸 빈 문자열로 뭉개면 "안 보낸 것"과
    // 같아져서, 400을 주기로 한 잘못된 값이 조용히 1페이지로 바뀐다.
    for (const query of ['page=1&page=2', 'page=abc&page=1', `account=${OTHER.accountNo}&account=${ACCOUNT.accountNo}`]) {
      const res = await lab.app.inject({
        method: 'GET',
        url: `/transactions?${query}`,
        headers: { cookie },
      });
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('세션 계정이 아닌 계좌는 조회할 수 없다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    const res = await lab.app.inject({
      method: 'GET',
      url: `/transactions?account=${OTHER.accountNo}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('#8 차단 스위치 3종과 관리 API', () => {
  it('기본값은 전부 꺼짐이라 차단 없는 기준선이 된다', async () => {
    const lab = makeLab();
    const res = await lab.app.inject({ method: 'GET', url: '/admin/switches' });
    expect(res.json()).toMatchObject({
      switches: { rateLimit: false, ipBlock: false, sessionExpiry: false },
    });
  });

  it('속도 제한: 켜기 전에는 안 막고 켜면 N회 초과부터 429 + Retry-After', async () => {
    const lab = makeLab();
    const from = { remoteAddress: '10.0.0.1' };

    // 끈 상태에서는 몇 번을 보내도 통과한다(인증이 없으니 401이지만 429는 아니다).
    for (let i = 0; i < 5; i += 1) {
      const res = await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
      expect(res.statusCode).toBe(401);
    }

    await configure(lab, { switches: { rateLimit: true }, thresholds: { windowSec: 10, maxRequests: 2 } });

    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(401);
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(401);

    const blocked = await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // 창이 지나면 다시 통과한다.
    lab.advance(10_001);
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(401);
  });

  it('속도 제한은 인증보다 먼저 판정한다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    await configure(lab, { switches: { rateLimit: true }, thresholds: { windowSec: 10, maxRequests: 1 } });

    expect((await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } })).statusCode).toBe(200);
    // 멀쩡한 세션인데도 막힌다. 차단은 인증 앞단에서 일어난다.
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } })).statusCode).toBe(429);
  });

  it('출발지 차단: 429가 M회 쌓이면 403이 되고 T초 뒤 자동 해제된다', async () => {
    const lab = makeLab();
    const from = { remoteAddress: '10.0.0.2' };
    await configure(lab, {
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 10, maxRequests: 2, blockAfter: 2, blockDurationSec: 30 },
    });

    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode);
    }
    // 2번 통과(401) → 3번째 429(누적 1) → 4번째에 누적 2로 차단(403) → 이후 403
    expect(codes).toEqual([401, 401, 429, 403, 403]);

    lab.advance(30_001);
    const after = await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
    expect(after.statusCode).toBe(401);

    // 해제와 함께 누적도 지워졌다. 안 지우면 해제 직후 429 한 번에 다시 차단된다.
    const next = await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
    expect(next.statusCode).toBe(401);
  });

  it('출발지 차단을 끄면 429가 아무리 쌓여도 403이 되지 않는다', async () => {
    const lab = makeLab();
    const from = { remoteAddress: '10.0.0.7' };
    await configure(lab, {
      switches: { rateLimit: true, ipBlock: false },
      thresholds: { windowSec: 60, maxRequests: 1, blockAfter: 2 },
    });

    // 스위치를 켠 쪽만 검증하면 ipBlock이 늘 켜진 것처럼 동작해도 테스트가 통과한다.
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode);
    }
    expect(codes).toEqual([401, 429, 429, 429, 429]);

    // 같은 조건에서 ipBlock만 켜면 M회 누적에서 403으로 넘어간다.
    await configure(lab, {
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 60, maxRequests: 1, blockAfter: 2 },
    });
    const withBlock: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      withBlock.push((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode);
    }
    expect(withBlock).toEqual([401, 429, 403, 403]);
  });

  it('출발지는 소켓 주소로 판정하고 X-Forwarded-For를 믿지 않는다', async () => {
    const lab = makeLab();
    await configure(lab, { switches: { rateLimit: true }, thresholds: { windowSec: 10, maxRequests: 1 } });

    const first = await lab.app.inject({
      method: 'GET',
      url: '/transactions',
      remoteAddress: '10.0.0.3',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    expect(first.statusCode).toBe(401);

    // 헤더만 바꿔서는 안 풀린다.
    const spoofed = await lab.app.inject({
      method: 'GET',
      url: '/transactions',
      remoteAddress: '10.0.0.3',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });
    expect(spoofed.statusCode).toBe(429);

    // 소켓 주소가 다르면 다른 출발지다. 그래서 출발지 분리는 프록시 경유로만 된다.
    const other = await lab.app.inject({ method: 'GET', url: '/transactions', remoteAddress: '10.0.0.4' });
    expect(other.statusCode).toBe(401);
  });

  it('세션 만료: 켜고 S초를 넘기면 401 + X-Session-Expired', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    await configure(lab, { switches: { sessionExpiry: true }, thresholds: { sessionTtlSec: 60 } });

    lab.advance(59_000);
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } })).statusCode).toBe(200);

    lab.advance(2_000);
    const expired = await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    expect(expired.headers['x-session-expired']).toBe('1');
    // 자격증명 거부와 같은 401이지만 헤더가 다르다. 대응이 정반대이기 때문이다.
    expect(expired.headers['x-auth-failed']).toBeUndefined();
  });

  it('만료된 세션으로 몇 번을 물어도 같은 분류를 돌려준다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);
    await configure(lab, { switches: { sessionExpiry: true }, thresholds: { sessionTtlSec: 60 } });
    lab.advance(61_000);

    // 첫 요청에서 세션을 버리고 잊어버리면 두 번째부터 NO_SESSION이 된다.
    // 워커는 재시도를 하므로 두 번째 요청이 흔하고, 원인이 하나인데 분류가
    // 둘이면 대응이 재인증과 즉시 중단으로 갈린다.
    for (let i = 0; i < 3; i += 1) {
      const res = await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } });
      expect(res.statusCode, `${i + 1}번째`).toBe(401);
      expect(res.headers['x-session-expired'], `${i + 1}번째`).toBe('1');
    }
  });

  it('쿠키 Max-Age를 세션 만료 임계값에 연동하지 않는다', async () => {
    const lab = makeLab();
    await configure(lab, { switches: { sessionExpiry: true }, thresholds: { sessionTtlSec: 1 } });

    const res = await loginOnly(lab);
    const raw = res.headers['set-cookie'];
    const maxAge = Number(/Max-Age=(\d+)/.exec(String(Array.isArray(raw) ? raw[0] : raw))?.[1]);

    // 같은 값으로 두면 규격을 지키는 클라이언트가 딱 그 시점에 쿠키를 버린다.
    // 그러면 서버에 쿠키가 안 와서 SESSION_EXPIRED 대신 NO_SESSION이 나가고,
    // 재인증하면 되는 상황과 인증이 아예 없는 상황을 구분할 수 없게 된다.
    // 실제로 curl 쿠키 자로 확인했다(docs/TROUBLESHOOTING.md).
    expect(maxAge).toBeGreaterThan(1);
    expect(maxAge).toBe(SESSION_COOKIE_MAX_AGE_SEC);
  });

  it('폐기된 세션과 만료된 세션을 다르게 답한다', async () => {
    const lab = makeLab();
    const first = await loginOnly(lab);
    const dropped = cookieFrom(first.headers);
    // 다시 로그인하면 앞 식별자는 폐기된다. 만료가 아니므로 헤더가 붙지 않는다.
    await loginOnly(lab, { headers: { cookie: dropped } });

    const res = await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie: dropped } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-session-expired']).toBeUndefined();
  });

  it('세션 만료 스위치가 꺼져 있으면 아무리 지나도 세션이 살아 있다', async () => {
    const lab = makeLab();
    const cookie = await fullSession(lab);

    lab.advance(24 * 60 * 60 * 1000);
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', headers: { cookie } })).statusCode).toBe(200);
  });

  it('관리 API와 헬스체크는 차단을 지나간다', async () => {
    const lab = makeLab();
    const from = { remoteAddress: '10.0.0.5' };
    await configure(lab, {
      switches: { rateLimit: true, ipBlock: true },
      thresholds: { windowSec: 10, maxRequests: 1, blockAfter: 1 },
    });

    await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(403);

    // 차단된 출발지에서도 스위치를 끌 수 있어야 한다. 아니면 측정이 한 번으로 끝난다.
    expect((await lab.app.inject({ method: 'GET', url: '/health', ...from })).statusCode).toBe(200);
    expect((await lab.app.inject({ method: 'GET', url: '/admin/switches', ...from })).statusCode).toBe(200);

    const off = await lab.app.inject({
      method: 'POST',
      url: '/admin/switches',
      payload: { switches: { rateLimit: false, ipBlock: false } },
      ...from,
    });
    expect(off.statusCode).toBe(200);
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(401);
  });

  it('스위치를 바꾸면 누적 카운터를 버린다', async () => {
    const lab = makeLab();
    const from = { remoteAddress: '10.0.0.6' };
    await configure(lab, { switches: { rateLimit: true }, thresholds: { windowSec: 60, maxRequests: 1 } });

    await lab.app.inject({ method: 'GET', url: '/transactions', ...from });
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(429);

    // 같은 설정을 다시 넣어도 카운터는 초기화된다. 측정은 조건을 세우고 시작하므로
    // 조건을 넣는 순간이 곧 시작점이다.
    await configure(lab, { switches: { rateLimit: true }, thresholds: { windowSec: 60, maxRequests: 1 } });
    expect((await lab.app.inject({ method: 'GET', url: '/transactions', ...from })).statusCode).toBe(401);
  });

  it('reset은 계정 잠금과 세션까지 되돌린다', async () => {
    const lab = makeLab();
    for (let i = 0; i < MAX_PASSWORD_FAILURES; i += 1) {
      await lab.app.inject({ method: 'POST', url: '/login', payload: { id: ACCOUNT.id, password: 'wrong' } });
    }
    expect((await loginOnly(lab)).statusCode).toBe(401);

    expect((await lab.app.inject({ method: 'POST', url: '/admin/reset' })).statusCode).toBe(200);
    expect((await loginOnly(lab)).statusCode).toBe(200);
  });

  it('임계값과 스위치 이름을 검증한다', async () => {
    const lab = makeLab();
    const bad: unknown[] = [
      { thresholds: { windowSec: 0 } },
      { thresholds: { maxRequests: -1 } },
      { thresholds: { sessionTtlSec: 1.5 } },
      { thresholds: { windowSecs: 10 } },
      { switches: { rateLimit: 'on' } },
      { switches: { rateLimits: true } },
    ];
    for (const payload of bad) {
      const res = await lab.app.inject({ method: 'POST', url: '/admin/switches', payload: payload as object });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    // 거절된 값이 실제로 반영되지 않았는지도 확인한다.
    const state = await lab.app.inject({ method: 'GET', url: '/admin/switches' });
    expect(state.json()).toMatchObject({ thresholds: { windowSec: 10, maxRequests: 5 } });
  });

  it('임계값은 관리 API로 읽을 수 있어 측정 조건으로 기록된다', async () => {
    const lab = makeLab();
    await configure(lab, {
      switches: { rateLimit: true, ipBlock: true, sessionExpiry: true },
      thresholds: { windowSec: 5, maxRequests: 3, blockAfter: 2, blockDurationSec: 20, sessionTtlSec: 90 },
    });

    const res = await lab.app.inject({ method: 'GET', url: '/admin/switches' });
    expect(res.json()).toEqual({
      switches: { rateLimit: true, ipBlock: true, sessionExpiry: true },
      thresholds: { windowSec: 5, maxRequests: 3, blockAfter: 2, blockDurationSec: 20, sessionTtlSec: 90 },
    });
  });
});

function countRows(html: string): number {
  return (html.match(/<tr data-seq=/g) ?? []).length;
}
