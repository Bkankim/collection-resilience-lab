/**
 * 수집 요청 API. 요청을 큐에 넣고 작업 ID를 바로 돌려준다. 결과는 상태 조회로 받는다.
 *
 * 수집 한 건은 로그인·2차 인증·페이지 넘김으로 초 단위가 걸리고, 차단을 만나면 분 단위로
 * 늘어난다. 요청을 받은 자리에서 기다리면 호출하는 쪽의 타임아웃이 수집 시간에 묶인다.
 *
 * 이 파일은 큐에 넣고 읽기만 한다. 수집은 워커(#13)가 한다.
 */

import { STATUS_CODES } from 'node:http';

import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { systemClock } from '../client/clock.js';
import type { Clock } from '../client/clock.js';
import type { Transaction } from '../client/parse.js';
import {
  COLLECT_JOB,
  COLLECT_JOB_OPTIONS,
  jobIdOf,
  normalizePeriod,
  parseFailedReason,
  readResults,
} from '../queue.js';
import type { CollectionJobData, RecordedFailure } from '../queue.js';

export type BuildApiOptions = {
  queue: Queue<CollectionJobData>;
  /** 결과 저장소를 읽는 연결. 큐와 같은 연결이어도 된다. */
  redis: Redis;
  /**
   * 끝나지 않은 기간을 거절할 때 "지금"을 읽는 시계. 테스트가 시각을 소유하려고 주입한다.
   * 기본은 실제 시계.
   */
  clock?: Clock;
  /** true면 표준 출력, 객체면 그 스트림으로 로그를 쓴다. 테스트가 로그 내용을 보려고 쓴다. */
  logger?: boolean | { stream: { write(line: string): void } };
  /**
   * **테스트 전용.** 상태 조회에서 상태를 읽은 뒤·작업을 읽기 전에 부른다. 두 읽기 사이에
   * 작업 상태가 바뀌는 경쟁(TROUBLESHOOTING 3번)을 확률이 아니라 결정적으로 재현하려고 둔다.
   */
  betweenReads?: (id: string) => Promise<void>;
};

/** 호출하는 쪽에 보이는 상태. BullMQ 상태 일곱 가지를 네 가지로 줄인다. */
export type CollectionStatus = 'queued' | 'running' | 'completed' | 'failed';

export type CollectionView = {
  id: string;
  status: CollectionStatus;
  /** 요청 네 필드만. 워커가 작업 데이터에 남기는 체크포인트(#19)는 싣지 않는다. */
  request: Pick<CollectionJobData, 'loginId' | 'accountNo' | 'from' | 'to'>;
  /** 지금까지 시도 횟수를 깎은 실패 수. 재시도 대기 중이면 0보다 크다. */
  attemptsMade: number;
  result?: { count: number; rows: Transaction[] };
  failure?: RecordedFailure;
};

/**
 * BullMQ 상태를 호출하는 쪽의 상태로 옮긴다. 없는 작업(`unknown`)은 undefined다.
 *
 * `delayed`를 대기로 본다. 재시도 백오프 중인 작업이 여기 있다. 실패했지만 아직 끝난 것이
 * 아니므로 실패로 보이면 호출하는 쪽이 멈춘다. `prioritized`·`waiting-children`은 지금은
 * 쓰지 않지만, 쓰게 되어도 "아직 시작 안 함"이라는 뜻은 같다.
 */
