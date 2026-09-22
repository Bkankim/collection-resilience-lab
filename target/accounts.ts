/**
 * 계정 저장소. 1차 인증(비밀번호)과 2차 인증(TOTP), 그리고 계정 잠금.
 *
 * 여기 있는 자격증명은 실험용 대상 서버의 고정 데모 값이다. 리포에 공개되어
 * 있고, 실제 계정이 아니다. 대상 서버 자체가 실험 장비이므로 숨길 이유가 없고,
 * 오히려 고정되어 있어야 측정이 재현된다.
 */

import { verifySync } from 'otplib';
import type { Clock } from './clock.js';

export type Account = {
  id: string;
  password: string;
  /**
   * base32로 인코딩된 TOTP 공유키. **20바이트(base32 32자) 이상**이어야 한다.
   *
   * 예제마다 나오는 `JBSWY3DPEHPK3PXP`는 10바이트라 otplib 13이
   * `SecretTooShortError`로 거부한다(최소 128비트). 12에서는 통과하던 값이다.
   */
  totpSecret: string;
  /** 거래내역 조회에 쓰는 계좌번호. 실제 은행 번호 체계가 아니다. */
  accountNo: string;
  /** 이 계좌에 쌓인 거래 건수. 결정론적으로 생성한다. */
  txCount: number;
};

/** 비밀번호를 몇 번 틀리면 계정을 잠그는가. */
export const MAX_PASSWORD_FAILURES = 5;

export const DEMO_ACCOUNTS: readonly Account[] = [
  {
    id: 'demo01',
    password: 'demo-pass-01',
    totpSecret: 'LDL3EJLY2NS3RYE6K77KL6PRFKQ4ZK3M',
    accountNo: '000-11-222333',
    txCount: 137,
  },
  {
    id: 'demo02',
    password: 'demo-pass-02',
    totpSecret: 'AOK4WNWZSOGBDBZ7KFEWQVURPJB5PWZC',
    accountNo: '000-44-555666',
    txCount: 12,
  },
];

export type LoginOutcome =
  | { ok: true; account: Account }
  /**
   * 잠긴 계정과 그냥 틀린 비밀번호를 나눈다. 응답은 둘 다 401 + `X-Auth-Failed`로
   * 같지만, 수집하는 쪽이 로그로 구분할 수 있어야 왜 멈췄는지 사람이 안다.
   */
  | { ok: false; reason: 'LOCKED' | 'BAD_CREDENTIALS' };

export class AccountStore {
  readonly #clock: Clock;
  readonly #byId = new Map<string, Account>();
  readonly #failures = new Map<string, number>();
  readonly #locked = new Set<string>();

  constructor(clock: Clock, accounts: readonly Account[] = DEMO_ACCOUNTS) {
    this.#clock = clock;
    for (const account of accounts) this.#byId.set(account.id, account);
  }

  get(id: string): Account | undefined {
    return this.#byId.get(id);
  }

  isLocked(id: string): boolean {
    return this.#locked.has(id);
  }

  failureCount(id: string): number {
    return this.#failures.get(id) ?? 0;
  }

  /**
   * 1차 인증.
   *
   * 없는 계정과 틀린 비밀번호를 같은 결과로 돌려준다. 나누면 응답만 보고
   * 어떤 아이디가 실재하는지 가려낼 수 있다.
   */
  login(id: string, password: string): LoginOutcome {
    if (this.#locked.has(id)) return { ok: false, reason: 'LOCKED' };

    const account = this.#byId.get(id);
    if (account === undefined || account.password !== password) {
      // 없는 계정에는 실패를 세지 않는다. 세면 아무 문자열이나 다섯 번 보내서
      // 잠금 테이블을 무제한으로 불릴 수 있다.
      if (account === undefined) return { ok: false, reason: 'BAD_CREDENTIALS' };

      const failures = this.failureCount(id) + 1;
      this.#failures.set(id, failures);
      if (failures >= MAX_PASSWORD_FAILURES) {
        this.#locked.add(id);
        return { ok: false, reason: 'LOCKED' };
      }
      return { ok: false, reason: 'BAD_CREDENTIALS' };
    }

    this.#failures.delete(id);
    return { ok: true, account };
  }

  /**
   * 2차 인증.
   *
   * 실패해도 잠금 카운터를 올리지 않는다. TOTP는 양쪽 시계가 어긋나기만 해도
   * 틀리므로, 이걸 비밀번호 오류와 같이 세면 시계 문제로 계정이 잠긴다.
   * 실제 기관은 OTP 오류도 누적해 잠그는 곳이 있다. 그 차이는 README 한계에 적었다.
   */
  verifyOtp(account: Account, token: string): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    // otplib의 `epoch`은 **초** 단위다. 밀리초를 그대로 넘겨도 예외가 나지 않고
    // 생성·검증을 같은 값으로 하면 통과까지 해 버린다. 대신 진짜 인증 앱이
    // 만든 코드와는 영영 안 맞는다. 조용히 틀리는 자리라 여기서 나눠 둔다.
    const epochSec = Math.floor(this.#clock() / 1000);
    return verifySync({ secret: account.totpSecret, token, epoch: epochSec }).valid;
  }

  /** 측정을 다시 시작할 때 잠금과 실패 카운터를 되돌린다. */
  reset(): void {
    this.#failures.clear();
    this.#locked.clear();
  }
}
