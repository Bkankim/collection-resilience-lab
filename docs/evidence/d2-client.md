# D2 증거: 수집 클라이언트(세션·쿠키) 실측 기록

`collector/client/session.test.ts`가 같은 흐름을 CI에서 검증합니다. 거기서는
`buildApp({ clock })`을 `listen({ port: 0 })`으로 실제 포트에 띄우고 시계를 밀어 만료를
만듭니다. 이 파일은 **시계를 주입하지 않은 실제 대상 서버**(`target/server.ts`)에 undici로
붙어, 실제 시간이 흐르며 세션이 만료되는 상황에서 수집한 기록입니다.

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-23 |
| Node | v26.4.0 |
| undici | 8.10.2 |
| 서버 | `PORT=8081 pnpm tsx target/server.ts &` (새로 띄운 프로세스에 한 번에 채취, 끝나고 종료) |
| 계정 | `demo01` (리포에 공개된 실험용 고정 계정). 스크립트에는 로그인 ID만 넘기고 비밀은 `credentials.ts`가 찾는다 |
| 출발지 | 전부 `127.0.0.1` |

절마다 D1과 같이 **스위치 3개와 임계값 5개를 전부 명시**해 조건을 세웠고, 적용된 조건은
서버 응답 그대로 적었습니다. 요청 로그의 `+Nms`는 스크립트 시작부터 그 응답을 받은 시각입니다.

```sh
$ lsof -i :8081 || echo "8081 free"
8081 free
$ PORT=8081 pnpm tsx target/server.ts &
$ curl -s localhost:8081/health
{"ok":true}
$ pnpm -s tsx collect-live.mts http://localhost:8081
```

## 출력

```
POST /admin/reset -> 200 {"ok":true}
POST /admin/switches -> 200 {"switches":{"rateLimit":false,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}

## 1. 차단 없음: demo01 137건
  +    1ms POST /login                                           200 set-cookie
  +    4ms POST /auth/otp                                        200 set-cookie
  +   21ms GET  /transactions?account=000-11-222333&page=1       200 
  +   27ms GET  /transactions?account=000-11-222333&page=2       200 
  +   28ms GET  /transactions?account=000-11-222333&page=3       200 
  +   29ms GET  /transactions?account=000-11-222333&page=4       200 
  +   30ms GET  /transactions?account=000-11-222333&page=5       200 
  +   31ms GET  /transactions?account=000-11-222333&page=6       200 
  +   32ms GET  /transactions?account=000-11-222333&page=7       200 
  +   32ms GET  /transactions?account=000-11-222333&page=8       200 
결과: ok rows=137 pages=8 원장과 전 필드 일치=true
통계: {"logins":1,"reauths":0,"requests":10}
POST /admin/switches -> 200 {"switches":{"rateLimit":false,"ipBlock":false,"sessionExpiry":true},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":1}}

## 2. 세션 만료 S=1초, 거래내역 요청마다 400ms 대기
  +    0ms POST /login                                           200 set-cookie
  +    1ms POST /auth/otp                                        200 set-cookie
  +    1ms GET  /transactions?account=000-11-222333&page=1       200 
  +  407ms GET  /transactions?account=000-11-222333&page=2       200 
  +  811ms GET  /transactions?account=000-11-222333&page=3       200 
  + 1215ms GET  /transactions?account=000-11-222333&page=4       401 x-session-expired
  + 1617ms POST /login                                           200 set-cookie
  + 1619ms POST /auth/otp                                        200 set-cookie
  + 1622ms GET  /transactions?account=000-11-222333&page=4       200 
  + 2026ms GET  /transactions?account=000-11-222333&page=5       200 
  + 2432ms GET  /transactions?account=000-11-222333&page=6       200 
  + 2836ms GET  /transactions?account=000-11-222333&page=7       401 x-session-expired
  + 3238ms POST /login                                           200 set-cookie
  + 3239ms POST /auth/otp                                        200 set-cookie
  + 3240ms GET  /transactions?account=000-11-222333&page=7       200 
  + 3643ms GET  /transactions?account=000-11-222333&page=8       200 
결과: ok rows=137 pages=8 원장과 전 필드 일치=true
통계: {"logins":3,"reauths":2,"requests":16}

## 3. 세션 만료 S=1초, 1차 인증 뒤 1100ms 대기 (세션 수명 < 로그인 흐름)
  +    1ms POST /login                                           200 set-cookie
  + 1103ms POST /auth/otp                                        401 x-session-expired
결과: UNKNOWN "1차 인증 직후 2차 인증에서 세션 실패(HTTP 401 + X-Session-Expired). 재인증을 반복하지 않고 흐름 버그로 본다" raw=status 401
통계: {"logins":1,"reauths":0,"requests":2}
```

```sh
$ pkill -f "target/server.ts"; lsof -i :8081 || echo "8081 closed"
8081 closed
```

## 읽는 법

- **1절(M2 "세션을 유지하며 100건 수집").** 로그인 1회로 8페이지를 넘겨 137건을 모았고,
  대상 서버 원장(`buildLedger`)과 전 필드가 일치합니다. 8페이지는 행 0개의 빈 페이지이고,
  수집은 거기서 끝났습니다. 요청은 인증 2 + 거래내역 8 = 10건입니다.
