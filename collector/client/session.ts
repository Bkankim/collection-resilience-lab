/**
 * 로그인 ID 하나의 세션. 로그인·2차 인증·쿠키 보관·세션 만료 시 재인증을 맡는다.
 *
 * 분류기(`classify.ts`)는 응답 하나만 보는 상태 없는 함수라 "방금 재인증했는데 또
 * 세션이 없다"를 알 수 없다. 그 판단은 직전에 무엇을 했는지 아는 이 층이 한다. 이 층이
 * 없으면 쿠키를 잘못 다루는 버그가 재인증 → 세션 없음 → 재인증으로 끝없이 돌고,
 * SESSION_EXPIRED는 시도 횟수를 깎지 않으므로 그 작업은 영영 DLQ에도 가지 않는다.
 *
 * 분류기 계약(#11): 거래내역 응답은 전부 분류기에 넣고, 인증 응답은 2xx가 아닐 때만
 * 넣는다. 인증 2xx 본문은 여기서 읽는다.
 */

import { generateSync } from 'otplib';

import { redactFailure } from './capture.js';
import { classify } from './classify.js';
import type { Classification, ClassifyInput, Failure, RawResponse } from './classify.js';
import type { Clock } from './clock.js';
import { CookieJar } from './cookies.js';
import { assertTotpSecret, lookupCredentials } from './credentials.js';
import type { Credentials } from './credentials.js';
import type { Transaction } from './parse.js';
import type { HttpRequest, Transport } from './transport.js';

export type SessionStats = {
  /** 로그인 흐름(1차+2차)을 시작한 횟수. 첫 로그인 포함. */
  logins: number;
  /** 세션 만료를 보고 다시 로그인한 횟수. */
  reauths: number;
  /** 보낸 요청 수. 인증 요청 포함. */
  requests: number;
};

export type SessionOptions = {
  transport: Transport;
  credentials: Credentials;
  clock: Clock;
  /** 테스트가 망가진 저장소를 넣어 흐름 버그를 재현하는 자리. 기본은 새 저장소. */
  jar?: CookieJar;
};

export type CollectResult = { ok: true; rows: Transaction[]; pages: number } | Failure;

/**
 * 이어받기(#19). 속도 제한·출발지 차단 창보다 큰 작업이 매 주기 로그인부터 다시 하며 끝나지
 * 않던 것(TROUBLESHOOTING 4번)을 워커가 풀 때 쓴다. 워커는 받은 페이지마다 행을 결과
 * 저장소에 쓰고 다음 페이지 번호를 작업 데이터에 남긴 뒤, 다시 시작할 때 그 번호를 넘긴다.
 */
export type CollectOptions = {
  /** 이 페이지부터 받는다. 기본 1. 로그인은 여기와 상관없이 다시 한다(세션 재사용은 범위 밖). */
  startPage?: number;
  /**
   * 페이지 상한(`totalPages + 1`). 이어받을 때 처음 실행이 잰 값을 넘긴다. 없으면 이번에 처음 받은
   * 페이지에서 잰다. 이어받을 때마다 새로 재면 총 건수가 계속 느는 서버에서 상한이 따라 늘어 멈추지
   * 않는다(#19 최종 리뷰 6).
   */
  maxPage?: number;
  /**
   * 빈 페이지가 아닌 페이지를 받을 때마다 부른다. 기간으로 거른 행과 그 페이지 번호다. 걸러서
   * 0행이 된 페이지에도 부른다. 부르지 않으면 이어받을 자리가 그 페이지 앞에 머물러,
   * 기간 밖 페이지가 많은 작업은 다시 시작할 때마다 같은 페이지를 또 받는다. 끝을 확인하는
   * 빈 페이지에는 부르지 않는다. 받은 행이 없고, 그 뒤는 곧 완료다.
   *
   * **돌아올 때까지 다음 페이지를 보내지 않는다.** 여기서 던지면 수집도 그 예외로 끝난다.
   * 워커가 결과·체크포인트를 쓰지 못했는데 다음 페이지로 넘어가면, 다시 시작한 쪽이 이어받을
   * 자리를 잃는다.
   */
  onPage?: (rows: Transaction[], page: number, maxPage?: number) => Promise<void>;
};

