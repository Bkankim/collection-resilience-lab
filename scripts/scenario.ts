/**
 * 차단 시나리오 측정(#15). `pnpm scenario` 한 번으로 네 시나리오를 차례로 돌리고 결과표를 낸다.
 *
 * 전제: `docker compose up -d`로 대상 서버(`target`, 호스트 8080), 출발지 프록시 두 개(3128, 3129), redis(6379)가 떠 있다.
 *
 * 시나리오마다 하는 일:
 * 1. 이 측정이 쓰는 Redis DB(기본 15)에서 큐·DLQ·결과·진행·차단기 키를 지운다.
 * 2. 대상 서버를 `/admin/reset`으로 초기화하고, 스위치 3개와 임계값 5개를 **전부 명시해** 세운다.
 *    `reset`은 임계값을 지우지 않고 설정은 병합이라, 빠뜨린 값은 앞 시나리오의 값이 남는다(d1-target-server.md).
 * 3. 워커 프로세스 2개(`collector/worker/index.ts`)를 띄운다. 출발지는 중계(`scenario/relay.ts`) 두 개이고, 중계는
 *    각자 제 프록시로만 보낸다.
 * 4. 수집 요청 API(`collector/api/server.ts`)에 작업 200건을 POST로 넣는다.
 * 5. 완료 + 실패 = 200이고 실패마다 DLQ 항목이 생길 때까지 기다린 뒤 워커를 끈다.
 *
 * Redis DB를 따로 쓰는 이유: API는 큐 이름이 `collections`로 고정이다. 같은 Redis를 다른 작업(테스트, 다른 측정)이
 * 같이 쓰므로 DB 0의 `collections`를 지우면 남의 상태를 지운다. DB 번호만 바꾸면 API·워커 코드를 건드리지 않고 갈라진다.
 *
 * 환경변수(측정에는 기본값을 쓴다. 바꾼 값은 결과 문서의 조건 표에 그대로 찍힌다):
 * - `SCENARIO_ONLY`: 쉼표로 나눈 시나리오 키만 돈다(`none,rate-limit,ip-block,session-expiry`).
 * - `SCENARIO_JOBS`: 작업 수. 기본 200.
 * - `SCENARIO_OUT`: 결과 디렉터리. 기본 `docs/results/<오늘 날짜>`.
 * - `SCENARIO_REDIS_URL`: 기본 `redis://127.0.0.1:6379/15`.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { COLLECTION_QUEUE, deadLetterQueueName, resultsKey } from '../collector/queue.js';
import type { DeadLetterData } from '../collector/queue.js';
import { buildLedger } from '../target/transactions.js';
import type { SwitchState, Thresholds } from '../target/switches.js';
import { RECOVERY_STREAK, formatRecovery, markdownTable, recoveryOf, throughputOf } from './scenario/metrics.js';
import type { Recovery, Terminal } from './scenario/metrics.js';
import { startRelay } from './scenario/relay.js';
import type { Relay, RelayRecord } from './scenario/relay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

const TARGET_ADMIN = 'http://127.0.0.1:8080';
/** 프록시가 푸는 대상 서버 주소(compose 네트워크 안의 이름). */
const TARGET_ORIGIN = 'http://target:8080';
const UPSTREAMS = [
  { origin: 'A', upstream: 'http://127.0.0.1:3128', address: '172.28.14.11' },
  { origin: 'B', upstream: 'http://127.0.0.1:3129', address: '172.28.14.12' },
] as const;
const WORKERS = ['w1', 'w2'] as const;
const API_PORT = 18090;

/**
 * 요청마다 넣는 고정 지연. 세션 만료(S=1초, 최소값)가 작업 안에서 일어나게 고른 값이다. 세션은 2차 인증 통과
 * 시각부터 재고(`target/sessions.ts`), 그 뒤 페이지 요청 8개가 150ms 간격이면 7페이지 요청이 1.05초에 닿아 만료된다.
 * 네 시나리오 모두 같은 값이다.
 */
const DELAY_MS = 150;

const LOGIN_ID = 'demo01';
const ACCOUNT_NO = '000-11-222333';
const TX_COUNT = 137;