- **2절(세션 만료 중 수집).** S=1초에 거래내역 요청 사이 400ms를 두면 세 요청째마다
  세션이 죽습니다. 4페이지와 7페이지가 `401 + x-session-expired`로 한 번씩 거절됐고,
  그때마다 재인증(`/login` → `/auth/otp`) 뒤 **거절된 그 페이지부터** 이어 갔습니다.
  1페이지부터 다시 긁지 않았습니다. 재인증 2회, 로그인 3회, 결과 137건은 1절과 같습니다.
- **3절(세션 수명이 로그인 흐름보다 짧은 경우).** 1차 인증 뒤 1100ms를 쉬면 2차 인증
  요청이 도착했을 때 이미 1차 세션이 만료돼 있습니다. 이때 SESSION_EXPIRED를 그대로
  돌려주면 워커가 재인증하고, 재인증도 같은 자리에서 막혀 끝없이 돕니다
  (SESSION_EXPIRED는 시도 횟수를 깎지 않습니다). 그래서 **UNKNOWN으로 올리고 원본을
  남기는 것이 정상 동작**입니다. 로그인은 1회로 끝났습니다. 대상 서버의 S는 1초 이상
  정수만 받으므로(`switches.ts` 검증), 흐름보다 짧은 수명은 클라이언트 쪽에서 쉬는
  방식으로 만들었습니다.

## 부록: 수집 스크립트 전문

스크립트는 리포 밖(작업용 임시 디렉터리)에 두고 리포 루트에서 실행했습니다. `.mts`인
이유는 `d2-classifier.md`에 적었습니다.

```ts
// 사용: pnpm tsx <이 파일> http://localhost:8081   (리포 루트에서, 대상 서버가 떠 있어야 한다)
import { setTimeout as sleep } from 'node:timers/promises';
import { CollectorSession } from '<리포>/collector/client/session.ts';
import { createUndiciTransport } from '<리포>/collector/client/transport.ts';
import type { Transport } from '<리포>/collector/client/transport.ts';
import { lookupCredentials } from '<리포>/collector/client/credentials.ts';
import { systemClock } from '<리포>/collector/client/clock.ts';
// 대조용으로만 대상 서버의 원장을 읽는다. 수집 경로는 HTTP뿐이다.
import { buildLedger } from '<리포>/target/transactions.ts';

const origin = process.argv[2]!;
const base = createUndiciTransport({ origin });
const creds = lookupCredentials('demo01', {})!;
const ACCOUNT = '000-11-222333';
const ledger = buildLedger(ACCOUNT, 137);

async function admin(path: string, body: unknown) {
  const res = await base({ method: 'POST', path, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if ('network' in res) throw new Error(res.network.message);
  console.log(`POST ${path} -> ${res.status} ${res.body.toString('utf8')}`);
}

/** 요청마다 한 줄 로그를 남기고, 지정한 경로 뒤에 실제 시간으로 잠든다. */
function logged(sleepAfter: (path: string) => number): Transport {
  const t0 = Date.now();
  return async (req) => {
    const res = await base(req);
    const status = 'network' in res ? `network ${res.network.code}` : String(res.status);
    const extra = 'network' in res ? '' : [res.headers['x-session-expired'] ? 'x-session-expired' : '', res.headers['set-cookie'] ? 'set-cookie' : ''].filter(Boolean).join(' ');
    console.log(`  +${String(Date.now() - t0).padStart(5)}ms ${req.method.padEnd(4)} ${req.path.padEnd(48)} ${status} ${extra}`);
    const ms = sleepAfter(req.path);
    if (ms > 0) await sleep(ms);
    return res;
  };
}

async function run(label: string, transport: Transport) {
  console.log(`\n## ${label}`);
  const session = new CollectorSession({ transport, credentials: creds, clock: systemClock });
  const result = await session.collect(ACCOUNT, '2026-01-01', '2026-12-31');
  if (result.ok) {
    const same = JSON.stringify(result.rows) === JSON.stringify(ledger);
    console.log(`결과: ok rows=${result.rows.length} pages=${result.pages} 원장과 전 필드 일치=${same}`);
  } else {
    console.log(`결과: ${result.kind} "${result.detail}" raw=${'raw' in result ? ('network' in result.raw ? 'network' : `status ${result.raw.status}`) : '-'}`);
  }
  console.log(`통계: ${JSON.stringify(session.stats)}`);
}

const ALL = { windowSec: 10, maxRequests: 5, blockAfter: 3, blockDurationSec: 30 };

await admin('/admin/reset', {});
await admin('/admin/switches', { switches: { rateLimit: false, ipBlock: false, sessionExpiry: false }, thresholds: { ...ALL, sessionTtlSec: 60 } });
await run('1. 차단 없음: demo01 137건', logged(() => 0));

await admin('/admin/switches', { switches: { rateLimit: false, ipBlock: false, sessionExpiry: true }, thresholds: { ...ALL, sessionTtlSec: 1 } });
await run('2. 세션 만료 S=1초, 거래내역 요청마다 400ms 대기', logged((p) => (p.startsWith('/transactions') ? 400 : 0)));

await run('3. 세션 만료 S=1초, 1차 인증 뒤 1100ms 대기 (세션 수명 < 로그인 흐름)', logged((p) => (p === '/login' ? 1100 : 0)));
process.exit(0);
```
