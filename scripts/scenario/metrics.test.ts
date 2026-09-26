import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { failureWindow, formatRecovery, markdownTable, recoveryOf, secondsForStreak, throughputOf } from './metrics.js';
import type { Terminal } from './metrics.js';
import { startRelay } from './relay.js';
import type { RelayRecord } from './relay.js';

const done = (at: number, ok = true): Terminal => ({ at, jobId: `j${at}`, ok });

describe('회복 시간', () => {
  it('실패 응답이 없으면 해당 없음이다', () => {
    expect(recoveryOf([], [done(1), done(2)])).toEqual({ kind: 'none' });
    expect(formatRecovery({ kind: 'none' })).toContain('해당 없음');
  });

  it('첫 실패 뒤 끝난 순서로 10건이 연달아 완료된 시각까지 잰다', () => {
    const terminals = Array.from({ length: 12 }, (_, i) => done(1000 + i * 100));
    // 첫 실패는 가장 이른 실패 응답이다. 그 앞에 끝난 작업(1000, 1100)은 세지 않는다.
    const r = recoveryOf([1150, 1500], terminals);
    expect(r).toEqual({ kind: 'recovered', firstFailureAt: 1150, recoveredAt: 2100, ms: 950 });
  });

  it('DLQ로 간 작업이 연속을 끊는다', () => {
    const terminals = [...Array.from({ length: 9 }, (_, i) => done(10 + i)), done(19, false), ...Array.from({ length: 10 }, (_, i) => done(20 + i))];
    expect(recoveryOf([0], terminals)).toMatchObject({ kind: 'recovered', recoveredAt: 29 });
  });

  it('연속 10건이 없으면 회복 안 됨이다', () => {
    expect(recoveryOf([0], Array.from({ length: 9 }, (_, i) => done(1 + i)))).toEqual({ kind: 'not-recovered', firstFailureAt: 0 });
  });

  it('입력 순서와 상관없다', () => {
    const terminals = Array.from({ length: 10 }, (_, i) => done(100 - i)); // 100, 99, ..., 91
    expect(recoveryOf([50], terminals, 3)).toMatchObject({ kind: 'recovered', recoveredAt: 93 });
  });
});

describe('회복 시간과 비교할 값', () => {
  it('실패 응답 구간은 첫 실패부터 마지막 실패까지다', () => {
    expect(failureWindow([])).toBeNull();
    expect(failureWindow([3000, 1000, 2500])).toEqual({ first: 1000, last: 3000, ms: 2000 });
  });

  it('10건을 끝내는 데 처리량으로 걸리는 시간(10/처리량)', () => {
    expect(secondsForStreak(0.5)).toBe(20);
    expect(secondsForStreak(0)).toBeNull();
  });
});

describe('처리량과 표', () => {
  it('완료 수 / 초', () => {
    expect(throughputOf(200, 0, 100_000)).toBe(2);
    expect(throughputOf(0, 5, 5)).toBe(0);
  });

  it('칸 안의 | 를 이스케이프한다', () => {
    expect(markdownTable(['a', 'b'], [['1|2', '3']])).toBe('| a | b |\n| --- | --- |\n| 1\\|2 | 3 |');
  });
});

describe('중계 프록시', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  it('절대 경로 요청을 지연 뒤 제 upstream으로만 넘기고 응답 상태를 남긴다', async () => {
    // upstream 자리에 절대 경로 요청을 받는 가짜 프록시를 둔다. 받은 경로와 upstream 이름을 돌려준다.
    const upstreams = await Promise.all(
      ['up-a', 'up-b'].map(async (name) => {
        const server = createServer((req, res) => {
          const expired = req.url?.includes('expired') === true;
          res.writeHead(expired ? 401 : 200, expired ? { 'x-session-expired': '1' } : {}).end(`${name} ${req.url}`);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        closers.push(() => new Promise((resolve) => server.close(() => resolve())));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }),
    );
    const records: RelayRecord[] = [];
    const relays = await Promise.all(
      (['A', 'B'] as const).map((origin, i) => startRelay({ origin, upstream: upstreams[i]!, delayMs: 50, onRecord: (r) => records.push(r) })),
    );
    for (const relay of relays) closers.push(relay.close);

    const viaProxy = async (relayUrl: string, target: string) => {
      const { request } = await import('node:http');
      const relay = new URL(relayUrl);
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: relay.hostname, port: relay.port, path: target, method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    };

    const started = Date.now();
    const a = await viaProxy(relays[0]!.url, 'http://target:8080/transactions?page=3');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    const b = await viaProxy(relays[1]!.url, 'http://target:8080/transactions?expired=1');

    expect(a).toEqual({ status: 200, body: 'up-a http://target:8080/transactions?page=3' });
    expect(b).toEqual({ status: 401, body: 'up-b http://target:8080/transactions?expired=1' });
    expect(records.map((r) => [r.origin, r.path, r.page, r.status, r.sessionExpired])).toEqual([
      ['A', '/transactions', 3, 200, false],
      ['B', '/transactions', null, 401, true],
    ]);
  });

  // 가짜 upstream 하나를 띄우고 그 앞에 중계를 둔다. handler가 upstream의 응답 모양을 정한다.
  async function relayOver(handler: RequestListener, upstreamTimeoutMs?: number) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    });
    const records: RelayRecord[] = [];
    const relay = await startRelay({
      origin: 'A',
      upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      delayMs: 0,
      onRecord: (r) => records.push(r),
      ...(upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs }),
    });
    closers.push(relay.close);
    return { relay, records };
  }

  // 결과가 { status } 또는 { error }로 끝나는지 본다. 끝나지 않으면 테스트 시간 초과로 드러난다.
  async function send(relayUrl: string): Promise<{ status: number; body: string } | { error: string }> {
    const { request } = await import('node:http');
    const relay = new URL(relayUrl);
    return new Promise((resolve) => {
      const req = request({ host: relay.hostname, port: relay.port, path: 'http://target:8080/transactions?page=1', method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', (error) => resolve({ error: error.message }));
        res.on('aborted', () => resolve({ error: 'aborted' }));
      });
      req.on('error', (error) => resolve({ error: error.message }));
      req.end();
    });
  }

  it('본문 도중에 upstream이 끊기면 응답을 끊고, 두 번째 상태(502)를 기록하지 않는다', async () => {
    const { relay, records } = await relayOver((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const result = await send(relay.url);
    expect('error' in result).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records.map((r) => r.status)).toEqual([200]);
  }, 3000);

  it('upstream이 제한 시간 안에 답하지 않으면 502로 끝내고 relayError를 남긴다', async () => {
    const { relay, records } = await relayOver(() => {
      // 답하지 않는다.
    }, 100);
    const result = await send(relay.url);
    expect(result).toMatchObject({ status: 502 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 502, relayError: 'UPSTREAM_TIMEOUT' });
  }, 3000);
});
