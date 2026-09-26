/**
 * 출발지 풀(#14). 출발지 차단(IP_BLOCKED)을 받으면 다른 출발지로 바꾸는 데 쓴다.
 *
 * 고르는 기준은 **차단 해제 시각 하나**다. 차단된 출발지는 대상 서버가 준 Retry-After가 끝날 때까지 후보에서
 * 빼고, 후보가 여럿이면 목록 순서대로 첫 번째를 쓴다. 출발지별 성공·실패 수는 세지만(로그·이벤트로 내보내
 * 측정 #15가 쓴다) 고르는 데는 쓰지 않는다. 통계로 고르면 "왜 이 출발지로 나갔는가"를 로그만으로 되짚기
 * 어렵고, 차단이 풀린 출발지를 지난 실패 때문에 계속 피하게 된다.
 *
 * 속도 제한(429)으로는 바꾸지 않는다. 속도 제한을 출발지를 바꿔 피하는 것은 상대가 정한 한도를 우회하는
 * 것이다. 429는 지금처럼 큐 전체를 멈춘다(`queue.ts` DISPOSITION).
 *
 * **상태는 이 객체, 곧 워커 프로세스 하나에만 있다.** 워커끼리 공유하지 않으므로 워커마다 같은 차단을 한
 * 번씩 따로 겪는다(README 한계).
 *
 * 출발지마다 undici `ProxyAgent`를 하나씩 두고 그 dispatcher를 쥔 전송을 따로 만든다. undici는 연결 풀을
 * dispatcher 단위로 들고 있어서, 전송 하나에서 dispatcher만 바꿔 끼우거나 전역 dispatcher에 기대면 어느
 * 출발지로 나가는지가 호출 시점의 전역 상태에 달린다. 전송을 출발지마다 고정하면 고른 출발지가 곧 나가는
 * 출발지다(`docs/evidence/d3-origin.md` 2절 H2).
 */

import { ProxyAgent } from 'undici';

import type { Clock } from './clock.js';
import { createUndiciTransport } from './transport.js';
import type { Transport } from './transport.js';

export type Origin = {
  /** 로그·이벤트에 찍는 이름. 프록시 주소 그대로다. */
  readonly name: string;
  /** 이 출발지로만 나가는 전송. */
  readonly transport: Transport;
};

/** 출발지별 수집 결과 수. 수집 한 번(작업 한 번의 `collect` 호출)을 하나로 센다. */
export type OriginStats = { ok: number; failed: number };

export type OriginState = { name: string; blockedUntil: number | null } & OriginStats;

type Entry = { origin: Origin; blockedUntil: number; stats: OriginStats };

export class OriginPool {
  readonly #entries: Entry[];
  readonly #clock: Clock;

  constructor(origins: readonly Origin[], clock: Clock) {
    if (origins.length === 0) throw new RangeError('출발지가 하나도 없다');
    const names = new Set(origins.map((o) => o.name));
    if (names.size !== origins.length) throw new RangeError(`출발지 이름이 겹친다: ${origins.map((o) => o.name).join(', ')}`);
    this.#entries = origins.map((origin) => ({ origin, blockedUntil: 0, stats: { ok: 0, failed: 0 } }));
    this.#clock = clock;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** 막히지 않은 첫 출발지. 전부 막혔으면 undefined. */
  available(): Origin | undefined {
    const now = this.#clock();
    return this.#entries.find((e) => e.blockedUntil <= now)?.origin;
  }

  /**
   * 지금 쓸 출발지. 막히지 않은 첫 출발지이고, 전부 막혔으면 가장 빨리 풀리는 출발지다. 전부 막힌 동안은 워커가
   * 그 해제 시각까지 큐를 멈추므로(`worker/process.ts`) 보통은 여기서 풀린 출발지가 나온다. 다른 워커 프로세스의
   * 429가 정지를 짧게 끝낸 경우처럼 아직 막힌 채 꺼내면, 그 출발지로 보내 보고 다시 IP_BLOCKED를 받는다.
   */
  pick(): Origin {
    const free = this.available();
    if (free !== undefined) return free;
    return this.#earliest().origin;
  }

  /** `untilMs`까지 후보에서 뺀다. 이미 더 늦게까지 막혀 있으면 줄이지 않는다. 실제로 남은 해제 시각을 돌려준다. */
  block(origin: Origin, untilMs: number): number {
    const entry = this.#entry(origin);
    entry.blockedUntil = Math.max(entry.blockedUntil, untilMs);
    return entry.blockedUntil;
  }

  /** 가장 빨리 풀리는 시각(ms). 이미 풀린 출발지가 있으면 지금 이하다. */
  earliestRelease(): number {
    return this.#earliest().blockedUntil;
  }

  /** 수집 한 번의 결과를 센다. 센 뒤의 수를 돌려준다. */
  record(origin: Origin, ok: boolean): OriginStats {
    const { stats } = this.#entry(origin);
    if (ok) stats.ok += 1;
    else stats.failed += 1;
    return { ...stats };
  }

  /** 로그용. 풀린 출발지는 `blockedUntil` null. */
  states(): OriginState[] {
    const now = this.#clock();
    return this.#entries.map((e) => ({ name: e.origin.name, blockedUntil: e.blockedUntil > now ? e.blockedUntil : null, ...e.stats }));
  }

  #earliest(): Entry {
    return this.#entries.reduce((a, b) => (b.blockedUntil < a.blockedUntil ? b : a));
  }

