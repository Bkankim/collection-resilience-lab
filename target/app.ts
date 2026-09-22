/**
 * 수집 대상 서버.
 *
 * 차단 판정은 전부 `onRequest` 훅 한 자리에 모았다. 라우트마다 흩어 두면 "이
 * 경로는 속도 제한을 받나"를 확인하려고 라우트를 전부 읽어야 하고, 새 경로를
 * 추가할 때 조용히 빠뜨린다.
 *
 * 관리 API와 헬스체크는 그 훅을 지난다. 차단을 켠 상태에서 관리 API까지 막히면
 * 차단을 끌 방법이 없어지고, 헬스체크가 속도 제한 창을 먹으면 요청을 하나도
 * 안 보냈는데 429가 난다.
 */

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AccountStore } from './accounts.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_SEC, SessionStore } from './sessions.js';
import type { Session } from './sessions.js';
import { BlockSwitches, parseSwitchPatch, parseThresholdPatch } from './switches.js';
import {
  TRANSACTIONS_CONTENT_TYPE,
  encodeEucKr,
  renderTransactionsHtml,
  selectPage,
} from './transactions.js';

export type BuildAppOptions = {
  /** 테스트가 시각을 소유할 수 있게 주입한다. 기본은 실제 시계. */
  clock?: Clock;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const clock = options.clock ?? systemClock;
  const switches = new BlockSwitches(clock);
  const sessions = new SessionStore(clock);
  const accounts = new AccountStore(clock);

  const app = Fastify({
    logger: options.logger ?? false,
    // 기본값이지만 명시한다. 켜면 `request.ip`가 X-Forwarded-For를 읽게 되고,
    // 그 순간 출발지 차단을 헤더 한 줄로 우회할 수 있다.
    trustProxy: false,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (isExempt(request.url)) return;

    const origin = originOf(request);
    const verdict = switches.admit(origin);
    if (verdict.kind === 'PASS') return;

    reply.header('Retry-After', String(verdict.retryAfterSec));
    reply
      .code(verdict.kind === 'RATE_LIMITED' ? 429 : 403)
      .send({ error: verdict.kind, origin, retryAfterSec: verdict.retryAfterSec });
    // async 훅에서 응답을 보냈으면 reply를 돌려줘야 Fastify가 라우트로
    // 넘어가지 않는다. 안 돌려주면 핸들러가 한 번 더 돈다.
    return reply;
  });

  app.get('/health', async () => ({ ok: true }));

  app.post('/login', async (request, reply) => {
    const body = asRecord(request.body);
    const id = asString(body.id);
    const password = asString(body.password);

    // 요청에 딸려온 세션은 결과와 상관없이 먼저 버린다. 공격자가 심어 둔
    // 식별자를 로그인 성공으로 승급시키지 않기 위한 것이 session fixation 방어의
    // 핵심이고, 방어는 "새로 발급"과 "옛것 폐기" 두 쪽이 다 있어야 성립한다.
    const carried = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (carried !== undefined) sessions.drop(carried);

    const outcome = accounts.login(id, password);
    if (!outcome.ok) {
      // 세션 만료와 같은 401이지만 헤더로 갈린다. 수집하는 쪽의 대응이
      // 정반대다(재인증 vs 즉시 중단). 여기서 안 나누면 워커가 잠긴 계정에
      // 재인증을 계속 시도한다.
      return reply.code(401).header('X-Auth-Failed', '1').send({ error: outcome.reason });
    }

    const session = sessions.issue(outcome.account.id, 'PRIMARY');
    return reply
      .code(200)
      .header('Set-Cookie', sessionCookie(session.id))
      .send({ next: 'otp' });
  });

  app.post('/auth/otp', async (request, reply) => {
    const check = requireSession(request);
    if (!check.ok) return sendSessionFailure(reply, check);

    const account = accounts.get(check.session.accountId);
    if (account === undefined) {
      sessions.drop(check.session.id);
      return reply.code(401).send({ error: 'NO_SESSION' });
    }

    const token = asString(asRecord(request.body).token);
    if (!accounts.verifyOtp(account, token)) {
      // 아직 2차를 못 넘겼으므로 "1차만 통과" 상태 그대로다. 401이 아니라 403인
      // 이유가 이것이다. 401을 주면 수집하는 쪽이 1차부터 다시 한다.
      return reply.code(403).send({ error: 'OTP_REJECTED' });
    }

    const promoted = sessions.promote(check.session, 'FULL');
    return reply
      .code(200)
      .header('Set-Cookie', sessionCookie(promoted.id))
      .send({ level: 'FULL' });
  });

  app.get('/transactions', async (request, reply) => {
    const check = requireSession(request);
    if (!check.ok) return sendSessionFailure(reply, check);
    if (check.session.level !== 'FULL') {
      return reply.code(403).send({ error: 'OTP_REQUIRED' });
    }

    const account = accounts.get(check.session.accountId);
    if (account === undefined) {
      sessions.drop(check.session.id);
      return reply.code(401).send({ error: 'NO_SESSION' });
    }

    const query = asRecord(request.query);
    const requested = asString(query.account);
    if (requested !== '' && requested !== account.accountNo) {
      return reply.code(403).send({ error: 'ACCOUNT_MISMATCH' });
    }

    const rawPage = asString(query.page);
    const page = rawPage === '' ? 1 : Number(rawPage);
    if (!/^\d*$/.test(rawPage) || !Number.isInteger(page) || page < 1) {
      // 잘못된 페이지를 1페이지로 바꿔 주지 않는다. 그러면 수집하는 쪽의 버그가
      // 정상 응답에 묻혀서 같은 페이지를 반복해 긁는다.
      return reply.code(400).send({ error: 'BAD_PAGE' });
    }

    const selected = selectPage(account.accountNo, account.txCount, page);
    return reply
      .code(200)
      .type(TRANSACTIONS_CONTENT_TYPE)
      .send(encodeEucKr(renderTransactionsHtml(selected)));
  });

  app.get('/admin/switches', async () => ({
    switches: switches.switches,
    thresholds: switches.thresholds,
  }));

  app.post('/admin/switches', async (request, reply) => {
    const body = asRecord(request.body);

    const parsedSwitches = parseSwitchPatch(body.switches);
    if (!parsedSwitches.ok) return reply.code(400).send({ error: parsedSwitches.message });

    const parsedThresholds = parseThresholdPatch(body.thresholds);
    if (!parsedThresholds.ok) return reply.code(400).send({ error: parsedThresholds.message });

    switches.configure({ switches: parsedSwitches.patch, thresholds: parsedThresholds.patch });
    return reply.send({ switches: switches.switches, thresholds: switches.thresholds });
  });

  /**
   * 측정을 다시 시작하기 위한 초기화.
   *
   * 이슈 #8의 완료 기준에는 없지만 없으면 측정이 성립하지 않는다. 계정 잠금과
   * 세션은 스위치를 바꿔도 남으므로, 같은 설정으로 두 번째 측정을 돌리면 첫
   * 번째에서 잠긴 계정 때문에 결과가 달라진다.
   */
  app.post('/admin/reset', async () => {
    switches.resetCounters();
    sessions.clear();
    accounts.reset();
    return { ok: true };
  });

  type SessionCheck =
    | { ok: true; session: Session }
    | { ok: false; reason: 'NO_SESSION' | 'SESSION_EXPIRED' };

  function requireSession(request: FastifyRequest): SessionCheck {
    const id = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (id === undefined) return { ok: false, reason: 'NO_SESSION' };

    const session = sessions.get(id);
    if (session === undefined) {
      // 만료로 죽은 식별자는 계속 만료라고 답한다. 워커는 재시도를 하므로 같은
      // 쿠키로 두 번 오는 일이 흔한데, 그때 분류가 바뀌면 대응도 갈린다.
      return { ok: false, reason: sessions.wasExpired(id) ? 'SESSION_EXPIRED' : 'NO_SESSION' };
    }

    if (switches.isSessionExpired(session.issuedAt)) {
      sessions.expire(session.id);
      return { ok: false, reason: 'SESSION_EXPIRED' };
    }
    return { ok: true, session };
  }

  function sendSessionFailure(reply: FastifyReply, check: { reason: 'NO_SESSION' | 'SESSION_EXPIRED' }): FastifyReply {
    if (check.reason === 'SESSION_EXPIRED') {
      return reply.code(401).header('X-Session-Expired', '1').send({ error: 'SESSION_EXPIRED' });
    }
    return reply.code(401).send({ error: 'NO_SESSION' });
  }

  return app;
}

