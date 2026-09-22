/**
 * 쿠키 파서와 저장소의 경계 케이스. 이슈 #9 완료 기준은 5건 이상이다.
 *
 * 시각은 테스트가 소유한다. `Max-Age` 만료를 실제로 기다리지 않고 시계를 밀어 본다.
 */

import { describe, expect, it } from 'vitest';

import { CookieJar, defaultPath, parseSetCookie, pathMatches } from './cookies.js';

const NOW = Date.UTC(2026, 8, 23, 3, 0, 0);

function makeJar() {
  let now = NOW;
  const jar = new CookieJar(() => now);
  return { jar, advance: (ms: number) => (now += ms) };
}

describe('Set-Cookie 파싱', () => {
  it('대상 서버가 내는 줄을 그대로 읽는다', () => {
    const cookie = parseSetCookie('lab_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800', '/login', NOW);
    expect(cookie).toEqual({ name: 'lab_session', value: 'abc', path: '/', expiresAt: NOW + 1_800_000, httpOnly: true });
  });

  it('값에 =가 들어 있으면 첫 =에서만 자른다', () => {
    // base64 패딩이 붙은 식별자가 흔하다. 마지막 =에서 자르면 값이 잘린다.
    expect(parseSetCookie('token=YWJj==; Path=/', '/', NOW)).toMatchObject({ name: 'token', value: 'YWJj==' });
  });

  it('속성 이름은 대소문자를 가리지 않는다', () => {
    const cookie = parseSetCookie('a=1; pAtH=/tx; mAX-agE=10; HTTPONLY', '/', NOW);
    expect(cookie).toMatchObject({ path: '/tx', expiresAt: NOW + 10_000, httpOnly: true });
  });

  it('Max-Age가 숫자가 아니면 속성만 버리고 쿠키는 세션 쿠키로 받는다', () => {
    // 0으로 읽으면 멀쩡한 세션 쿠키를 지운다.
    expect(parseSetCookie('a=1; Max-Age=abc', '/', NOW)).toMatchObject({ expiresAt: undefined });
    expect(parseSetCookie('a=1; Max-Age=1.5', '/', NOW)).toMatchObject({ expiresAt: undefined });
  });

  it('Expires는 해석하지 않는다(이슈 #9 코멘트의 범위 결정)', () => {
    // 과거 날짜라도 지우지 않는다. 대상 서버는 Max-Age만 낸다.
    expect(parseSetCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', '/', NOW)).toMatchObject({ expiresAt: undefined });
  });

  it('=가 없거나 이름이 비면 줄 전체를 버린다', () => {
    expect(parseSetCookie('novalue; Path=/', '/', NOW)).toBeUndefined();
    expect(parseSetCookie('=1; Path=/', '/', NOW)).toBeUndefined();
  });

  it('Path가 없거나 /로 시작하지 않으면 요청 경로에서 기본 경로를 만든다', () => {
    expect(parseSetCookie('a=1', '/auth/otp', NOW)).toMatchObject({ path: '/auth' });
    expect(parseSetCookie('a=1; Path=auth', '/auth/otp', NOW)).toMatchObject({ path: '/auth' });
    expect(defaultPath('/login')).toBe('/');
    expect(defaultPath('/transactions?page=2')).toBe('/');
    expect(defaultPath('/a/b/c?x=/y')).toBe('/a/b');
  });

  it('path-match는 단순 접두사가 아니다', () => {
    expect(pathMatches('/tx', '/tx')).toBe(true);
    expect(pathMatches('/tx/1', '/tx')).toBe(true);
    expect(pathMatches('/tx/1', '/tx/')).toBe(true);
    expect(pathMatches('/txn', '/tx')).toBe(false);
    expect(pathMatches('/tx?page=1', '/tx')).toBe(true);
    expect(pathMatches('/anything', '/')).toBe(true);
  });
});

describe('쿠키 저장소', () => {
  it('같은 이름과 경로는 덮어쓴다. 승급 때 옛 식별자가 나란히 남지 않는다', () => {
    const { jar } = makeJar();
    jar.store('lab_session=primary; Path=/; Max-Age=1800', '/login');
    jar.store('lab_session=full; Path=/; Max-Age=1800', '/auth/otp');
    expect(jar.headerFor('/transactions')).toBe('lab_session=full');
    expect(jar.list()).toHaveLength(1);
  });

  it('이름이 같아도 경로가 다르면 따로 두고, 긴 경로를 먼저 보낸다', () => {
    const { jar } = makeJar();
    jar.store(['a=root; Path=/', 'a=deep; Path=/tx'], '/');
    expect(jar.headerFor('/tx/1')).toBe('a=deep; a=root');
    expect(jar.headerFor('/other')).toBe('a=root');
  });

  it('Max-Age=0이나 음수는 저장된 쿠키를 지운다', () => {
    const { jar } = makeJar();
    jar.store(['a=1; Path=/', 'b=2; Path=/'], '/');
    jar.store(['a=; Path=/; Max-Age=0', 'b=; Path=/; Max-Age=-1'], '/');
    expect(jar.headerFor('/')).toBeUndefined();
  });

  it('Max-Age가 지나면 보내지 않는다', () => {
    const { jar, advance } = makeJar();
    jar.store('a=1; Path=/; Max-Age=10', '/');
    advance(9_999);
    expect(jar.headerFor('/')).toBe('a=1');
    advance(1);
    expect(jar.headerFor('/')).toBeUndefined();
  });

  it('배열과 문자열 하나를 모두 받고, 없으면 아무것도 안 한다', () => {
    const { jar } = makeJar();
    jar.store(undefined, '/');
    jar.store('a=1; Path=/', '/');
    jar.store(['b=2; Path=/'], '/');
    expect(jar.headerFor('/')).toBe('a=1; b=2');
  });
});
