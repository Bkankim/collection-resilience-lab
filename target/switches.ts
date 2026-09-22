/**
 * 차단 조건을 켜고 끄는 스위치와, 그 조건을 실제로 판정하는 자리.
 *
 * 이 파일이 있어야 같은 조건에서 반복 측정이 된다. 외부 사이트를 대상으로 하면
 * 상대의 임계치를 모르고, 알아도 바꿀 수 없으니 "차단 전 / 차단 후"를 나란히
 * 놓고 비교할 수 없다.
 *
 * 세 스위치 모두 확률을 쓰지 않는다. 임계값과 시각만으로 결정된다. 확률이 끼면
 * 같은 설정으로 두 번 측정한 결과가 달라지고, 그러면 결과표가 아무것도 말하지
 * 못한다.
 */

import type { Clock } from './clock.js';

export type SwitchName = 'rateLimit' | 'ipBlock' | 'sessionExpiry';

export type SwitchState = Record<SwitchName, boolean>;

/**
 * 임계값. 이슈 #8의 W/N/M/T/S와 1:1로 대응한다.
 *
 * 측정할 때 이 값을 결과표에 함께 적는다. 임계값 없는 성공률은 비교할 수 없다.
 */
export type Thresholds = {
  /** W: 속도 제한을 재는 창의 길이(초) */
  windowSec: number;
  /** N: 창 안에서 허용하는 요청 수. 이 수를 넘는 요청부터 429 */
  maxRequests: number;
  /** M: 같은 출발지가 429를 몇 번 받으면 차단으로 넘어가는가 */
  blockAfter: number;
  /** T: 출발지 차단이 유지되는 시간(초). 지나면 자동 해제 */
  blockDurationSec: number;
  /** S: 세션이 발급된 뒤 살아 있는 시간(초) */
  sessionTtlSec: number;
};

export const SWITCH_NAMES = ['rateLimit', 'ipBlock', 'sessionExpiry'] as const satisfies readonly SwitchName[];

/** 기본값은 전부 꺼짐이다. 차단 없는 상태가 측정의 기준선이 된다. */
export const DEFAULT_SWITCHES: SwitchState = {
  rateLimit: false,
  ipBlock: false,
  sessionExpiry: false,
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  windowSec: 10,
  maxRequests: 5,
  blockAfter: 3,
  blockDurationSec: 30,
  sessionTtlSec: 60,
};

/** 요청 하나에 대한 판정. */
export type Verdict =
  | { kind: 'PASS' }
  | { kind: 'RATE_LIMITED'; retryAfterSec: number }
  | { kind: 'IP_BLOCKED'; retryAfterSec: number };

const THRESHOLD_KEYS = [
  'windowSec',
  'maxRequests',
  'blockAfter',
  'blockDurationSec',
  'sessionTtlSec',
] as const satisfies readonly (keyof Thresholds)[];

/**
 * 관리 API가 받은 값을 검증한다.
 *
 * 임계값이 0이나 음수면 판정이 뜻을 잃는다(창 길이 0, 허용 0회). 검증을 안 하면
 * 측정 중에 조용히 이상한 값이 들어가고, 결과표를 보고 나서야 이상을 알게 된다.
 */
export function parseThresholdPatch(input: unknown): { ok: true; patch: Partial<Thresholds> } | { ok: false; message: string } {
  if (input === undefined) return { ok: true, patch: {} };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'thresholds는 객체여야 합니다' };
  }
  const raw = input as Record<string, unknown>;
  const patch: Partial<Thresholds> = {};
  for (const key of Object.keys(raw)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, message: `모르는 임계값입니다: ${key}` };
    }
  }
  for (const key of THRESHOLD_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return { ok: false, message: `${key}는 1 이상의 정수여야 합니다` };
    }
    patch[key] = value;
  }
  return { ok: true, patch };
}

export function parseSwitchPatch(input: unknown): { ok: true; patch: Partial<SwitchState> } | { ok: false; message: string } {
  if (input === undefined) return { ok: true, patch: {} };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'switches는 객체여야 합니다' };
  }
  const raw = input as Record<string, unknown>;
  const patch: Partial<SwitchState> = {};
  for (const key of Object.keys(raw)) {
    if (!(SWITCH_NAMES as readonly string[]).includes(key)) {
      return { ok: false, message: `모르는 스위치입니다: ${key}` };
    }
  }
  for (const name of SWITCH_NAMES) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      return { ok: false, message: `${name}은 true/false여야 합니다` };
    }
    patch[name] = value;
  }
  return { ok: true, patch };
}

export class BlockSwitches {
  readonly #clock: Clock;
  #switches: SwitchState = { ...DEFAULT_SWITCHES };
  #thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