/** 차단 훅을 지나가는 경로. */
function isExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return path === '/health' || path === '/admin' || path.startsWith('/admin/');
}

function originOf(request: FastifyRequest): string {
  // `X-Forwarded-For`를 읽지 않는다. 보내는 쪽이 자유롭게 쓰는 헤더라, 그걸
  // 믿으면 출발지 차단이 헤더 한 줄로 풀린다. 소켓 주소만 본다. 따라서 출발지를
  // 실제로 나누려면 프록시 컨테이너를 거쳐야 하고, 호스트에서 포트로 바로
  // 들어오면 전부 같은 출발지로 보인다.
  const raw = request.socket.remoteAddress ?? 'unknown';
  const mapped = '::ffff:';
  return raw.startsWith(mapped) ? raw.slice(mapped.length) : raw;
}

/**
 * 쿠키 헤더에서 값 하나를 꺼낸다.
 *
 * `@fastify/cookie`를 붙이지 않은 이유는 쓰는 쿠키가 하나뿐이어서다. 의존성
 * 하나가 줄면 Node 22/24/26 세 런타임에서 확인할 것도 하나 줄어든다.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * `Max-Age`는 쿠키를 들고 있는 쪽에 주는 힌트일 뿐이고, 만료 판정은 서버가
 * 세션 발급 시각으로 한다. 그래서 세션 만료 임계값(S)이 아니라 고정 상수를
 * 쓴다. 이유는 `sessions.ts`의 상수 주석에 적었다.
 */
function sessionCookie(id: string): string {
  // `Secure`는 붙이지 않는다. 이 실험실은 평문 HTTP로 뜨고, 붙이면 브라우저가
  // 쿠키를 버려서 동작하지 않는 방어가 된다. README 한계에 적었다.
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
