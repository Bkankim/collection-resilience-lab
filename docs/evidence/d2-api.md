# D2 증거: 수집 요청 API 실측 기록

`collector/api/app.test.ts`가 같은 흐름을 CI에서 검증합니다. 거기서는 `inject()`로 요청을
넣고 테스트 안에서 가짜 프로세서를 가진 워커를 띄워 완료·실패까지 봅니다. 이 파일은
**실제 포트에 띄운 API**(`collector/api/server.ts`)에 curl로 붙은 기록과, 멱등의 경계를
BullMQ에 직접 물어 본 기록입니다. 워커(#13)는 아직 없으므로 상태는 대기에서 멈춥니다.

#12 리뷰 반영 뒤 다시 채취했습니다. 처음 채취(커밋 3a74a14)는 작업 ID에서 로그인 ID를 빼고
"다른 로그인 ID로 보내도 같은 작업"을 정상 사례로 적었는데, 대상 서버가 로그인 하나에 계좌
하나를 묶기 때문에 틀린 결정이었습니다(`collector/queue.ts` `jobIdOf` 주석).

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-23 (KST, 서버 시각은 UTC 2026-09-22 22시대) |
| Node | v26.4.0 |
| bullmq / ioredis | 6.3.8 / 5.11.1 |
| Redis | `docker compose` redis:7-alpine (redis-cli 7.4.11, 영속화 끔), 채취 전 `collections` 큐 키 0개 |
| API | `PORT=8090 pnpm -s tsx collector/api/server.ts > api.log &` (큐 이름 `collections`, 새로 띄운 프로세스에 한 번에 채취, 끝나고 종료) |
| curl | 8.7.1 |

기간은 이미 끝난 8월을 씁니다. 끝나지 않은 기간(`to`가 지금 이후)은 400입니다(5절 셋째 줄).

```sh
$ lsof -i :8090 || echo "8090 free"
8090 free
$ PORT=8090 pnpm -s tsx collector/api/server.ts > api.log 2>&1 &
$ curl -s localhost:8090/health
{"ok":true}
$ bash api-live.sh
```

POST 결과의 첫 줄은 `상태 코드 응답시간 location=Location 헤더`, 둘째 줄은 본문입니다.

## 출력

```
## 1. 같은 로그인·계좌·기간 POST 두 번 (두 번째는 같은 기간 다른 표기)
202 0.006036s location=/collections/col_ee93244d6c7b0b857fc46d587270c92f
{"id":"col_ee93244d6c7b0b857fc46d587270c92f","status":"queued"}
202 0.002856s location=/collections/col_ee93244d6c7b0b857fc46d587270c92f
{"id":"col_ee93244d6c7b0b857fc46d587270c92f","status":"queued"}
## 2. 같은 계좌·기간을 다른 로그인(demo02)으로
202 0.002602s location=/collections/col_92422c460e6489a359a9f3a8f97b8992
{"id":"col_92422c460e6489a359a9f3a8f97b8992","status":"queued"}
## 3. 큐에 쌓인 작업
2
col_92422c460e6489a359a9f3a8f97b8992
col_ee93244d6c7b0b857fc46d587270c92f

## 4. 상태 조회 (워커 없음)
{"id":"col_ee93244d6c7b0b857fc46d587270c92f","status":"queued","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-08-01 00:00:00","to":"2026-08-31 23:59:59"},"attemptsMade":0}
200

## 5. 잘못된 요청
400 0.000849s location=
{"error":"BAD_REQUEST","detail":"from 값이 달력에 없는 시각이다: \"2026-02-30\""}
400 0.000996s location=
{"error":"BAD_REQUEST","detail":"from이 to보다 늦다: 2026-08-31 00:00:00 > 2026-08-01 23:59:59"}
400 0.000709s location=
{"error":"BAD_REQUEST","detail":"to가 아직 지나지 않았다(끝나지 않은 기간): 2026-09-30 23:59:59 > 지금 2026-09-22 22:06:13 UTC"}
400 0.000707s location=
{"error":"BAD_REQUEST","detail":"accountNo는 숫자 묶음을 하이픈 하나로 이은 32자 이하 문자열이어야 한다(예: 000-11-222333)"}
400 0.000968s location=
{"error":"BAD_REQUEST","detail":"accountNo는 숫자 묶음을 하이픈 하나로 이은 32자 이하 문자열이어야 한다(예: 000-11-222333)"}
400 0.000609s location=
{"error":"BAD_REQUEST","detail":"모르는 필드: password"}
400 0.000665s location=
{"error":"BAD_REQUEST","detail":"쿼리스트링은 받지 않는다. 값은 본문에 싣는다"}
400 0.001053s location=
{"error":"BAD_REQUEST","detail":"Body is not valid JSON but content-type is set to 'application/json'"}
400 0.000529s location=
{"error":"BAD_REQUEST","detail":"loginId는 영숫자와 . _ - 로 된 1~64자 문자열이어야 한다"}
2

## 6. 없는 ID, 없는 경로
{"error":"NOT_FOUND","detail":"작업이 없다: col_00000000000000000000000000000000"}
404
{"error":"NOT_FOUND","detail":"GET /nowhere"}
404
```

```sh
$ grep -c "demo-pass-01" api.log; grep -c "password" api.log
0
0
$ grep -o '"url":"[^"]*"' api.log | sort | uniq -c
  12 "url":"/collections"
   1 "url":"/collections/col_00000000000000000000000000000000"
   1 "url":"/collections/col_ee93244d6c7b0b857fc46d587270c92f"
   1 "url":"/health"
   1 "url":"/nowhere"
$ docker compose exec -T redis redis-cli client list | wc -l     # API 연결 + redis-cli 자신
       2
$ pkill -TERM -f "collector/api/server.ts"; sleep 1
$ pgrep -fl "collector/api/server.ts" || echo "no api process"
no api process
$ lsof -i :8090 || echo "8090 closed"
8090 closed
$ docker compose exec -T redis redis-cli client list | wc -l     # redis-cli 자신만
       1
```

## 멱등의 경계

API가 쓰는 작업 옵션(`COLLECT_JOB_OPTIONS`)과 완료 작업을 지우는 옵션을 나란히 두고, 같은 ID로
두 번 넣었을 때 BullMQ가 무엇을 하는지 봤습니다. 프로세서는 부른 횟수만 셉니다. 첫 작업이
끝난 뒤 두 번째를 넣고 500ms 기다렸습니다. 스크립트는 부록에 있습니다. 위 채취가 끝난 뒤
`collections` 큐 키를 지우고 돌렸습니다.

```
$ pnpm -s tsx boundary.mts
{"label":"keep-completed","stateAfterFirst":"completed","secondAddId":"col_a","secondAddReturnedData":{"n":2},"storedData":{"n":1},"stateNow":"completed","processorCalls":1}
{"label":"remove-on-complete","stateAfterFirst":"unknown","secondAddId":"col_a","secondAddReturnedData":{"n":2},"storedData":null,"stateNow":"unknown","processorCalls":2}
{"label":"keep-failed","stateAfterFirst":"failed","secondAddId":"col_a","secondAddReturnedData":{"n":2},"storedData":{"n":1},"stateNow":"failed","processorCalls":1}
"12345" -> Custom Id cannot be integers
"a:b" -> Custom Id cannot contain :
$ docker compose exec -T redis redis-cli dbsize
0
```

## 읽는 법

- **1절(멱등).** 같은 로그인이 `2026-08-01`~`2026-08-31`과 `2026-08-01 00:00:00`~`2026-08-31 23:59:59`로
  보낸 요청은 같은 기간이라 같은 작업 ID가 나왔습니다. 응답은 10ms 안에 왔습니다. 수집을 기다리지
  않는다는 뜻입니다(워커가 없으니 기다릴 수도 없습니다).
- **2·3절(로그인 ID가 다르면 다른 작업).** 같은 계좌·기간이라도 demo02의 요청은 다른 ID를 받고,
  대기열에는 작업이 2개입니다. 대상 서버는 로그인 하나에 계좌 하나를 묶으므로(다른 계좌 조회는
  403 ACCOUNT_MISMATCH), 같은 작업으로 합치면 권한 없는 로그인의 실패가 계좌 주인에게 옮거나 주인의
  결과가 권한 없는 로그인에게 샙니다. 이 전파가 막힌 것은 `app.test.ts`가 가짜 프로세서로 확인합니다.
- **4절(상태).** 워커가 없어서 `queued`에 머뭅니다. 기간은 정규화한 값으로 실렸습니다. 처리중·완료·
  실패는 워커가 있어야 보이므로 테스트(`app.test.ts`, 가짜 프로세서)가 맡습니다.
- **5절(400).** 달력에 없는 날짜, 거꾸로 된 기간, 끝나지 않은 기간, 하이픈이 연속된 계좌, 하이픈 없는
  계좌, 비밀번호 필드, 쿼리스트링, 깨진 JSON, 로그인 ID 없음이 전부 400이고 대기열 길이는 2 그대로입니다.
  - 끝나지 않은 기간을 받으면 한 번 완료된 결과가 같은 ID로 영구히 돌아가 그 뒤의 거래가 보이지
    않습니다. 비교 기준 "지금"은 대상 서버 거래일시와 같은 UTC입니다.
  - 깨진 JSON은 Fastify가 먼저 거절하는데, 응답 모양이 이 API의 다른 거절과 같은 `{ error, detail }`입니다.
  - `?password=`를 실은 POST도 거절되고, 요청 로그의 `url`에는 쿼리가 남지 않았습니다(`api.log`에
    `password` 0건). 요청 로그는 핸들러보다 먼저 찍히므로 거절만으로는 부족해서 로그 직렬화에서 뺍니다.
- **6절(404).** 없는 작업과 없는 경로도 같은 모양이고, 없는 경로의 `detail`에서도 쿼리를 뺐습니다.
- **멱등의 경계.** BullMQ는 "같은 ID가 **지금 있으면**" 새로 만들지 않을 뿐입니다.
  - 완료 작업이 남아 있으면(`keep-completed`) 두 번째 추가는 아무것도 바꾸지 않고 프로세서도
    다시 돌지 않습니다.
  - 완료 작업을 지우는 설정(`remove-on-complete`)이면 두 번째 추가가 같은 ID로 새 작업을
    만들고 프로세서가 **다시 돕니다**(2회). 그래서 API는 완료 작업을 지우지 않습니다.
  - 실패 작업이 남아 있으면(`keep-failed`) 같은 요청이 와도 실패로 남고 다시 돌지 않습니다.
    AUTH_FAILED를 요청만으로 다시 돌리면 계정이 잠기므로 이 동작을 그대로 씁니다. 실패가 남는
    작업이 로그인마다 따로라서, 한 로그인의 실패가 다른 로그인의 요청을 막지 않습니다.
  - 세 경우 모두 `add`가 **돌려준** 작업에는 두 번째 데이터(`{"n":2}`)가 실려 있지만 저장된
    것은 첫 데이터입니다. API가 `add`의 반환값을 믿지 않고 상태를 다시 읽는 이유입니다.
  - 정수로 읽히는 ID와 `:`가 든 ID는 거부됩니다. 작업 ID에 `col_` 접두사를 붙인 이유입니다.
- 작업이 지워진 뒤 다시 도는 경우에도 결과가 두 배가 되지 않게 하는 두 번째 겹(결과 해시의
  필드가 seq)은 워커(#13)에서 검증합니다.

## 남긴 것

- **503(큐가 죽어 있을 때)은 하지 않았습니다.** #12 코멘트(2026-09-22)에서 9/25 버퍼로
  잘랐습니다. Redis가 죽은 상태의 POST는 재어 보지 않았습니다. 그때 나가는 5xx는 내부 메시지 없이
  `{"error":"INTERNAL","detail":"내부 오류"}`인 것을 테스트가 확인합니다.

## 부록: 스크립트 전문

두 스크립트 모두 리포 밖(작업용 임시 디렉터리)에 두고 리포 루트에서 실행했습니다.

`api-live.sh`

```bash
#!/bin/bash
# 리포 루트에서 실행. Redis(6379)가 떠 있고 8090이 비어 있어야 한다.
# 기간은 채취일(2026-09-23) 기준으로 이미 끝난 8월을 쓴다. 끝나지 않은 기간은 400이다.
H='content-type: application/json'
post() { curl -s -o /tmp/api-body -w '%{http_code} %{time_total}s location=%header{location}\n' -X POST "localhost:8090/collections$2" -H "$H" -d "$1"; cat /tmp/api-body; echo; }
echo "## 1. 같은 로그인·계좌·기간 POST 두 번 (두 번째는 같은 기간 다른 표기)"
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-08-01","to":"2026-08-31"}'
ID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' /tmp/api-body)
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-08-01 00:00:00","to":"2026-08-31 23:59:59"}'
echo "## 2. 같은 계좌·기간을 다른 로그인(demo02)으로"
post '{"loginId":"demo02","accountNo":"000-11-222333","from":"2026-08-01","to":"2026-08-31"}'
echo "## 3. 큐에 쌓인 작업"
docker compose exec -T redis redis-cli llen bull:collections:wait
docker compose exec -T redis redis-cli lrange bull:collections:wait 0 -1
echo
echo "## 4. 상태 조회 (워커 없음)"
curl -s -w '\n%{http_code}\n' localhost:8090/collections/$ID
echo
echo "## 5. 잘못된 요청"
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-02-30","to":"2026-08-31"}'
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-08-31","to":"2026-08-01"}'
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-09-01","to":"2026-09-30"}'
post '{"loginId":"demo01","accountNo":"0--------1","from":"2026-08-01","to":"2026-08-31"}'
post '{"loginId":"demo01","accountNo":"00011222333","from":"2026-08-01","to":"2026-08-31"}'
post '{"loginId":"demo01","password":"demo-pass-01","accountNo":"000-11-222333","from":"2026-08-01","to":"2026-08-31"}'
post '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-08-01","to":"2026-08-31"}' '?password=demo-pass-01'
post '{"loginId":'
post '{"accountNo":"000-11-222333","from":"2026-08-01","to":"2026-08-31"}'
docker compose exec -T redis redis-cli llen bull:collections:wait
echo
echo "## 6. 없는 ID, 없는 경로"
curl -s -w '\n%{http_code}\n' localhost:8090/collections/col_00000000000000000000000000000000
curl -s -w '\n%{http_code}\n' 'localhost:8090/nowhere?password=demo-pass-01'
```

`boundary.mts`

```ts
// 멱등 경계 실측. 사용: pnpm -s tsx <이 파일>  (리포 루트, Redis 6379)
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { createRedis, COLLECT_JOB_OPTIONS } from '<리포>/collector/queue.ts';
const run = async (label: string, opts: object, fail = false) => {
  const name = `boundary-${label}`;
  const q = new Queue(name, { connection: createRedis('producer') });
  let calls = 0;
  const w = new Worker(name, async () => { calls++; if (fail) throw new UnrecoverableError('AUTH_FAILED: x'); return {}; }, { connection: createRedis('worker') });
  await q.add('collect', { n: 1 }, { ...opts, jobId: 'col_a' });
  await new Promise((r) => w.once(fail ? 'failed' : 'completed', r));
  const after1 = (await q.getJobState('col_a'));
  const second = await q.add('collect', { n: 2 }, { ...opts, jobId: 'col_a' });
  await new Promise((r) => setTimeout(r, 500));
  const stored = await q.getJob('col_a');
  console.log(JSON.stringify({ label, stateAfterFirst: after1, secondAddId: second.id, secondAddReturnedData: second.data, storedData: stored?.data ?? null, stateNow: await q.getJobState('col_a'), processorCalls: calls }));
  await w.close(); await q.obliterate({ force: true }); await q.close(); process.exitCode = 0;
};
await run('keep-completed', COLLECT_JOB_OPTIONS);
await run('remove-on-complete', { ...COLLECT_JOB_OPTIONS, removeOnComplete: true });
await run('keep-failed', COLLECT_JOB_OPTIONS, true);
const q = new Queue('boundary-shape', { connection: createRedis('producer') });
for (const id of ['12345', 'a:b']) await q.add('collect', {}, { jobId: id }).then(() => console.log(id, 'accepted'), (e) => console.log(JSON.stringify(id), '->', e.message));
await q.obliterate({ force: true }); await q.close();
process.exit(0);
```
