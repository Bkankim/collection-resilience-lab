import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { formatRecovery, markdownTable, recoveryOf, throughputOf } from './metrics.js';
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
});