const JOBS = positiveInt('SCENARIO_JOBS', 200);
const REDIS_URL = process.env.SCENARIO_REDIS_URL?.trim() || 'redis://127.0.0.1:6379/15';
const TODAY = new Date().toLocaleDateString('sv-SE');
const OUT = process.env.SCENARIO_OUT?.trim() || join(ROOT, 'docs', 'results', TODAY);
const SCENARIO_TIMEOUT_MS = 8 * 60_000;

type Scenario = { key: string; name: string; switches: SwitchState; thresholds: Thresholds; why: string };

/**
 * 임계값. 스위치가 꺼진 값도 전부 적는다(관리 API는 병합이라 적지 않으면 앞 시나리오 값이 남는다).
 * 공통 W=2초, N=20: 워커 2개가 150ms 지연으로 내는 요청은 초당 약 13개(2초에 약 26개)라 N=20이면 창이 실제로 찬다.
 * 두 워커의 로그인 비용(4요청)보다 넉넉히 커야 NO_PROGRESS로 가지 않는다(d3-origin.md 4절, N=4에서 전부 DLQ).
 */
const BASE: Thresholds = { windowSec: 2, maxRequests: 20, blockAfter: 2, blockDurationSec: 5, sessionTtlSec: 60 };
const OFF: SwitchState = { rateLimit: false, ipBlock: false, sessionExpiry: false };

const SCENARIOS: Scenario[] = [
  { key: 'none', name: '(1) 차단 없음', switches: OFF, thresholds: BASE, why: '기준선. 스위치 전부 끔' },
  {
    key: 'rate-limit',
    name: '(2) 속도 제한',
    switches: { ...OFF, rateLimit: true },
    thresholds: BASE,
    why: '창 2초에 20요청. 두 워커가 내는 속도(2초에 약 26)보다 작다',
  },
  {
    key: 'ip-block',
    name: '(3) 출발지 차단',
    switches: { ...OFF, rateLimit: true, ipBlock: true },
    thresholds: BASE,
    why: '속도 제한 위에 429 2회 누적이면 5초 차단. 차단은 속도 제한에 종속이라 둘 다 켠다. T=10초는 20건 시험 실행에서 0.35건/초라 200건이 10분 가까이 걸려 줄였다',
  },
  {
    key: 'session-expiry',
    name: '(4) 세션 만료',
    switches: { ...OFF, sessionExpiry: true },
    thresholds: { ...BASE, sessionTtlSec: 1 },
    why: 'S=1초(최소값). 요청 지연 150ms에서 작업마다 7페이지쯤에서 만료',
  },
];

type Event = Record<string, unknown> & { scenario: string; src: string };

type ScenarioResult = {
  scenario: Scenario;
  applied: unknown;
  startedAt: number;
  endedAt: number;
  timedOut: boolean;
  completed: number;
  failed: number;
  dlq: number;
  dlqKinds: Record<string, number>;
  resultsMatch: { matched: number; total: number };
  recovery: Recovery;
  throughput: number;
  failureStatus: Record<string, number>;
  sessionExpired: number;
  logins: number;
  rotations: number;
  exhausted: number;
  pauses: number;
  targetOrigins: Record<string, number>;
  requests: number;
};

const events: Event[] = [];
const say = (message: string) => process.stderr.write(`[scenario] ${message}\n`);

async function main(): Promise<void> {
  const only = process.env.SCENARIO_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  const scenarios = only === undefined ? SCENARIOS : SCENARIOS.filter((s) => only.includes(s.key));
  if (scenarios.length === 0) throw new Error(`돌 시나리오가 없다: SCENARIO_ONLY=${process.env.SCENARIO_ONLY}`);

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  await redis.ping();
  await getJson(`${TARGET_ADMIN}/health`);

  let current = 'preflight';
  const relays: Relay[] = [];
  for (const u of UPSTREAMS) {
    relays.push(
      await startRelay({
        origin: u.origin,
        upstream: u.upstream,
        delayMs: DELAY_MS,
        onRecord: (record: RelayRecord) => events.push({ scenario: current, src: 'relay', ...record }),
      }),
    );
  }
  const relayName = new Map(relays.map((r, i) => [r.url, UPSTREAMS[i]!.origin]));
  // 중계를 거쳐 대상 서버 /health가 오는지(차단 판정을 지나가는 경로다) 먼저 본다.
  for (const [i, relay] of relays.entries()) {
    const status = await getViaProxy(relay.url, `${TARGET_ORIGIN}/health`);
    if (status !== 200) throw new Error(`출발지 ${UPSTREAMS[i]!.origin}(${UPSTREAMS[i]!.upstream})로 대상 서버에 닿지 않는다: ${status}`);
  }

  const api = spawnLogged('api', [TSX, 'collector/api/server.ts'], { PORT: String(API_PORT), HOST: '127.0.0.1', REDIS_URL }, () => {});
  const apiBase = `http://127.0.0.1:${API_PORT}`;
  await waitFor(async () => (await getJson(`${apiBase}/health`).catch(() => undefined)) !== undefined, 20_000, 'API /health');

  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      current = scenario.key;
      results.push(await runScenario(scenario, redis, relays, apiBase));
    }
  } finally {
    await stop(api.child);
    await Promise.all(relays.map((r) => r.close()));
    await redis.quit();
  }

  const report = render(results);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'events.jsonl'), events.map((e) => scrub(JSON.stringify(e, (_key, value) => (typeof value === 'string' ? (relayName.get(value) ?? value) : value)))).join('\n') + '\n');
  await writeFile(join(OUT, 'results.md'), scrub(report));
  process.stdout.write(report);
  say(`원시 출력: ${relative(ROOT, OUT)}/events.jsonl, results.md`);
}