export function toStatus(state: string): CollectionStatus | undefined {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'prioritized':
    case 'waiting-children':
      return 'queued';
    case 'active':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

export function buildApi(options: BuildApiOptions): FastifyInstance {
  const { queue, redis } = options;
  const clock = options.clock ?? systemClock;
  const app = Fastify({ logger: loggerOptions(options.logger) });

  // 거절 응답을 한 모양(`{ error, detail }`)으로 모은다. 없으면 본문 파싱 실패·크기 초과는
  // Fastify 기본 모양(`statusCode`, `code`, `message`)으로 나가고 검증 실패는 이 API 모양으로
  // 나가서, 호출하는 쪽이 두 모양을 다 읽어야 한다.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: errorName(status), detail: error.message });
    }
    // 5xx는 내부 메시지를 내보내지 않는다. Redis 주소나 스크립트 오류가 호출자에게 간다.
    request.log.error(error);
    return reply.code(500).send({ error: 'INTERNAL', detail: '내부 오류' });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', detail: `${request.method} ${stripQuery(request.url)}` }),
  );

  app.get('/health', async () => ({ ok: true }));

  app.post('/collections', async (request, reply) => {
    // 쿼리스트링은 받지 않는다. 이 API가 쓰는 값은 전부 본문에 있고, `?password=`처럼 실려
    // 온 비밀은 접근 로그와 프록시 로그에 남는다. 조용히 무시하고 202를 주면 호출하는 쪽은
    // 그렇게 보내도 되는 줄 안다.
    if (request.url.includes('?')) {
      return reply.code(400).send({ error: 'BAD_REQUEST', detail: '쿼리스트링은 받지 않는다. 값은 본문에 싣는다' });
    }
    const parsed = parseRequest(request.body, clock());
    if (!parsed.ok) return reply.code(400).send({ error: 'BAD_REQUEST', detail: parsed.detail });

    const data = parsed.data;
    const jobId = jobIdOf(data.loginId, data.accountNo, data.from, data.to);
    await queue.add(COLLECT_JOB, data, { ...COLLECT_JOB_OPTIONS, jobId });

    // `add`가 돌려주는 Job은 믿지 않는다. 같은 ID가 이미 있으면 BullMQ는 아무것도 저장하지
    // 않지만, 돌려주는 객체에는 **이번에 넘긴** 데이터가 실려 있다(실측). 상태는 Redis에서
    // 다시 읽는다. 이미 완료·실패한 작업이면 그 상태가 그대로 보인다.
    const status = toStatus(await queue.getJobState(jobId));

    // add 직후인데 없을 수 있는 경우는 그 사이에 누가 지운 것뿐이다. 요청은 받아 들였으니
    // 202를 주고, 상태 조회가 404로 사실을 알린다.
    return reply
      .code(202)
      .header('Location', `/collections/${jobId}`)
      .send({ id: jobId, status: status ?? 'queued' });
  });

  app.get<{ Params: { id: string } }>('/collections/:id', async (request, reply) => {
    const { id } = request.params;
    // `col_`로 시작하지 않는 ID는 이 API가 만든 적이 없다. BullMQ에 넘기지 않고 끊는다.
    // 숫자 ID는 BullMQ가 자동 발급하는 모양이라, 넘기면 다른 경로로 들어간 작업이 보인다.
    if (!/^col_[0-9a-f]{32}$/.test(id)) return reply.code(404).send({ error: 'NOT_FOUND', detail: `작업이 없다: ${id}` });

    // **상태를 먼저 읽고 작업을 나중에 읽는다.** 반대로 하면 처리중일 때 읽은 작업(실패
    // 사유 없음, attemptsMade 0)에 그 사이 바뀐 상태(failed)를 붙여 "실패인데 사유가 없다"는
    // 응답이 나온다. 테스트 15회 반복에서 4회 재현했다(TROUBLESHOOTING 3번). 이 순서면
    // 완료·실패는 끝난 상태라 뒤에 읽은 작업이 그 상태와 맞고, 처리중으로 읽었는데 작업이
    // 그새 끝났다면 처리중으로 답할 뿐이다. 다음 조회가 끝난 상태를 보여 준다.
    const status = toStatus(await queue.getJobState(id));
    if (status !== undefined) await options.betweenReads?.(id);
    const job = status === undefined ? undefined : await queue.getJob(id);
    if (job === undefined || status === undefined) return reply.code(404).send({ error: 'NOT_FOUND', detail: `작업이 없다: ${id}` });

    return reply.send(await view(job, status));
  });

  async function view(job: Job<CollectionJobData>, status: CollectionStatus): Promise<CollectionView> {
    // 작업 데이터를 그대로 싣지 않는다. 워커가 페이지마다 체크포인트를 더하므로(#19), 그대로
    // 실으면 처리 중에 응답 모양이 바뀌고 워커 내부 상태가 호출하는 쪽에 드러난다.
    const { loginId, accountNo, from, to } = job.data;
    const base: CollectionView = {
      id: job.id as string,
      status,
      request: { loginId, accountNo, from, to },
      attemptsMade: job.attemptsMade,
    };
    if (status === 'completed') {
      const rows = await readResults(redis, queue.name, base.id);
      return { ...base, result: { count: rows.length, rows } };
    }
    if (status === 'failed') return { ...base, failure: parseFailedReason(job.failedReason) };
    return base;
  }

  return app;
}

