/**
 * `Set-Cookie`를 직접 읽고 들고 있는 쿠키 저장소.
 *
 * 쿠키 자동 관리 라이브러리에 맡기지 않는 이유: 세션이 왜 끊겼는지 판단하려면 무엇이
 * 오갔는지 알아야 한다. D1에서 세션 만료 헤더가 안 오던 결함(TROUBLESHOOTING 2번)도
 * 쿠키 자가 `Max-Age`를 지켜 쿠키를 스스로 버린 데서 나왔다. 쿠키를 버리는 판단이
 * 우리 코드 안에 있어야 그런 일이 생겼을 때 이유를 추적할 수 있다.
 *
 * 규칙은 RFC 6265 5.2~5.4를 따르되, 이슈 #9 코멘트(2026-09-22)의 범위 결정대로
 * `Expires`는 해석하지 않는다. 대상 서버는 `Max-Age`만 내고, 안 오는 속성을 해석하는
 * 코드는 검증할 방법이 없다. `Expires`만 있는 쿠키는 프로세스 수명 동안 유지되는
 * 세션 쿠키로 다룬다. 영속화는 하지 않는다(이슈의 "안 하는 것").
 *
 * `Domain`도 보지 않는다. 저장소 하나가 대상 서버 하나에만 붙는다고 가정한다.
 * 출발지를 바꿔도(#14) 대상 서버의 주소는 그대로이므로 이 가정은 유지된다.
 */

import type { Clock } from './clock.js';

export type Cookie = {
  name: string;
  value: string;
  path: string;
  /** 만료 시각(epoch ms). undefined면 세션 쿠키다. */
  expiresAt: number | undefined;
  /**
   * 기록만 한다. HttpOnly는 브라우저의 스크립트에게서 쿠키를 숨기는 표시라, 스크립트가
   * 없는 수집기에서는 동작이 달라지지 않는다. 서버가 붙였는지는 진단에 쓸 수 있다.
   */
  httpOnly: boolean;
};

/**
 * `Set-Cookie` 한 줄을 읽는다. 무시해야 하는 줄이면 undefined다.
 *
 * `requestPath`는 이 응답을 받은 요청의 경로다. `Path`가 없거나 `/`로 시작하지 않으면
 * 기본 경로를 여기서 만든다(RFC 6265 5.1.4).
 */
export function parseSetCookie(line: string, requestPath: string, now: number): Cookie | undefined {
  const [pair = '', ...attrs] = line.split(';');
  // 값에 `=`가 들어갈 수 있다(base64 패딩 등). 첫 `=`에서만 자른다.
  const eq = pair.indexOf('=');
  if (eq === -1) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name === '') return undefined;

  let path: string | undefined;
  let expiresAt: number | undefined;
  let httpOnly = false;

  for (const attr of attrs) {
    const at = attr.indexOf('=');
    // 속성 이름은 대소문자를 가리지 않는다. `max-age`와 `Max-Age`는 같은 속성이다.
    const key = (at === -1 ? attr : attr.slice(0, at)).trim().toLowerCase();
    const raw = at === -1 ? '' : attr.slice(at + 1).trim();

    if (key === 'path') {
      path = raw.startsWith('/') ? raw : undefined;
    } else if (key === 'max-age') {
      // 숫자가 아니면 속성만 버리고 쿠키는 받는다. `Max-Age=abc`를 0으로 읽으면
      // 멀쩡한 세션 쿠키를 지우게 된다.
      if (!/^-?\d+$/.test(raw)) continue;
      const seconds = Number(raw);
      // 0 이하면 "지금 지워라"다. 서버가 쿠키를 지우는 표준 방법이다.
      expiresAt = seconds <= 0 ? Number.NEGATIVE_INFINITY : now + seconds * 1000;
    } else if (key === 'httponly') {
      httpOnly = true;
    }
    // Expires·Domain·Secure·SameSite는 위 머리 주석의 이유로 읽지 않는다.
  }

  return { name, value, path: path ?? defaultPath(requestPath), expiresAt, httpOnly };
}

/** RFC 6265 5.1.4. 요청 경로에서 마지막 `/` 앞까지. */
export function defaultPath(requestPath: string): string {
  const path = requestPath.split('?')[0] ?? '';
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}

/**
 * RFC 6265 5.1.4 path-match. 단순 접두사 비교가 아니다. `/tx`는 `/tx/1`에 맞지만
 * `/txn`에는 맞지 않는다. 접두사로만 보면 다른 경로의 쿠키가 섞여 나간다.
 */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  const path = requestPath.split('?')[0] ?? '';
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path.charAt(cookiePath.length) === '/';
}

export class CookieJar {
  readonly #clock: Clock;
  /** 키는 `name` + `path`. 같은 이름이라도 경로가 다르면 다른 쿠키다(RFC 6265 5.3 11단계). */
  readonly #cookies = new Map<string, Cookie>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * 응답의 `Set-Cookie`를 모두 반영한다. 상태 코드와 상관없이 부른다. 3xx나 4xx에
   * 실린 쿠키를 성공 응답이 아니라는 이유로 버리면 서버가 준 세션을 놓친다.
   */
  store(setCookie: string | string[] | undefined, requestPath: string): void {
    if (setCookie === undefined) return;
    const now = this.#clock();
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const cookie = parseSetCookie(line, requestPath, now);
      if (cookie === undefined) continue;
      const key = `${cookie.name}\u0000${cookie.path}`;
      // 이미 만료된 쿠키는 저장하지 않고, 같은 키가 있으면 지운다. 덮어쓰기와
      // 삭제가 같은 경로라서 승급 때 옛 식별자가 새 식별자와 나란히 남지 않는다.
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.#cookies.delete(key);
        continue;
      }
      this.#cookies.set(key, cookie);
    }
  }

  /**
   * 이 경로로 보낼 `Cookie` 헤더. 보낼 것이 없으면 undefined.
   *
   * 긴 경로를 먼저 싣는다(RFC 6265 5.4). 같은 이름이 두 경로에 있으면 서버는 보통
   * 첫 값을 읽으므로, 더 구체적인 쿠키가 앞에 와야 한다.
   */
  headerFor(requestPath: string): string | undefined {
    const now = this.#clock();
    const matched: Cookie[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.#cookies.delete(key);
        continue;
      }
      if (pathMatches(requestPath, cookie.path)) matched.push(cookie);
    }
    if (matched.length === 0) return undefined;
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** 진단용. 만료된 것은 뺀다. */
  list(): Cookie[] {
    const now = this.#clock();
    return [...this.#cookies.values()].filter((c) => c.expiresAt === undefined || c.expiresAt > now);
  }

  clear(): void {
    this.#cookies.clear();
  }
}
