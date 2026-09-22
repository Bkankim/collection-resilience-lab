/**
 * 전송 계층 테스트. 네트워크 오류를 흉내 내지 않고 실제 소켓으로 만든다.
 *
 * #11에서는 오류 객체를 손으로 만들어 분류기에 넣었다. 그러면 undici가 실제로 어떤
 * 모양의 오류를 던지는지는 검증되지 않는다(당시 커밋의 Not-tested). 여기서 닫힌 포트,
 * 응답하지 않는 서버, 도중에 끊는 서버를 실제로 띄워 그 빈칸을 메운다.
 */

import http from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { classify } from './classify.js';
import { createUndiciTransport, toNetworkFailure } from './transport.js';

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  // 응답하지 않는 서버는 연결을 스스로 닫지 않는다. close()는 열린 연결이 끝나기를
  // 기다리므로, 먼저 끊지 않으면 정리 단계가 테스트 시간 제한에 걸린다.
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('undici 전송', () => {
  it('닫힌 포트는 ECONNREFUSED로 돌려주고 TRANSIENT로 분류된다', async () => {
    const probe = createServer();
    const origin = await listen(probe);
    await new Promise((r) => probe.close(r));
    servers.splice(servers.indexOf(probe), 1);

    const res = await createUndiciTransport({ origin })({ method: 'GET', path: '/health' });
    expect(res).toMatchObject({ network: { code: 'ECONNREFUSED' } });
    expect(classify(res)).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('헤더를 안 주는 서버는 헤더 타임아웃으로 돌려주고 TRANSIENT로 분류된다', async () => {
    const origin = await listen(createServer(() => {}));
    const res = await createUndiciTransport({ origin, headersTimeout: 200 })({ method: 'GET', path: '/' });
    expect(res).toMatchObject({ network: { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError' } });
    expect(classify(res)).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('요청을 받자마자 연결을 끊는 서버는 ECONNRESET으로 돌려준다', async () => {
    const origin = await listen(createServer((socket) => socket.on('data', () => socket.resetAndDestroy())));
    const res = await createUndiciTransport({ origin })({ method: 'GET', path: '/' });
    expect(res).toMatchObject({ network: { code: 'ECONNRESET' } });
    expect(classify(res)).toMatchObject({ kind: 'TRANSIENT' });
  });

  it('302를 따라가지 않고 그대로 돌려주며, Set-Cookie를 배열로 준다', async () => {
    const seen: string[] = [];
    const origin = await listen(
      http.createServer((req, res) => {
        seen.push(req.url ?? '');
        res.statusCode = 302;
        res.setHeader('location', '/next');
        res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
        res.end();
      }),
    );
    const res = await createUndiciTransport({ origin })({ method: 'GET', path: '/start' });
    expect(res).toMatchObject({ status: 302, headers: { location: '/next', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] } });
    expect(seen).toEqual(['/start']);
  });

  it('fetch처럼 cause로 감싼 오류도 벗겨서 옮긴다', () => {
    const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(toNetworkFailure(wrapped)).toEqual({ network: { code: 'ECONNREFUSED', name: 'Error', message: 'fetch failed' } });
  });
});