/** `YYYY-MM-DD` 또는 `YYYY-MM-DD HH:mm:ss`. 대상 서버의 거래일시 형식과 같다. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export class CollectorSession {
  readonly #transport: Transport;
  readonly #credentials: Credentials;
  readonly #clock: Clock;
  readonly #jar: CookieJar;
  #authenticated = false;
  readonly #stats: SessionStats = { logins: 0, reauths: 0, requests: 0 };

  /** TOTP 공유키가 틀리면 던진다. 요청을 하나도 보내기 전에 설정 오류를 드러낸다. */
  constructor(options: SessionOptions) {
    assertTotpSecret(options.credentials.loginId, options.credentials.totpSecret);
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#jar = options.jar ?? new CookieJar(options.clock);
  }

  get stats(): SessionStats {
    return { ...this.#stats };
  }

  get jar(): CookieJar {
    return this.#jar;
  }

  /**
   * 1차(비밀번호)와 2차(TOTP)를 통과한다. 성공하면 undefined, 실패하면 분류된 실패.
   *
   * 들고 있던 쿠키는 먼저 버린다. 대상 서버는 로그인할 때 딸려 온 세션을 폐기하므로
   * 보내도 해가 없지만, 남겨 두면 저장소에 죽은 식별자가 섞여 무엇이 오갔는지 읽기
   * 어려워진다.
   */
  async login(): Promise<Failure | undefined> {
    const failure = await this.#login();
    return failure === undefined ? undefined : redactFailure(failure);
  }

  async #login(): Promise<Failure | undefined> {
    this.#stats.logins += 1;
    this.#authenticated = false;
    this.#jar.clear();

    const first = await this.#send({
      method: 'POST',
      path: '/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.#credentials.loginId, password: this.#credentials.password }),
    });
    const firstFailure = this.#authStep(first, (body) => body.next === 'otp', '1차 인증');
    // 단계를 싣는다. 워커가 1차 인증의 UNKNOWN을 자격증명 문제일 수 있는 실패로 보고
    // 로그인 ID 단위로 막는 데 쓴다(`classify.ts` `AuthStage`).
    if (firstFailure !== undefined) return { ...firstFailure, authStage: 'login' };

    // otplib의 epoch은 **초** 단위다. 밀리초를 넘겨도 예외 없이 틀린 코드가 나온다
    // (target/accounts.ts의 같은 주석 참고).
    const token = generateSync({ secret: this.#credentials.totpSecret, epoch: Math.floor(this.#clock() / 1000) });
    const second = await this.#send({
      method: 'POST',
      path: '/auth/otp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const secondFailure = this.#authStep(second, (body) => body.level === 'FULL', '2차 인증');
    if (secondFailure !== undefined) {
      // 1차를 막 통과한 세션이 2차에서 세션 실패를 받았다. 재인증해도 같은 자리에서 또
      // 막힌다(세션 수명이 로그인 흐름보다 짧거나, 1차 쿠키를 못 들고 있거나). 재인증으로
      // 돌리면 무한 루프라 흐름 버그로 올린다.
      if (secondFailure.kind === 'SESSION_EXPIRED') {
        return { ...promoteToUnknown(second, secondFailure, '1차 인증 직후 2차 인증에서 세션 실패'), authStage: 'otp' };
      }
      return { ...secondFailure, authStage: 'otp' };
    }

    this.#authenticated = true;
    return undefined;
  }

  /**
   * 거래내역 한 페이지. 세션이 만료됐으면 재인증하고 **딱 한 번** 다시 보낸다.
   *
   * 재인증 직후의 첫 요청이 다시 세션 실패면 UNKNOWN으로 올린다. 방금 받은 세션이
   * 한 요청도 못 버틴다는 것은 서버가 세션을 비운 상황이 아니라 우리 쪽 흐름(쿠키
   * 저장·전송)이 틀렸다는 뜻이고, 다시 해도 같은 결과다.
   */
  async fetchPage(accountNo: string, page: number): Promise<Classification> {
    const { result } = await this.#fetchPage(accountNo, page);
    return result.ok ? result : redactFailure(result);
  }

  /** 원본까지 돌려준다. `collect`가 페이지 검증에 실패했을 때 원본을 실으려고 쓴다. */
  async #fetchPage(accountNo: string, page: number): Promise<{ input?: ClassifyInput; result: Classification }> {
    let fresh = false;
    if (!this.#authenticated) {
      const failure = await this.#login();
      if (failure !== undefined) return { result: failure };
      fresh = true;
    }

    const path = `/transactions?account=${encodeURIComponent(accountNo)}&page=${page}`;
    const first = await this.#get(path);
    if (!isSessionFailure(first.result)) return first;
    if (fresh) return { result: promoteToUnknown(first.input, first.result, '로그인 직후 첫 요청이 세션 실패') };

    this.#stats.reauths += 1;
    const failure = await this.#login();
    if (failure !== undefined) return { result: failure };

    const retry = await this.#get(path);
    if (isSessionFailure(retry.result)) {
      return { result: promoteToUnknown(retry.input, retry.result, '재인증 직후 첫 요청이 다시 세션 실패') };
    }
    return retry;
  }

  /**
   * 1페이지(이어받으면 `startPage`)부터 빈 페이지가 나올 때까지 넘기고, 거래일시가
   * `[from, to]`(양끝 포함)인 행만 남긴다. 날짜만 주면 `from`은 그날 00:00:00, `to`는 23:59:59로 읽는다.
   *
   * 끝을 `totalPages`가 아니라 빈 페이지로 판단한다. 분류기가 "행 0개 = 마지막 페이지
   * 이후"를 요약 줄과 맞춰 검증하므로 빈 페이지가 곧 끝이라는 신호가 확실하다.
   *
   * 다만 파서는 한 페이지 안의 일관성만 본다. 서버가 `?page=`를 무시하고 매번 1페이지를
   * 주면 그 응답은 그 자체로 멀쩡해서 빈 페이지가 영영 오지 않는다. 그래서 루프가 두
   * 가지를 더 본다. 받은 페이지가 **요청한 페이지·계좌인지**, 그리고 페이지 번호가
   * 이번에 처음 받은 페이지의 `totalPages + 1`을 넘지 않는지. 이어받으면 1페이지를 받지
   * 않으므로 상한은 시작한 페이지의 응답에서 잰다. 멀쩡한 서버라면 어느 페이지나 같은
   * `totalPages`를 싣는다. 뒤의 것은 총 건수가 매 페이지 늘어나는
   * 서버처럼 앞의 검사를 통과하면서도 끝나지 않는 경우를 막는 상한이다. 둘 다 흐름이나
   * 서버 계약이 깨진 것이라 UNKNOWN과 원본으로 넘긴다.
   *
   * 이어받는 호출은 처음 실행이 잰 상한(`options.maxPage`)을 받는다. 호출마다 새로 재면 매 주기 속도
   * 제한에 끊기면서 총 건수도 계속 느는 서버에서 상한이 따라 늘어 멈추지 않는다(#19 최종 리뷰 6). 잰
   * 상한은 `onPage`의 세 번째 인자로 알려 주고, 워커가 체크포인트에 남긴다.
   *
   * 실패하면 그 페이지의 분류 실패를 그대로 돌려준다. 대응은 워커(#13)가 FIRST_REMEDY로 한다.
   */
  async collect(accountNo: string, from: string, to: string, options: CollectOptions = {}): Promise<CollectResult> {
    const result = await this.#collect(accountNo, from, to, options);
    return result.ok ? result : redactFailure(result);
  }

  async #collect(accountNo: string, from: string, to: string, options: CollectOptions): Promise<CollectResult> {
    const lower = normalizeBound(from, '00:00:00');
    const upper = normalizeBound(to, '23:59:59');
    const rows: Transaction[] = [];
    let maxPage = options.maxPage;

    for (let page = options.startPage ?? 1; ; page += 1) {
      const { input, result } = await this.#fetchPage(accountNo, page);
      if (!result.ok) return result;
      // 성공은 분류기를 거친 응답에서만 나오므로 input이 항상 있다.
      const raw = input as ClassifyInput;
      if (result.page.page !== page || result.page.accountNo !== accountNo) {
        return {
          ok: false,
          kind: 'UNKNOWN',
          detail: `요청과 다른 페이지를 받았다: 요청 ${accountNo} ${page}페이지, 응답 ${result.page.accountNo} ${result.page.page}페이지`,
          raw,
        };
      }
      maxPage ??= result.page.totalPages + 1;
      if (result.page.rows.length === 0) return { ok: true, rows, pages: page };
      if (page >= maxPage) {
        return {
          ok: false,
          kind: 'UNKNOWN',
          detail:
            options.maxPage === undefined
              ? `이번에 처음 받은 페이지(${options.startPage ?? 1})의 totalPages + 1(${maxPage})페이지까지 빈 페이지가 오지 않았다`
              : `처음 실행이 잰 totalPages + 1(${maxPage})페이지까지 빈 페이지가 오지 않았다`,
          raw,
        };
      }
      // 거래일시 형식이 고정 길이 `YYYY-MM-DD HH:mm:ss`라 문자열 비교가 곧 시각 비교다.
      // 파서가 형식을 검증하므로 여기서 다시 보지 않는다.
      const kept = result.page.rows.filter((row) => row.at >= lower && row.at <= upper);
      rows.push(...kept);
      await options.onPage?.(kept, page, maxPage);
    }
  }

  async #get(path: string): Promise<{ input: ClassifyInput; result: Classification }> {
    const input = await this.#send({ method: 'GET', path });
    return { input, result: classify(input) };
  }

  /**
   * 모든 요청이 여기를 지난다. 응답의 `Set-Cookie`는 상태 코드를 보기 **전에** 저장한다.
   * 3xx·4xx에 실린 쿠키도 서버가 준 상태다. 리다이렉트는 따라가지 않는다. 대상 서버에
   * 리다이렉트가 없어서 따라가는 코드를 검증할 방법이 없고(#9 코멘트), 3xx는 분류기에서
   * UNKNOWN + 원본으로 드러난다.
   */
  async #send(req: HttpRequest): Promise<ClassifyInput> {
    this.#stats.requests += 1;
    const cookie = this.#jar.headerFor(req.path);
    const headers = { ...req.headers, ...(cookie === undefined ? {} : { cookie }) };
    const res = await this.#transport({ ...req, headers });
    if (!('network' in res)) this.#jar.store(res.headers['set-cookie'], req.path);
    return res;
  }

  /** 인증 응답 하나를 판정한다. 2xx면 본문을 여기서 읽고, 아니면 분류기로 보낸다. */
  #authStep(
    res: ClassifyInput,
    expected: (body: Record<string, unknown>) => boolean,
    step: string,
  ): Failure | undefined {
    if ('network' in res || res.status < 200 || res.status > 299) {
      const result = classify(res);
      // 분류기가 성공을 내는 것은 200뿐이라 여기로 올 수 없다. 타입을 좁히려고 둔다.
      if (result.ok) return { ok: false, kind: 'UNKNOWN', detail: `${step} 비2xx 응답이 성공으로 분류됐다`, raw: res };
      return result;
    }
    const body = readJson(res.body);
    if (body === undefined || !expected(body)) {
      return { ok: false, kind: 'UNKNOWN', detail: `${step} 2xx 본문이 예상과 다르다`, raw: res };
    }
    return undefined;
  }
}