type Parsed = { ok: true; data: CollectionJobData } | { ok: false; detail: string };

/**
 * 본문 검증. 비밀번호 같은 비밀이 본문에 오면 받지 않는다. 받아서 버리는 것보다 거절하는
 * 것이 호출하는 쪽에 "보내지 말라"는 신호가 된다. 큐 데이터에 비밀이 없다는 약속
 * (`queue.ts`)의 입구가 여기다.
 */
export function parseRequest(body: unknown, nowMs: number): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, detail: '본문은 JSON 객체여야 한다' };
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['loginId', 'accountNo', 'from', 'to']);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) return { ok: false, detail: `모르는 필드: ${extra.join(', ')}` };

  const { loginId, accountNo } = record;
  // 로그인 ID는 환경변수 이름(`credentials.ts`의 envKey)으로 바뀌므로 모양을 좁혀 둔다.
  if (typeof loginId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(loginId)) {
    return { ok: false, detail: 'loginId는 영숫자와 . _ - 로 된 1~64자 문자열이어야 한다' };
  }
  // 계좌번호는 숫자 묶음을 하이픈 하나로 이은 모양(000-11-222333). 묶음 수와 길이는 대상
  // 서버보다 넓게 받는다. 없는 계좌는 수집에서 드러나고, 좁히면 다른 대상을 붙일 때 API를
  // 고쳐야 한다. 하이픈 없는 표기(00011222333)는 거절한다. 대상 서버가 받지 않는 표기이고,
  // 어디서 끊을지는 은행마다 달라 정규화로 추측할 수 없다. 추측해서 틀리면 없는 계좌로
  // 수집이 돌고, 같은 계좌가 표기마다 다른 작업 ID를 얻는다.
  if (typeof accountNo !== 'string' || accountNo.length > 32 || !/^\d+(?:-\d+)+$/.test(accountNo)) {
    return { ok: false, detail: 'accountNo는 숫자 묶음을 하이픈 하나로 이은 32자 이하 문자열이어야 한다(예: 000-11-222333)' };
  }
  const period = normalizePeriod(record.from, record.to);
  if (!period.ok) return period;
  // 끝나지 않은 기간은 받지 않는다. 받으면 한 번 완료된 결과가 같은 작업 ID로 영구히
  // 돌아가서, 그 뒤에 생긴 거래가 영영 보이지 않는다(완료 작업을 지우지 않는 정책 때문).
  // 대상 서버의 거래일시는 UTC로 찍히므로(`target/transactions.ts`의 toISOString) 지금도
  // UTC로 적어 같은 형식끼리 비교한다.
  const now = formatUtc(nowMs);
  if (period.to > now) return { ok: false, detail: `to가 아직 지나지 않았다(끝나지 않은 기간): ${period.to} > 지금 ${now} UTC` };
  return { ok: true, data: { loginId, accountNo, from: period.from, to: period.to } };
}

/** epoch 밀리초를 `YYYY-MM-DD HH:mm:ss`(UTC)로. 기간 문자열과 같은 형식이라 문자열 비교가 된다. */
function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 400 → BAD_REQUEST, 413 → PAYLOAD_TOO_LARGE. 이 API의 다른 거절과 같은 표기로 맞춘다. */
function errorName(status: number): string {
  return (STATUS_CODES[status] ?? 'CLIENT_ERROR').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * 요청 로그에서 쿼리스트링을 뺀다. POST는 쿼리가 있으면 거절하지만 요청 로그는 핸들러보다
 * 먼저 찍히므로, 거절만으로는 `?password=`가 로그에 남는다. 다른 경로도 같은 이유로 뺀다.
 */
function loggerOptions(logger: BuildApiOptions['logger']) {
  if (logger === undefined || logger === false) return false;
  const serializers = {
    req: (req: FastifyRequest) => ({
      method: req.method,
      url: stripQuery(req.url),
      host: req.host,
      remoteAddress: req.ip,
    }),
  };
  return logger === true ? { serializers } : { serializers, stream: logger.stream };
}