  #entry(origin: Origin): Entry {
    const entry = this.#entries.find((e) => e.origin === origin);
    if (entry === undefined) throw new RangeError(`풀에 없는 출발지다: ${origin.name}`);
    return entry;
  }
}

/**
 * `WORKER_PROXIES` 값을 읽는다. 쉼표로 나눈 http(s) 프록시 주소다. 비었거나 없으면 빈 배열(프록시 없이 직접 보낸다).
 * 틀린 값은 던진다. 조용히 빼면 출발지를 둘 두었다고 믿는 측정이 하나로 돈다.
 */
export function parseProxyList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const proxies = raw.split(',').map((part) => part.trim());
  // 오류 메시지에는 몇 번째 항목인지와 이유만 싣고 원문의 어느 조각도 싣지 않는다. 자격증명이 든 값(`user:pass@host`,
  // `socks5://user:pass@host`, `TOKEN:@host`처럼 스킴 자리에 비밀이 온 값)이 자격증명 검사에 닿기 전에 앞의 검사에서
  // 걸리면 원문째, 또는 스킴·호스트 조각으로 로그에 남는다(final-review #1).
  for (const [i, proxy] of proxies.entries()) {
    let url: URL;
    try {
      url = new URL(proxy);
    } catch {
      throw new RangeError(`WORKER_PROXIES ${i + 1}번째 항목이 URL이 아니다`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RangeError(`WORKER_PROXIES ${i + 1}번째 항목이 http 또는 https가 아니다`);
    if (url.username !== '' || url.password !== '') throw new RangeError(`WORKER_PROXIES ${i + 1}번째 항목에 자격증명이 실렸다(로그에 이름으로 찍히므로 싣지 않는다)`);
  }
  const first = new Map<string, number>();
  for (const [i, proxy] of proxies.entries()) {
    const seen = first.get(proxy);
    if (seen !== undefined) throw new RangeError(`WORKER_PROXIES ${i + 1}번째 항목이 ${seen + 1}번째 항목과 같다`);
    first.set(proxy, i);
  }
  return proxies;
}

export const DEFAULT_TARGET_ORIGIN = 'http://127.0.0.1:8080';

/**
 * `TARGET_ORIGIN`을 읽는다. 프록시가 없으면 비었을 때 기본값(호스트에서 띄운 대상 서버)이다. **프록시가 있으면 반드시
 * 받는다.** 대상 서버 주소는 프록시가 푸는데, 기본값 127.0.0.1은 프록시 컨테이너 안에서 프록시 자신이라 요청이 전부
 * 5xx(TRANSIENT)로 재시도하다 DLQ로 가고 전환은 한 번도 일어나지 않는다. 설정 오류는 워커를 시작할 때 드러낸다.
 */
export function resolveTargetOrigin(raw: string | undefined, proxies: readonly string[]): string {
  if (raw !== undefined && raw.trim() !== '') return raw;
  if (proxies.length > 0) throw new RangeError('WORKER_PROXIES를 주면 TARGET_ORIGIN도 줘야 한다(프록시가 보는 대상 서버 주소, compose면 http://target:8080)');
  return DEFAULT_TARGET_ORIGIN;
}

export type ProxyOrigins = { origins: Origin[]; close: () => Promise<void> };

/** 프록시마다 `ProxyAgent`와 그것을 쥔 전송을 만든다. `target`은 프록시가 보는 대상 서버 주소다. */
export function createProxyOrigins(proxies: readonly string[], target: string): ProxyOrigins {
  const agents = proxies.map((proxy) => new ProxyAgent(proxy));
  return {
    origins: proxies.map((proxy, i) => ({ name: proxy, transport: createUndiciTransport({ origin: target, dispatcher: agents[i] as ProxyAgent }) })),
    close: async () => {
      await Promise.all(agents.map((agent) => agent.close()));
    },
  };
}
