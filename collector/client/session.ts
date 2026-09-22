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

import { classify } from './classify.js';
import type { Classification, ClassifyInput, Failure, RawResponse } from './classify.js';
import type { Clock } from './clock.js';
import { CookieJar } from './cookies.js';
import { lookupCredentials } from './credentials.js';
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

  constructor(options: SessionOptions) {
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
    if (firstFailure !== undefined) return firstFailure;

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
        return promoteToUnknown(second, secondFailure, '1차 인증 직후 2차 인증에서 세션 실패');
      }
      return secondFailure;
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
    let fresh = false;
    if (!this.#authenticated) {
      const failure = await this.login();
      if (failure !== undefined) return failure;
      fresh = true;
    }

    const path = `/transactions?account=${encodeURIComponent(accountNo)}&page=${page}`;
    const first = await this.#get(path);
    if (!isSessionFailure(first.result)) return first.result;
    if (fresh) return promoteToUnknown(first.input, first.result, '로그인 직후 첫 요청이 세션 실패');

    this.#stats.reauths += 1;
    const failure = await this.login();
    if (failure !== undefined) return failure;

    const retry = await this.#get(path);
    if (isSessionFailure(retry.result)) {
      return promoteToUnknown(retry.input, retry.result, '재인증 직후 첫 요청이 다시 세션 실패');
    }
    return retry.result;
  }

  /**
   * 1페이지부터 빈 페이지가 나올 때까지 넘기고, 거래일시가 `[from, to]`(양끝 포함)인
   * 행만 남긴다. 날짜만 주면 `from`은 그날 00:00:00, `to`는 23:59:59로 읽는다.
   *
   * 끝을 `totalPages`가 아니라 빈 페이지로 판단한다. 분류기가 "행 0개 = 마지막 페이지
   * 이후"를 요약 줄과 맞춰 검증하므로 빈 페이지가 곧 끝이라는 신호가 확실하고, 파서가
   * 요약과 모순된 페이지를 PARSE_FAILED로 막으므로 끝나지 않는 루프도 없다.
   *
   * 실패하면 그 페이지의 분류 실패를 그대로 돌려준다. 대응은 워커(#13)가 FIRST_REMEDY로 한다.
   */
  async collect(accountNo: string, from: string, to: string): Promise<CollectResult> {
    const lower = normalizeBound(from, '00:00:00');
    const upper = normalizeBound(to, '23:59:59');
    const rows: Transaction[] = [];

    for (let page = 1; ; page += 1) {
      const result = await this.fetchPage(accountNo, page);
      if (!result.ok) return result;
      if (result.page.rows.length === 0) return { ok: true, rows, pages: page };
      // 거래일시 형식이 고정 길이 `YYYY-MM-DD HH:mm:ss`라 문자열 비교가 곧 시각 비교다.
      // 파서가 형식을 검증하므로 여기서 다시 보지 않는다.
      for (const row of result.page.rows) {
        if (row.at >= lower && row.at <= upper) rows.push(row);
      }
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
): Promise<CollectResult> {
  const credentials = lookupCredentials(loginId, deps.env);
  if (credentials === undefined) throw new RangeError(`자격증명을 찾을 수 없다: ${loginId}`);
  const session = new CollectorSession({ transport: deps.transport, clock: deps.clock, credentials });
  return session.collect(accountNo, from, to);
}