async function runScenario(
  scenario: Scenario,
  redis: Redis,
  relays: Relay[],
  apiBase: string,
): Promise<ScenarioResult> {
  say(`${scenario.name} 시작`);
  await clearKeys(redis);

  await postJson(`${TARGET_ADMIN}/admin/reset`, {});
  const applied = await postJson(`${TARGET_ADMIN}/admin/switches`, { switches: scenario.switches, thresholds: scenario.thresholds });
  events.push({ scenario: scenario.key, src: 'runner', t: new Date().toISOString(), event: 'target-configured', applied });

  const workerEnv = {
    REDIS_URL,
    QUEUE_NAME: COLLECTION_QUEUE,
    TARGET_ORIGIN,
    WORKER_PROXIES: relays.map((r) => r.url).join(','),
  };
  const ready = new Set<string>();
  const workers = WORKERS.map((name) =>
    spawnLogged(name, [TSX, 'collector/worker/index.ts'], { ...workerEnv, WORKER_NAME: name }, (line) => {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        events.push({ scenario: scenario.key, src: `${name}-text`, t: new Date().toISOString(), line });
        return;
      }
      if (record.event === 'ready') ready.add(name);
      events.push({ scenario: scenario.key, src: 'worker', ...record });
    }),
  );
  await waitFor(async () => ready.size === WORKERS.length, 30_000, '워커 ready');

  // BullMQ는 넘겨받은 연결을 닫지 않는다. 직접 닫지 않으면 프로세스가 끝나지 않는다.
  const queueConnection = redis.duplicate();
  const deadConnection = redis.duplicate();
  const queue = new Queue(COLLECTION_QUEUE, { connection: queueConnection });
  const dead = new Queue<DeadLetterData>(deadLetterQueueName(COLLECTION_QUEUE), { connection: deadConnection });

  const startedAt = Date.now();
  events.push({ scenario: scenario.key, src: 'runner', t: new Date(startedAt).toISOString(), event: 'enqueue-start', jobs: JOBS });
  const jobIds: string[] = [];
  for (let i = 0; i < JOBS; i++) {
    const res = await fetch(`${apiBase}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: LOGIN_ID, accountNo: ACCOUNT_NO, from: '2026-01-01 00:00:00', to: periodEnd(i) }),
    });
    const body = (await res.json()) as { id?: string; status?: string };
    if (res.status !== 202 || body.id === undefined) throw new Error(`작업 투입 실패 ${i}: ${res.status} ${JSON.stringify(body)}`);
    if (body.status !== 'queued' && body.status !== 'running') throw new Error(`새 작업이 아니다(키 정리 실패?): ${JSON.stringify(body)}`);
    jobIds.push(body.id);
  }
  events.push({ scenario: scenario.key, src: 'runner', t: new Date().toISOString(), event: 'enqueue-done', jobs: jobIds.length });

  let timedOut = false;
  let counts = { completed: 0, failed: 0, dlq: 0 };
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let lastSay = 0;
  for (;;) {
    const c = await queue.getJobCounts('completed', 'failed');
    const dlq = await dead.count();
    counts = { completed: c.completed ?? 0, failed: c.failed ?? 0, dlq };
    if (counts.completed + counts.failed >= JOBS && counts.dlq >= counts.failed) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    if (Date.now() - lastSay > 15_000) {
      lastSay = Date.now();
      say(`${scenario.key}: 완료 ${counts.completed} 실패 ${counts.failed} DLQ ${counts.dlq} (${Math.round((Date.now() - startedAt) / 1000)}초)`);
    }
    await sleep(250);
  }
  // 마지막 사건 줄이 파이프를 지나올 여유를 두고 끈다.
  await sleep(500);
  await Promise.all(workers.map((w) => stop(w.child)));

  const mine = events.filter((e) => e.scenario === scenario.key);
  const workerEvents = mine.filter((e) => e.src === 'worker');
  const relayEvents = mine.filter((e) => e.src === 'relay') as unknown as (Event & RelayRecord)[];
  const terminals: Terminal[] = workerEvents
    .filter((e) => e.event === 'completed' || e.event === 'dead-letter')
    .map((e) => ({ at: Date.parse(String(e.t)), jobId: String(e.jobId), ok: e.event === 'completed' }));
  const endedAt = terminals.length === 0 ? Date.now() : Math.max(...terminals.map((t) => t.at));
  const failures = relayEvents.filter((r) => r.status < 200 || r.status >= 300);
  const failureStatus: Record<string, number> = {};
  for (const f of failures) failureStatus[f.status] = (failureStatus[f.status] ?? 0) + 1;

  const deadJobs = await dead.getJobs(['waiting', 'delayed', 'prioritized', 'active', 'completed', 'failed']);
  const dlqKinds: Record<string, number> = {};
  for (const j of deadJobs) dlqKinds[String(j.data.kind)] = (dlqKinds[String(j.data.kind)] ?? 0) + 1;

  const completedJobs = await queue.getJobs(['completed']);
  let matched = 0;
  for (const job of completedJobs) {
    const d = job.data as { accountNo: string; from: string; to: string };
    const expected = buildLedger(d.accountNo, TX_COUNT).filter((r) => r.at >= d.from && r.at <= d.to).length;
    if ((await redis.hlen(resultsKey(COLLECTION_QUEUE, job.id!))) === expected) matched++;
  }
  await queue.close();
  await dead.close();
  await Promise.all([queueConnection.quit(), deadConnection.quit()]);

  const targetOrigins = await targetOriginsBetween(startedAt - 500, endedAt + 500);
  const count = (name: string) => workerEvents.filter((e) => e.event === name).length;
  const result: ScenarioResult = {
    scenario,
    applied,
    startedAt,
    endedAt,
    timedOut,
    ...counts,
    dlqKinds,
    resultsMatch: { matched, total: completedJobs.length },
    recovery: recoveryOf(failures.map((f) => Date.parse(f.t)), terminals),
    throughput: throughputOf(counts.completed, startedAt, endedAt),
    failureStatus,
    sessionExpired: relayEvents.filter((r) => r.sessionExpired).length,
    logins: relayEvents.filter((r) => r.path === '/login').length,
    rotations: count('origin-rotated'),
    exhausted: count('origins-exhausted'),
    pauses: count('rate-limited'),
    targetOrigins,
    requests: relayEvents.length,
  };
  events.push({ scenario: scenario.key, src: 'runner', t: new Date().toISOString(), event: 'summary', ...summaryOf(result) });
  say(`${scenario.name} 끝: 완료 ${result.completed} 실패 ${result.failed} DLQ ${result.dlq} ${((endedAt - startedAt) / 1000).toFixed(1)}초${timedOut ? ' (시간 초과)' : ''}`);
  return result;
}

function summaryOf(r: ScenarioResult): Record<string, unknown> {
  const { scenario, ...rest } = r;
  return { name: scenario.name, ...rest };
}

/** 작업마다 다른 기간 끝(초 단위). 기간 시작은 같아 원장 137행 전부가 들어간다. 작업 ID는 기간으로 갈린다. */
function periodEnd(i: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `2026-09-01 00:${pad(Math.floor(i / 60))}:${pad(i % 60)}`;
}

async function clearKeys(redis: Redis): Promise<void> {
  const patterns = [`bull:${COLLECTION_QUEUE}:*`, `bull:${deadLetterQueueName(COLLECTION_QUEUE)}:*`, `results:${COLLECTION_QUEUE}:*`, `progress:${COLLECTION_QUEUE}`, `authblock:${COLLECTION_QUEUE}:*`];
  for (const match of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 1000);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** 대상 서버 로그(compose)에서 그 구간에 들어온 수집 요청의 출발지 주소별 수. 관리 API·health는 뺀다. */
async function targetOriginsBetween(from: number, to: number): Promise<Record<string, number>> {
  const { stdout } = await promisify(execFile)(
    'docker',
    ['compose', 'logs', '--no-log-prefix', '--since', new Date(from).toISOString(), '--until', new Date(to).toISOString(), 'target'],
    { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 },
  );
  const byAddress: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    if (!line.includes('incoming request')) continue;
    try {
      const o = JSON.parse(line) as { req?: { url?: string; remoteAddress?: string } };
      const path = o.req?.url?.split('?')[0] ?? '';
      if (path === '/health' || path.startsWith('/admin')) continue;
      const address = o.req?.remoteAddress ?? 'unknown';
      byAddress[address] = (byAddress[address] ?? 0) + 1;
    } catch {
      // JSON이 아닌 줄은 넘긴다.
    }
  }
  return byAddress;
}

function render(results: ScenarioResult[]): string {
  const sw = (s: SwitchState) => (Object.entries(s).filter(([, on]) => on).map(([k]) => k).join(' + ') || '없음');
  const th = (t: Thresholds) => `${t.windowSec} / ${t.maxRequests} / ${t.blockAfter} / ${t.blockDurationSec} / ${t.sessionTtlSec}`;
  const kinds = (k: Record<string, number>) => (Object.keys(k).length === 0 ? '-' : Object.entries(k).map(([kind, n]) => `${kind} ${n}`).join(', '));
  const main = markdownTable(
    ['시나리오', '켠 스위치', 'W / N / M / T / S', 'n', '성공률', `회복 시간`, '처리량(건/초)', '소요(초)'],
    results.map((r) => [
      r.scenario.name + (r.timedOut ? ' (시간 초과)' : ''),
      sw(r.scenario.switches),
      th(r.scenario.thresholds),
      '1',
      `${((r.completed / JOBS) * 100).toFixed(1)}% (${r.completed}/${JOBS})`,
      formatRecovery(r.recovery),
      r.throughput.toFixed(2),
      ((r.endedAt - r.startedAt) / 1000).toFixed(1),
    ]),
  );
  const detail = markdownTable(
    ['시나리오', '완료 / 실패 / DLQ', 'DLQ 종류', '실패 응답(상태별)', '세션 만료 응답', '로그인 요청', '출발지 전환', '모두 막힘', '큐 정지', '결과 = 원장', '대상 서버가 본 출발지'],
    results.map((r) => [
      r.scenario.name,
      `${r.completed} / ${r.failed} / ${r.dlq}`,
      kinds(r.dlqKinds),
      kinds(r.failureStatus),
      String(r.sessionExpired),
      `${r.logins} (작업 수 대비 +${r.logins - JOBS})`,
      String(r.rotations),
      String(r.exhausted),
      String(r.pauses),
      `${r.resultsMatch.matched}/${r.resultsMatch.total}`,
      Object.entries(r.targetOrigins).map(([a, n]) => `${a} ${n}`).join(', ') || '-',
    ]),
  );
  const why = markdownTable(['시나리오', '임계값을 고른 이유'], results.map((r) => [r.scenario.name, r.scenario.why]));
  return `# 차단 시나리오 측정 결과 (#15)

측정일 ${TODAY}. \`pnpm scenario\` 한 번의 출력입니다. 원시 사건 로그는 같은 디렉터리의 \`events.jsonl\`입니다.

## 측정 조건

| 항목 | 값 |
|---|---|
| 작업 | ${JOBS}건. 모두 ${LOGIN_ID} / ${ACCOUNT_NO}, 기간 시작 2026-01-01, 끝은 작업마다 1초씩 다르다(원장 ${TX_COUNT}행 전부, 7페이지 + 빈 8페이지) |
| 투입 | 수집 요청 API(\`collector/api/server.ts\`, 127.0.0.1:${API_PORT})에 POST |
| 워커 | ${WORKERS.length}개 프로세스(\`collector/worker/index.ts\`), 각 concurrency 1, limiter·진행 기반 상한 기본값 |
| 출발지 | ${UPSTREAMS.length}개. 워커 -> 중계(요청마다 ${DELAY_MS}ms 지연) -> tinyproxy(${UPSTREAMS.map((u) => `${u.origin} ${u.address}`).join(', ')}) -> 대상 서버 |
| 요청 지연 | 네 시나리오 모두 ${DELAY_MS}ms 고정. 세션 만료(S=1초)가 작업 안에서 일어나게 넣은 인위적 값이다 |
| 대상 서버 | compose \`target\`. 시나리오마다 \`/admin/reset\` 뒤 스위치 3개·임계값 5개를 전부 명시 |
| Redis | compose redis, DB ${new URL(REDIS_URL).pathname.slice(1) || '0'}. 시나리오마다 큐·DLQ·결과·진행 키를 지운다 |
| 반복 | 시나리오당 1회(n=1) |

## 결과

${main}

${detail}

${why}

## 지표 정의

- **성공률** = 완료(completed) 작업 수 / 투입 작업 수(${JOBS}).
- **회복 시간** = 첫 실패 응답 시각부터, 그 뒤 끝난 순서로 작업 ${RECOVERY_STREAK}건이 연달아 완료된 시각까지. 첫 실패 응답은 중계가 본 첫
  비 2xx 응답(429, 403, 401)이다. 작업이 실패로 끝난 것을 세지 않는 이유: 이 설계는 속도 제한·차단에서 작업을 버리지 않아
  작업 단위 실패가 거의 없다. 연속을 끊는 것은 DLQ로 간 작업이다. 실패 응답이 없으면 "해당 없음".
- **처리량** = 완료 작업 수 / 소요 시간. 소요 시간은 첫 작업을 넣기 직전부터 마지막 작업이 끝난 사건(\`completed\`·\`dead-letter\`)까지.
- 실패 응답(상태별)·세션 만료 응답·로그인 요청은 중계가 본 응답 수다. 502는 중계가 upstream에 닿지 못해 만든 응답이고 \`events.jsonl\`에 \`relayError\`가 붙는다. 세션 만료 응답은 401 + \`X-Session-Expired\`.
- 출발지 전환 = 워커 \`origin-rotated\` 수, 모두 막힘 = \`origins-exhausted\` 수, 큐 정지 = \`rate-limited\` 수(워커가 큐 전체를 멈춘 횟수. 두 워커가 같은 순간 각각 멈추면 2).
- 결과 = 원장: 완료 작업마다 결과 해시 행 수(HLEN)가 대상 서버 원장의 그 기간 행 수와 같은 작업 수 / 완료 작업 수.
- 대상 서버가 본 출발지: 그 구간 대상 서버 로그의 수집 요청 \`remoteAddress\`별 수(관리 API·health 제외). 로그 시각은 VM 시계(호스트보다 0.1~0.2초 앞섬)라 앞뒤 0.5초를 더 본다.
- M(blockAfter)에는 기간이 없다. 차단 해제나 설정 변경 전까지 429가 누적된다(\`target/switches.ts\`).
`;
}

type Spawned = { child: ChildProcess };

function spawnLogged(name: string, argv: string[], env: Record<string, string>, onLine: (line: string) => void): Spawned {
  // 물려받은 워커 설정이 측정 조건을 조용히 바꾸지 않게 뺀다(기본값으로 잰다).
  const base = { ...process.env };
  for (const key of ['WORKER_CONCURRENCY', 'WORKER_LIMIT_MAX', 'WORKER_LIMIT_DURATION_MS', 'WORKER_NO_PROGRESS_CYCLES', 'QUEUE_NAME', 'WORKER_PROXIES']) delete base[key];
  const child = spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout! }).on('line', onLine);
  createInterface({ input: child.stderr! }).on('line', (line) => say(`${name} stderr: ${line}`));
  return { child };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getViaProxy(proxy: string, target: string): Promise<number> {
  const { request } = await import('node:http');
  const p = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, path: target, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what}를 ${timeoutMs}ms 안에 보지 못했다`);
    await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 커밋하는 원시 출력에 절대 경로가 들어가지 않게 리포 경로와 홈 경로를 바꾼다. */
function scrub(text: string): string {
  return text.split(ROOT).join('.').split(homedir()).join('~');
}

function positiveInt(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key}는 1 이상의 정수여야 한다: ${raw}`);
  return value;
}

await main();
