/**
 * HTTP를 실제로 보내는 얇은 층. 세션·쿠키·분류는 여기서 하지 않는다.
 *
 * 따로 둔 이유는 두 가지다.
 *
 * 1. **출발지 교체(#14).** undici는 연결 풀을 dispatcher 단위로 들고 있어서, 출발지를
 *    바꾸려면 dispatcher(ProxyAgent)를 바꿔 끼워야 한다. 출발지마다 dispatcher를 쥔 전송을
 *    따로 만들고(`origins.ts`), 전송은 만든 뒤 dispatcher를 바꾸지 않는다.
 * 2. **예외 대신 값.** 네트워크 오류를 던지지 않고 `NetworkFailure`로 돌려준다. 호출하는
 *    쪽이 try/catch를 빠뜨리면 분류기를 거치지 않은 예외가 워커를 죽이고, 그 실패는
 *    어느 종류로도 세지지 않는다.
 *
 * 리다이렉트는 따라가지 않는다. undici 8의 `request`는 따라가는 기능 자체가 없고
 * (`maxRedirections`를 넘기면 `UND_ERR_INVALID_ARG`로 거부한다. 직접 확인했다),
 * 따라가려면 redirect 인터셉터를 붙여야 한다. 붙이지 않는다. 3xx에 실린 `Set-Cookie`는
 * 세션 층이 받아서 저장한다.
 */

import { request } from 'undici';
import type { Dispatcher } from 'undici';

import type { ClassifyInput, NetworkFailure } from './classify.js';

export type HttpRequest = {
  method: 'GET' | 'POST';
  /** 쿼리를 포함한 경로. 예: `/transactions?page=2` */
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

/** 응답을 받았으면 `RawResponse`, 받기 전에 끊겼으면 `NetworkFailure`. 던지지 않는다. */
export type Transport = (req: HttpRequest) => Promise<ClassifyInput>;

export type UndiciTransportOptions = {
  /** 예: `http://127.0.0.1:8081` */
  origin: string;
  /**
   * 출발지별 ProxyAgent(#14, `origins.ts`). 없으면 undici 전역 dispatcher이고, 그때는 요청마다 **그 시점의**
   * 전역을 쓴다(d3-origin.md 2절 H2).
   */
  dispatcher?: Dispatcher;
  /**
   * 헤더가 올 때까지 기다리는 시간(ms). undici 기본값은 300초다. 응답하지 않는 서버에
   * 워커 하나가 5분씩 묶이면 그동안 처리량이 그만큼 빠진다. 대상 서버는 수 ms 안에
   * 답하므로 10초면 정상 응답을 자르지 않는다.
   */
  headersTimeout?: number;
  /** 본문 조각 사이의 최대 간격(ms). 같은 이유로 10초. */
  bodyTimeout?: number;
};

export const DEFAULT_TIMEOUT_MS = 10_000;

export function createUndiciTransport(options: UndiciTransportOptions): Transport {
  const { origin, dispatcher } = options;
  const headersTimeout = options.headersTimeout ?? DEFAULT_TIMEOUT_MS;
  const bodyTimeout = options.bodyTimeout ?? DEFAULT_TIMEOUT_MS;

  return async (req) => {
    try {
      const res = await request(new URL(req.path, origin), {
        method: req.method,
        headers: req.headers ?? {},
        body: req.body ?? null,
        headersTimeout,
        bodyTimeout,
        ...(dispatcher === undefined ? {} : { dispatcher }),
      });
      // 본문은 상태 코드와 상관없이 끝까지 읽는다. 안 읽으면 소켓이 풀에 돌아가지 않고,
      // 분류기는 4xx 본문(`error` 필드)으로도 판정한다.
      const body = Buffer.from(await res.body.arrayBuffer());
      return { status: res.statusCode, headers: res.headers, body };
    } catch (error) {
      return toNetworkFailure(error);
    }
  };
}

/**
 * 던져진 오류에서 분류에 쓰는 필드만 옮긴다.
 *
 * 실측한 모양(undici 8.10, Node 26): 닫힌 포트는 `Error` + `code: 'ECONNREFUSED'`,
 * 도중 리셋은 `Error` + `code: 'ECONNRESET'`, 헤더 타임아웃은 `HeadersTimeoutError` +
 * `code: 'UND_ERR_HEADERS_TIMEOUT'`. 셋 다 `cause` 없이 최상위에 code가 있다.
 * `fetch`는 이것을 `TypeError('fetch failed')`의 `cause`로 감싸므로, 감싼 경우도 벗긴다.
 */
export function toNetworkFailure(error: unknown): NetworkFailure {
  const top = asErrorLike(error);
  const cause = asErrorLike(top.cause);
  const code = top.code ?? cause.code;
  const name = top.name === 'TypeError' && cause.name !== undefined ? cause.name : top.name;
  return {
    network: {
      ...(code === undefined ? {} : { code }),
      ...(name === undefined ? {} : { name }),
      message: top.message ?? String(error),
    },
  };
}

type ErrorLike = { code?: string; name?: string; message?: string; cause?: unknown };

function asErrorLike(value: unknown): ErrorLike {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  return {
    ...(typeof v.code === 'string' ? { code: v.code } : {}),
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(typeof v.message === 'string' ? { message: v.message } : {}),
    cause: v.cause,
  };
}
