/**
 * 측정용 중계 프록시(#15). 워커와 출발지 프록시(tinyproxy) 사이에 하나씩 둔다.
 *
 * 하는 일은 둘이다.
 * 1. 요청마다 고정 지연 `delayMs`를 넣는다. 대상 서버는 요청 하나를 수 ms에 답해서 작업 하나(로그인 2 + 페이지 8)가
 *    100ms 안에 끝난다. 세션 만료 임계값 S는 1초가 최소라 지연 없이는 작업 안에서 세션이 만료되지 않는다.
 *    지연은 네 시나리오에 같은 값으로 넣는다. 시나리오끼리 조건이 같아야 비교가 된다.
 * 2. 응답마다 상태 코드를 호스트 시계로 남긴다. 대상 서버 로그는 VM 시계라 워커 로그와 0.1~0.2초 어긋나고
 *    (`docs/evidence/d3-origin.md`), 워커는 수집 안에서 재인증한 세션 만료를 사건으로 남기지 않는다. 회복 시간의
 *    "첫 실패 응답"은 여기서 읽는다.
 *
 * 중계 하나는 제 upstream 하나로만 보낸다. 출발지가 섞이면 전환 측정이 뜻을 잃는다. undici `ProxyAgent`는 http 대상에
 * CONNECT를 쓰지 않고 절대 경로 요청을 보내므로(d3-origin.md H2) 그 요청을 그대로 upstream 프록시에 넘긴다.
 * CONNECT가 오면 405로 끊는다. 조용히 다른 길로 보내지 않는다.
 */

import { Agent, createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RelayRecord = {
  /** 응답 머리를 받은 시각(ISO, 호스트 시계). */
  t: string;
  origin: string;
  method: string;
  path: string;
  page: number | null;
  status: number;
  /** 401 + `X-Session-Expired`면 true. 대상 서버가 세션 만료를 알리는 표식이다. */
  sessionExpired: boolean;
  retryAfter: string | null;
  /** upstream에 닿지 못해 중계가 502를 만든 경우의 오류 코드. 대상 서버가 준 응답이 아니다. */
  relayError?: string;
};

export type RelayOptions = {
  /** 로그와 결과표에 쓸 이름(`A`, `B`). */
  origin: string;
  /** 이 중계가 넘기는 출발지 프록시. 예 `http://127.0.0.1:3128`. */
  upstream: string;
  delayMs: number;
  /** upstream 요청 하나의 제한 시간. 넘기면 502(`relayError: 'UPSTREAM_TIMEOUT'`)로 끝낸다. 기본 20초. */
  upstreamTimeoutMs?: number;
  onRecord: (record: RelayRecord) => void;
  clock?: () => number;
};

export type Relay = { url: string; close: () => Promise<void> };

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const upstream = new URL(options.upstream);
  const clock = options.clock ?? Date.now;
  // upstream 연결을 다시 쓰지 않는다. tinyproxy는 응답 하나마다 클라이언트 연결을 닫는데(로그의 `Closed connection
  // between local client`), keep-alive로 그 연결을 다시 쓰면 닫히는 소켓에 요청이 실려 502가 난다(시험 실행에서
  // 20건 중 7번, 워커는 TRANSIENT로 시도를 썼다). 측정 도구가 만든 실패가 결과에 섞이면 안 된다.
  const agent = new Agent({ keepAlive: false });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const target = req.url ?? '';
    if (!/^https?:\/\//.test(target)) {
      res.writeHead(400).end('absolute-form only');
      return;
    }
    const url = new URL(target);
    setTimeout(() => {
      const outgoing = httpRequest(
        { host: upstream.hostname, port: upstream.port, method: req.method, path: target, headers: req.headers, agent },
        (upstreamRes) => {
          const page = url.searchParams.get('page');
          const retryAfter = upstreamRes.headers['retry-after'];
          options.onRecord({
            t: new Date(clock()).toISOString(),
            origin: options.origin,
            method: req.method ?? '',
            path: url.pathname,
            page: page === null ? null : Number(page),
            status: upstreamRes.statusCode ?? 0,
            sessionExpired: upstreamRes.headers['x-session-expired'] === '1',
            retryAfter: typeof retryAfter === 'string' ? retryAfter : null,
          });
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          // 본문 도중에 upstream이 끊기면 pipe는 res를 끝내지 않는다. 워커가 제 시간 초과까지 멈추지 않게 응답을 끊는다.
          upstreamRes.on('aborted', () => res.destroy());
          upstreamRes.on('error', () => res.destroy());
          upstreamRes.pipe(res);
        },
      );
      outgoing.setTimeout(options.upstreamTimeoutMs ?? 20_000, () => {
        const error: NodeJS.ErrnoException = new Error('upstream 응답 제한 시간 초과');
        error.code = 'UPSTREAM_TIMEOUT';
        outgoing.destroy(error);
      });
      outgoing.on('error', (error) => {
        // 응답 머리를 이미 보냈으면 그 상태가 기록돼 있다. 두 번째 상태(502)를 기록하지 않고 응답을 끊는다.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        // upstream이 죽으면 502. 워커는 이것을 TRANSIENT로 본다. 조용히 삼키지 않고 기록도 남긴다.
        options.onRecord({
          t: new Date(clock()).toISOString(),
          origin: options.origin,
          method: req.method ?? '',
          path: url.pathname,
          page: null,
          status: 502,
          sessionExpired: false,
          retryAfter: null,
          relayError: (error as NodeJS.ErrnoException).code ?? error.message,
        });
        res.writeHead(502);
        res.end(error.message);
      });
      req.pipe(outgoing);
    }, options.delayMs);
  });
  server.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      agent.destroy();
    },
  };
}
