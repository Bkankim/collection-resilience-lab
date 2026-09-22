/**
 * 세션 저장소. 발급과 폐기만 한다. 만료 판정은 `switches.ts`가 한다.
 *
 * 만료를 여기 두지 않은 이유는 그쪽 주석에 적었다. 요약하면 만료는 세션의
 * 성질이 아니라 대상 서버가 켜고 끄는 차단 조건이기 때문이다.
 */

import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';

/** 1차 인증까지만 통과했는가, 2차까지 통과했는가. */
export type SessionLevel = 'PRIMARY' | 'FULL';

export type Session = {
  id: string;
  accountId: string;
  level: SessionLevel;
  /** 이 식별자가 발급된 시각(ms). 세션 만료 스위치가 이 값을 기준으로 잰다. */
  issuedAt: number;
};

export const SESSION_COOKIE = 'lab_session';

/**
 * 쿠키의 `Max-Age`. 세션 만료 임계값(S)과 **일부러 분리했다.**
 *
 * 같은 값으로 두면 규격을 지키는 클라이언트(curl 쿠키 자, 브라우저)가 딱 그
 * 시점에 쿠키를 스스로 버린다. 그러면 서버에 쿠키가 아예 안 오고, 서버는
 * "세션이 만료됐다"가 아니라 "쿠키가 없다"로 답하게 된다. 수집하는 쪽에서는
 * 재인증하면 되는 상황과 처음부터 인증이 없는 상황이 같은 응답으로 보인다.
 *
 * 만료 판정의 권위자는 서버다. 쿠키 수명은 서버 수명보다 길어야 서버가 이유를
 * 말할 기회를 갖는다.
 */
export const SESSION_COOKIE_MAX_AGE_SEC = 1800;

export class SessionStore {
  readonly #clock: Clock;
  readonly #byId = new Map<string, Session>();
  /**
   * 만료로 죽은 식별자. 값은 안 들고 있고 "만료였다"는 사실만 남긴다.
   *
   * 지우고 잊어버리면 같은 쿠키로 두 번째 요청을 보냈을 때 "만료"가 아니라
   * "모르는 세션"이 된다. 워커는 재시도를 하므로 두 번째 요청이 흔하고, 그때
   * 원인이 하나인데 분류가 둘이 되면 대응이 갈린다.
   *
   * 로그인·승급에서 버리는 식별자는 여기 넣지 않는다. 그건 만료가 아니라 폐기다.
   */
  readonly #expired = new Set<string>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get size(): number {
    return this.#byId.size;
  }

  issue(accountId: string, level: SessionLevel): Session {
    // 24바이트면 추측으로 맞힐 수 없고, base64url이라 쿠키 값에 그대로 들어간다.
    const session: Session = {
      id: randomBytes(24).toString('base64url'),
      accountId,
      level,
      issuedAt: this.#clock(),
    };
    this.#byId.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.#byId.get(id);
  }

  /**
   * 권한 수준을 올리면서 **식별자를 새로 발급**하고 이전 것을 버린다.
   *
   * session fixation 방어의 핵심이 여기다. 공격자가 심어 둔 식별자가 그대로
   * 살아서 권한만 올라가면, 공격자는 자기가 아는 값으로 남의 세션을 쓰게 된다.
   * 로그인 시점뿐 아니라 2차 인증 통과 시점에도 바꾸는 이유는, 권한이 바뀌는
   * 지점이 두 군데이기 때문이다.
   */
  promote(session: Session, level: SessionLevel): Session {
    this.#byId.delete(session.id);
    return this.issue(session.accountId, level);
  }

  /** 폐기한다. 만료와 다르다. 이 식별자는 이후 "모르는 세션"으로 답한다. */
  drop(id: string): void {
    this.#byId.delete(id);
  }

  /** 만료시킨다. 이후 같은 식별자로 몇 번을 물어도 "만료"라고 답한다. */
  expire(id: string): void {
    this.#byId.delete(id);
    this.#expired.add(id);
  }

  wasExpired(id: string): boolean {
    return this.#expired.has(id);
  }

  clear(): void {
    this.#byId.clear();
    this.#expired.clear();
  }
}