function isSessionFailure(result: Classification): result is Failure {
  return !result.ok && result.kind === 'SESSION_EXPIRED';
}

function promoteToUnknown(raw: ClassifyInput, failure: Failure, reason: string): Failure {
  return {
    ok: false,
    kind: 'UNKNOWN',
    detail: `${reason}(${failure.detail}). 재인증을 반복하지 않고 흐름 버그로 본다`,
    raw,
  };
}

function normalizeBound(value: string, time: string): string {
  if (DATE_TIME.test(value)) return value;
  if (DATE_ONLY.test(value)) return `${value} ${time}`;
  // 형식이 틀린 기간은 수집 실패가 아니라 호출하는 쪽의 버그다. 조용히 빈 결과를
  // 돌려주면 "그 기간에 거래가 없었다"와 구분되지 않는다.
  throw new RangeError(`기간 형식은 YYYY-MM-DD 또는 YYYY-MM-DD HH:mm:ss여야 한다: ${JSON.stringify(value)}`);
}

function readJson(body: RawResponse['body']): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 로그인 ID만으로 수집한다. 큐 작업에는 로그인 ID만 싣고 비밀은 여기서 찾는다
 * (`credentials.ts` 머리 주석).
 *
 * 자격증명을 못 찾으면 던진다. 수집 실패가 아니라 배치 설정 오류라서 분류 일곱 종
 * 어디에도 맞지 않고, 재시도해도 풀리지 않는다.
 */
export async function collect(
  deps: { transport: Transport; clock: Clock; env?: Record<string, string | undefined> },
  loginId: string,
  accountNo: string,
  from: string,
  to: string,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const credentials = lookupCredentials(loginId, deps.env);
  if (credentials === undefined) throw new RangeError(`자격증명을 찾을 수 없다: ${loginId}`);
  const session = new CollectorSession({ transport: deps.transport, clock: deps.clock, credentials });
  return session.collect(accountNo, from, to, options);
}
