/**
 * 출발지 풀 테스트. 고르는 규칙은 가짜 시계로, 전송이 출발지마다 제 프록시로만 나가는지는 실제 소켓으로 본다.
 *
 * 실제 프록시 두 개를 이 프로세스에 띄운다. 둘 다 127.0.0.1이라 대상 서버가 보는 주소로는 가를 수 없으므로,
 * 프록시가 자기 이름을 헤더에 실어 넘기고 대상 서버가 그것을 기록한다. 대상 서버가 소켓 주소로 가르는 것은
 * compose 실측이 본다(`docs/evidence/d3-origin.md`).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { OriginPool, createProxyOrigins, parseProxyList, resolveTargetOrigin } from './origins.js';
import type { Origin } from './origins.js';

const noop: Origin['transport'] = async () => ({ network: { message: 'unused' } });

function pool(names: string[], now: { t: number }) {
  const origins = names.map((name) => ({ name, transport: noop }));
  return { origins, pool: new OriginPool(origins, () => now.t) };
}

describe('출발지 풀', () => {
  it('막히지 않은 출발지 중 목록 순서대로 첫 번째를 고른다', () => {
    const now = { t: 1_000 };
    const { origins, pool: p } = pool(['a', 'b', 'c'], now);
    expect(p.pick()).toBe(origins[0]);
    p.block(origins[0] as Origin, 5_000);
    expect(p.pick()).toBe(origins[1]);
    p.block(origins[1] as Origin, 3_000);
    expect(p.pick()).toBe(origins[2]);
  });

  it('막힌 출발지는 해제 시각까지 후보에서 빠지고, 해제 시각이 되면 다시 첫 번째로 돌아온다', () => {
    const now = { t: 1_000 };
    const { origins, pool: p } = pool(['a', 'b'], now);
    p.block(origins[0] as Origin, 2_000);
    now.t = 1_999;
    expect(p.available()).toBe(origins[1]);
    now.t = 2_000;
    expect(p.available()).toBe(origins[0]);
  });

  it('모두 막히면 available은 없고, pick과 earliestRelease는 가장 빨리 풀리는 출발지다', () => {
    const now = { t: 1_000 };
    const { origins, pool: p } = pool(['a', 'b'], now);
    p.block(origins[0] as Origin, 9_000);
    p.block(origins[1] as Origin, 4_000);
    expect(p.available()).toBeUndefined();
    expect(p.pick()).toBe(origins[1]);
    expect(p.earliestRelease()).toBe(4_000);
    expect(p.states()).toEqual([
      { name: 'a', blockedUntil: 9_000, ok: 0, failed: 0 },
      { name: 'b', blockedUntil: 4_000, ok: 0, failed: 0 },
    ]);
  });

  it('더 짧은 차단이 와도 이미 걸린 해제 시각을 줄이지 않고, 실제로 남은 해제 시각을 돌려준다', () => {
    const now = { t: 1_000 };
    const { origins, pool: p } = pool(['a', 'b'], now);
    expect(p.block(origins[0] as Origin, 9_000)).toBe(9_000);
    expect(p.block(origins[0] as Origin, 2_000)).toBe(9_000);
    now.t = 5_000;
    expect(p.available()).toBe(origins[1]);
  });

  it('성공·실패 수를 출발지마다 세지만 고르는 데 쓰지 않는다', () => {
    const now = { t: 1_000 };
    const { origins, pool: p } = pool(['a', 'b'], now);
    const [a, b] = origins as [Origin, Origin];
    expect(p.record(a, false)).toEqual({ ok: 0, failed: 1 });
    expect(p.record(a, false)).toEqual({ ok: 0, failed: 2 });
    expect(p.record(b, true)).toEqual({ ok: 1, failed: 0 });
    // 실패가 많아도 막히지 않았으면 첫 번째다.
    expect(p.pick()).toBe(a);
  });

  it('빈 목록, 겹치는 이름, 풀에 없는 출발지는 던진다', () => {
    const now = { t: 0 };
    expect(() => new OriginPool([], () => now.t)).toThrow(RangeError);
    expect(() => pool(['a', 'a'], now)).toThrow(RangeError);
    const { pool: p } = pool(['a'], now);
    expect(() => p.block({ name: 'x', transport: noop }, 1)).toThrow(RangeError);
  });
});

describe('WORKER_PROXIES 읽기', () => {
  it('없거나 비면 빈 목록(프록시 없음), 쉼표로 나누고 앞뒤 공백을 버린다', () => {
    expect(parseProxyList(undefined)).toEqual([]);
    expect(parseProxyList('  ')).toEqual([]);
    expect(parseProxyList('http://127.0.0.1:3128, http://127.0.0.1:3129')).toEqual(['http://127.0.0.1:3128', 'http://127.0.0.1:3129']);
  });

  it('URL이 아니거나, http(s)가 아니거나, 자격증명이 실렸거나, 겹치면 던진다', () => {
    expect(() => parseProxyList('127.0.0.1:3128')).toThrow(RangeError);
    expect(() => parseProxyList('http://127.0.0.1:3128,')).toThrow(RangeError);
    expect(() => parseProxyList('socks5://127.0.0.1:1080')).toThrow(RangeError);
    expect(() => parseProxyList('http://u:p@127.0.0.1:3128')).toThrow(RangeError);
    expect(() => parseProxyList('http://127.0.0.1:3128,http://127.0.0.1:3128')).toThrow(RangeError);
  });

  it('오류 메시지에 원문의 어느 조각도 싣지 않고 몇 번째 항목인지만 싣는다(자격증명이 로그에 남지 않게)', () => {
    const cases: [string, string[]][] = [
      ['http://127.0.0.1:3128,socks5://user:s3cret@host.example:1080', ['user', 's3cret', 'host.example', 'socks5']],
      ['http://127.0.0.1:3128,TOKEN0123:@proxy.example:3128', ['TOKEN0123', 'proxy.example']],
      ['http://127.0.0.1:3128,user:s3cret@proxy.example:3128', ['user', 's3cret', 'proxy.example']],
      ['http://127.0.0.1:3128,http://user:s3cret@proxy.example:3128', ['user', 's3cret', 'proxy.example']],
      ['http://127.0.0.1:3128,not a url s3cret', ['s3cret', 'not a url']],
    ];
    for (const [raw, fragments] of cases) {
      let message = '';
      try {
        parseProxyList(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('2번째');
      for (const fragment of fragments) expect(message).not.toContain(fragment);
    }
    let dup = '';
    try {
      parseProxyList('http://127.0.0.1:3128,http://127.0.0.1:3128');
    } catch (error) {
      dup = (error as Error).message;
    }
    expect(dup).toContain('1번째');
    expect(dup).not.toContain('127.0.0.1');
  });
});

describe('TARGET_ORIGIN 읽기', () => {
  it('프록시가 없으면 비어도 기본값(호스트의 대상 서버)이다', () => {
    expect(resolveTargetOrigin(undefined, [])).toBe('http://127.0.0.1:8080');
    expect(resolveTargetOrigin('  ', [])).toBe('http://127.0.0.1:8080');
    expect(resolveTargetOrigin('http://127.0.0.1:8081', [])).toBe('http://127.0.0.1:8081');
  });

  it('프록시가 있는데 TARGET_ORIGIN이 없으면 던진다. 기본값은 프록시 안에서 프록시 자신이다', () => {
    expect(() => resolveTargetOrigin(undefined, ['http://127.0.0.1:3128'])).toThrow(RangeError);
    expect(() => resolveTargetOrigin(' ', ['http://127.0.0.1:3128'])).toThrow(RangeError);
    expect(resolveTargetOrigin('http://target:8080', ['http://127.0.0.1:3128'])).toBe('http://target:8080');
  });
});

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 절대 경로 요청을 받아 대상으로 넘기는 최소 프록시. 넘길 때 자기 이름을 `x-via`에 싣는다. */
async function forwardProxy(name: string): Promise<string> {
  return listen(
    http.createServer((req, res) => {
      const url = new URL(req.url ?? '');
      const upstream = http.request(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, 'x-via': name } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    }),
  );
}

describe('프록시 출발지의 전송', () => {
  it('출발지마다 제 프록시로만 나가고, 바꾸면 바로 다음 요청부터 새 프록시로 나간다', async () => {
    const seen: string[] = [];
    const target = await listen(
      http.createServer((req, res) => {
        seen.push(`${String(req.headers['x-via'] ?? 'direct')} ${req.url ?? ''}`);
        res.end('ok');
      }),
    );
    const { origins, close } = createProxyOrigins([await forwardProxy('A'), await forwardProxy('B')], target);
    try {
      const [a, b] = origins as [Origin, Origin];
      for (const [origin, path] of [[a, '/1'], [a, '/2'], [b, '/3'], [b, '/4'], [a, '/5']] as const) {
        expect(await origin.transport({ method: 'GET', path })).toMatchObject({ status: 200 });
      }
    } finally {
      await close();
    }
    expect(seen).toEqual(['A /1', 'A /2', 'B /3', 'B /4', 'A /5']);
  });
});
