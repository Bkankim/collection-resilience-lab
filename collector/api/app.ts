/**
 * 수집 요청 API. 요청을 큐에 넣고 작업 ID를 바로 돌려준다. 결과는 상태 조회로 받는다.
 *
 * 수집 한 건은 로그인·2차 인증·페이지 넘김으로 초 단위가 걸리고, 차단을 만나면 분 단위로
 * 늘어난다. 요청을 받은 자리에서 기다리면 호출하는 쪽의 타임아웃이 수집 시간에 묶인다.
 *
 * 이 파일은 큐에 넣고 읽기만 한다. 수집은 워커(#13)가 한다.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

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
  logger?: boolean;
};

/** 호출하는 쪽에 보이는 상태. BullMQ 상태 일곱 가지를 네 가지로 줄인다. */
export type CollectionStatus = 'queued' | 'running' | 'completed' | 'failed';

export type CollectionView = {
  id: string;
  status: CollectionStatus;
  request: CollectionJobData;
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
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({ ok: true }));

  app.post('/collections', async (request, reply) => {
    const parsed = parseRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'BAD_REQUEST', detail: parsed.detail });

    const data = parsed.data;
    const jobId = jobIdOf(data.accountNo, data.from, data.to);
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
    if (!/^col_[0-9a-f]{32}$/.test(id)) return reply.code(404).send({ error: 'NOT_FOUND', id });

    // **상태를 먼저 읽고 작업을 나중에 읽는다.** 반대로 하면 처리중일 때 읽은 작업(실패
    // 사유 없음, attemptsMade 0)에 그 사이 바뀐 상태(failed)를 붙여 "실패인데 사유가 없다"는
    // 응답이 나온다. 테스트 15회 반복에서 4회 재현했다(TROUBLESHOOTING 3번). 이 순서면
    // 완료·실패는 끝난 상태라 뒤에 읽은 작업이 그 상태와 맞고, 처리중으로 읽었는데 작업이
    // 그새 끝났다면 처리중으로 답할 뿐이다. 다음 조회가 끝난 상태를 보여 준다.
    const status = toStatus(await queue.getJobState(id));
    const job = status === undefined ? undefined : await queue.getJob(id);
    if (job === undefined || status === undefined) return reply.code(404).send({ error: 'NOT_FOUND', id });

    return reply.send(await view(job, status));
  });

  async function view(job: Job<CollectionJobData>, status: CollectionStatus): Promise<CollectionView> {
    const base: CollectionView = {
      id: job.id as string,
      status,
      request: job.data,
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
export function parseRequest(body: unknown): Parsed {
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
  // 계좌번호는 숫자와 하이픈. 대상 서버 모양(000-11-222333)보다 넓게 받는다. 없는 계좌는
  // 수집에서 드러나고, 여기서 좁히면 다른 대상을 붙일 때 API를 고쳐야 한다.
  if (typeof accountNo !== 'string' || !/^\d[\d-]{0,30}\d$/.test(accountNo)) {
    return { ok: false, detail: 'accountNo는 숫자와 하이픈으로 된 2~32자 문자열이어야 한다' };
  }
  const period = normalizePeriod(record.from, record.to);
  if (!period.ok) return period;
  return { ok: true, data: { loginId, accountNo, from: period.from, to: period.to } };
}