  /** 출발지별 요청 시각(ms). 오름차순. 창 밖으로 나간 항목은 판정할 때 버린다. */
  readonly #hits = new Map<string, number[]>();
  /** 출발지별 429 누적 횟수. M에 닿으면 차단으로 넘어간다. */
  readonly #rejects = new Map<string, number>();
  /** 출발지별 차단 해제 시각(ms). */
  readonly #blockedUntil = new Map<string, number>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get switches(): SwitchState {
    return { ...this.#switches };
  }

  get thresholds(): Thresholds {
    return { ...this.#thresholds };
  }

  /**
   * 스위치나 임계값을 바꾼다. **바꾸면 누적 카운터를 전부 버린다.**
   *
   * 남겨 두면 직전 측정에서 쌓인 요청 이력 때문에 새 측정이 시작하자마자 429를
   * 맞는다. 측정은 항상 조건을 세우고 시작하므로, 조건을 바꾸는 순간이 곧
   * 초기화 시점이다.
   */
  configure(patch: { switches?: Partial<SwitchState>; thresholds?: Partial<Thresholds> }): void {
    this.#switches = { ...this.#switches, ...patch.switches };
    this.#thresholds = { ...this.#thresholds, ...patch.thresholds };
    this.resetCounters();
  }

  resetCounters(): void {
    this.#hits.clear();
    this.#rejects.clear();
    this.#blockedUntil.clear();
  }

  /**
   * 요청 하나를 받아들일지 판정한다.
   *
   * 판정 순서가 곧 설계다. 차단된 출발지는 속도 제한을 재기 전에 잘라낸다.
   * 실제 서버라면 차단은 앞단(방화벽·WAF)에서 끊기지 애플리케이션 카운터까지
   * 오지 않는다. 여기서 순서를 뒤집으면 차단 중인 출발지의 요청이 계속 창에
   * 쌓여서, 차단이 풀리는 순간 한 번에 다시 429가 난다.
   */
  admit(origin: string): Verdict {
    const now = this.#clock();

    const until = this.#blockedUntil.get(origin);
    if (until !== undefined) {
      if (now < until) {
        return { kind: 'IP_BLOCKED', retryAfterSec: secondsUntil(now, until) };
      }
      // 차단이 풀렸다. 누적 429도 함께 버린다. 남겨 두면 해제 직후 429 한 번에
      // 곧바로 다시 차단되어 T초 해제가 사실상 동작하지 않는다.
      this.#blockedUntil.delete(origin);
      this.#rejects.delete(origin);
      this.#hits.delete(origin);
    }

    if (!this.#switches.rateLimit) {
      // 속도 제한이 꺼져 있으면 창에 기록조차 하지 않는다. 기록해 두면 스위치를
      // 켜는 순간 이전 이력 때문에 바로 429가 나서 "켠 시점부터" 세는 것이 아니게 된다.
      return { kind: 'PASS' };
    }

    const { windowSec, maxRequests, blockAfter, blockDurationSec } = this.#thresholds;
    const windowStart = now - windowSec * 1000;
    const hits = (this.#hits.get(origin) ?? []).filter((at) => at > windowStart);

    if (hits.length >= maxRequests) {
      this.#hits.set(origin, hits);
      const rejects = (this.#rejects.get(origin) ?? 0) + 1;
      this.#rejects.set(origin, rejects);

      if (this.#switches.ipBlock && rejects >= blockAfter) {
        const blockedUntil = now + blockDurationSec * 1000;
        this.#blockedUntil.set(origin, blockedUntil);
        return { kind: 'IP_BLOCKED', retryAfterSec: secondsUntil(now, blockedUntil) };
      }

      // 창이 비는 시각은 가장 오래된 요청이 창 밖으로 나가는 때다.
      const oldest = hits[0] ?? now;
      return { kind: 'RATE_LIMITED', retryAfterSec: secondsUntil(now, oldest + windowSec * 1000) };
    }

    hits.push(now);
    this.#hits.set(origin, hits);
    return { kind: 'PASS' };
  }

  /**
   * 세션이 만료됐는가. 스위치가 꺼져 있으면 만료시키지 않는다.
   *
   * 이 판정을 세션 저장소가 아니라 여기에 둔 이유: 만료는 세션의 성질이 아니라
   * 대상 서버가 켜고 끄는 차단 조건이다. 저장소에 두면 스위치를 끈 상태에서도
   * 세션이 죽어서 기준선 측정이 오염된다.
   */
  isSessionExpired(issuedAt: number): boolean {
    if (!this.#switches.sessionExpiry) return false;
    return this.#clock() - issuedAt > this.#thresholds.sessionTtlSec * 1000;
  }
}

/** Retry-After는 초 단위 정수다. 0을 주면 즉시 재시도하라는 뜻이 되므로 최소 1을 준다. */
function secondsUntil(now: number, at: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}
