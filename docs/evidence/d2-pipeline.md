# D2 증거: 수집 파이프라인(API → 큐 → 워커 2개) 실측 기록

`collector/worker/process.test.ts`가 처분별 동작을 CI에서 검증합니다. 거기서는 대상 서버를
빈 포트에 띄우고 워커를 같은 프로세스에 둡니다. 이 파일은 **실제 포트에 띄운 대상 서버(8081)·
API(8090)와 별도 프로세스 워커 2개**에 curl로 요청을 넣은 기록입니다(D1 규칙).

M2 Exit의 "큐에 200건을 넣고 워커가 나눠 처리. 같은 작업을 두 번 넣어도 결과가 한 번만 쌓임"을
1·2절이, 이슈 #13의 "속도 제한은 워커 개별 대기가 아니라 큐 전체 정지, 시도 횟수를 깎지
않음"을 3절이 봅니다. 3절에서 **느슨한 limiter 기본값으로는 워커 2개가 서로의 창을 먹어
끝나지 않는 것**과 **요청 수가 창(N)보다 많은 작업은 limiter와 상관없이 끝나지 않는 것**이
나왔습니다(TROUBLESHOOTING 4번).

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-23 KST (로그 시각은 UTC 2026-09-22 22:19~22:24) |
| Node | v26.4.0 |
| bullmq / ioredis / undici | 6.3.8 / 5.11.1 / 8.10.2 |
| Redis | `docker compose` redis:7-alpine (7.4.11, 영속화 끔), 채취 전 `dbsize` 0 |
| 대상 서버 | `PORT=8081 tsx target/server.ts` (스위치 기본값 전부 꺼짐으로 시작) |
| API | `PORT=8090 tsx collector/api/server.ts` (큐 `collections`) |
| 워커 | `WORKER_NAME=w1`, `w2` 두 프로세스. `TARGET_ORIGIN=http://127.0.0.1:8081`, concurrency 1, limiter 기본 `{ max: 100, duration: 1000 }` (3-2절만 다름) |
| 출발지 | 전부 `127.0.0.1` (대상 서버가 보기에 출발지 하나) |
| curl | 8.7.1 |

작업 한 건이 대상 서버에 보내는 요청은 로그인 2개(`/login`, `/auth/otp`) + 거래내역 페이지 +
끝을 확인하는 빈 페이지 1개입니다. demo01(137건, 7페이지)은 10개, demo02(12건, 1페이지)는
4개입니다. 스크립트는 부록에 있습니다.

```sh
$ lsof -i :8081 -i :8090 || echo "8081/8090 free"
8081/8090 free
$ docker compose exec -T redis redis-cli dbsize
0
$ PORT=8081 nohup ./node_modules/.bin/tsx target/server.ts > target.log 2>&1 &
$ PORT=8090 nohup ./node_modules/.bin/tsx collector/api/server.ts > api.log 2>&1 &
$ WORKER_NAME=w1 TARGET_ORIGIN=http://127.0.0.1:8081 nohup ./node_modules/.bin/tsx collector/worker/index.ts > w1.log 2>&1 &
$ WORKER_NAME=w2 TARGET_ORIGIN=http://127.0.0.1:8081 nohup ./node_modules/.bin/tsx collector/worker/index.ts > w2.log 2>&1 &
$ curl -s localhost:8081/health; curl -s localhost:8090/health
{"ok":true}
{"ok":true}
$ cat w1.log w2.log
{"t":"2026-09-22T22:19:33.860Z","worker":"w1","pid":45140,"event":"ready","queue":"collections","origin":"http://127.0.0.1:8081","concurrency":1,"limiter":{"max":100,"duration":1000}}
{"t":"2026-09-22T22:19:33.860Z","worker":"w2","pid":45139,"event":"ready","queue":"collections","origin":"http://127.0.0.1:8081","concurrency":1,"limiter":{"max":100,"duration":1000}}
```

## 1. 200건을 넣고 워커 2개가 나눠 처리한다

요청 200건은 서로 다른 로그인·기간 조합입니다. demo01은 시작일 34가지 × 길이 1~3일로 100건,
demo02는 시작 6시간 칸 10가지 × 길이 1~10칸으로 100건. 모든 기간이 원장 안이라 결과가 0건인
작업은 없습니다(0건 작업은 결과 해시가 생기지 않아 "결과 키 수"로 셀 수 없습니다). 기대 행 수는
대상 서버 원장(`target/transactions.ts` `buildLedger`)으로 계산했습니다.

```sh
$ pnpm -s tsx bodies.mts . > bodies.jsonl
{"jobs":200,"distinct":200,"expectedRows":1255,"zeroRowJobs":0}
$ start=<지금 ms>; ./post-all.sh; echo "postMs=..."; ./poll.sh 200 $start
 192 202 queued
   8 202 running
distinct ids: 200
postMs=4297
completed=200 failed=0 elapsedMs=5044
$ for w in w1 w2; do echo "$w completed: $(grep -c '"event":"completed"' $w.log) other: ..."; done
w1 completed: 100 other: 0
w2 completed: 100 other: 0
$ ./results.sh
api statuses: {'completed': 200} rows(sum result.count)= 1255 attemptsMade= {1: 200}
result keys=200 rows(sum HLEN)=1255
$ grep -o '"url":"[^"?]*' target.log | sort | uniq -c; grep -o '"statusCode":[0-9]*' target.log | sort | uniq -c
 200 "url":"/auth/otp
   1 "url":"/health
 200 "url":"/login
1000 "url":"/transactions
1401 "statusCode":200
```

- 첫 POST부터 200건 전부 completed까지 **5.0초**. POST 200개를 curl로 하나씩 보내는 데 4.3초가
  걸렸고, 워커의 첫 완료와 마지막 완료 사이는 3.85초(22:19:42.384 → 22:19:46.234)입니다. 병목은
  넣는 쪽이었습니다.
- 분배는 **w1 100, w2 100**. 실패·재시도·속도 제한은 없었습니다.
- API로 200건을 조회한 행 수 합(1255)과 Redis 결과 해시의 필드 수 합(1255)이 원장 기대값(1255)과
  같습니다. 결과 키는 200개입니다.
- 대상 서버 요청은 로그인 200 + 2차 인증 200 + 거래내역 1000(demo01 100×8 + demo02 100×2)입니다.
- API 응답의 `attemptsMade`가 1인 것은 BullMQ가 성공한 시도도 세기 때문입니다(스파이크 1번과 같음).

## 2. 같은 200건을 다시 넣어도 결과는 그대로다

```sh
$ ./post-all.sh
 200 202 completed
distinct ids: 200
$ cmp <(sort ids.txt) <(sort ids-first.txt) && echo "same 200 ids"
same 200 ids
$ docker compose exec -T redis redis-cli zcard bull:collections:completed   # failed, wait도 같은 방식
zcard bull:collections:completed -> 200
zcard bull:collections:failed -> 0
llen bull:collections:wait -> 0
$ for w in w1 w2; do echo "$w completed: $(grep -c '"event":"completed"' $w.log)"; done
w1 completed: 100
w2 completed: 100
$ ./results.sh
api statuses: {'completed': 200} rows(sum result.count)= 1255 attemptsMade= {1: 200}
result keys=200 rows(sum HLEN)=1255
$ grep -c '"url":"/login' target.log
200
```

다시 넣은 200건은 같은 작업 ID를 받고 바로 `completed`로 답했습니다. 워커의 완료 로그와 대상
서버의 로그인 수가 늘지 않았으니 프로세서가 다시 돌지 않았습니다(멱등 첫 겹, BullMQ jobId).
작업을 지우고 다시 넣어 프로세서가 **다시 돌 때** 행이 늘지 않는 것(둘째 겹, seq 필드)은
`process.test.ts`의 "같은 작업을 다시 넣어도, 지우고 다시 넣어…"가 봅니다.

## 3. 속도 제한: 큐 전체 정지와 시도 횟수

### 3-1. 대상 서버 기본 임계값(W=10초, N=5) + limiter 기본값: 큐는 멈추지만 끝나지 않는다

```sh
$ curl -s -H 'content-type: application/json' -d '{"switches":{"rateLimit":true}}' localhost:8081/admin/switches
{"switches":{"rateLimit":true,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}
$ # demo02 새 기간 4건 (from 2026-01-02 00:00:01, to 2026-01-03~06 00:00:00)
$ ./post-all.sh
   4 202 queued
distinct ids: 4
$ sleep 60; ...                     # 워커 로그 일부(3-1 구간의 처음 두 주기)
{"t":"2026-09-22T22:20:41.646Z","worker":"w2","pid":45139,"event":"completed","jobId":"col_5437883d8a6faa905951ff9b991b11f4","attemptsMade":0,"rows":4}
{"t":"2026-09-22T22:20:41.665Z","worker":"w1","pid":45140,"event":"rate-limited","jobId":"col_f1f566c403a037a1df53fdd248af8e6f","attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:20:51.674Z","worker":"w1","pid":45140,"event":"rate-limited","jobId":"col_d1c09116bea90e41a8a851d50eb7f536","attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:20:51.674Z","worker":"w2","pid":45139,"event":"rate-limited","jobId":"col_f1f566c403a037a1df53fdd248af8e6f","attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
```

대상 서버가 받은 요청(POST 시각 기준 ms, `target-trace.py`):

```
     20 /login         200
     21 /auth/otp      200
     22 /transactions  200
     22 /transactions  200
     41 /login         200
     41 /auth/otp      429
  10048 /login         200
  10048 /login         200
  10049 /auth/otp      200
  10049 /auth/otp      200
  10050 /transactions  200
  10050 /transactions  429
  ...
$ python3 bursts.py traceA.txt
{'start': 20, 'end': 41, 'n': 6, '200': 5, '429': 1}
{'start': 10048, 'end': 10051, 'n': 7, '200': 5, '429': 2}
{'start': 20070, 'end': 20075, 'n': 7, '200': 5, '429': 2}
{'start': 30082, 'end': 30085, 'n': 7, '200': 5, '429': 2}
{'start': 40095, 'end': 40099, 'n': 7, '200': 5, '429': 2}
{'start': 50116, 'end': 50121, 'n': 7, '200': 5, '429': 2}
{'start': 60131, 'end': 60137, 'n': 7, '200': 5, '429': 2}
{'start': 70144, 'end': 70149, 'n': 7, '200': 5, '429': 2}
{'start': 80170, 'end': 80175, 'n': 7, '200': 5, '429': 2}
{'start': 90178, 'end': 90181, 'n': 7, '200': 5, '429': 2}
gaps between bursts ms: [10007, 10019, 10007, 10010, 10017, 10010, 10007, 10021, 10003]
```

- **큐 전체가 멈췄다.** 요청은 10초마다 5ms 안팎의 묶음으로만 왔고, 묶음 사이 10.003~10.021초 동안
  대상 서버는 요청을 하나도 받지 않았습니다. 대기 작업이 3개, 놀 수 있는 워커가 2개인데도 그렇습니다.
- **시도 횟수를 깎지 않았다.** 이 구간의 `rate-limited` 19건이 전부 `attemptsMade: 0`입니다(w1 10, w2 9).
  90초 동안 같은 작업이 여러 번 제한을 받았지만 어느 것도 failed나 DLQ로 가지 않았습니다.
- **그런데 끝나지 않는다.** 4건 중 1건만 완료됐습니다. 매 주기 두 워커가 동시에 출발해 로그인 2 +
  2차 인증 2 + 페이지 1로 창(5개)을 채우고, 둘 다 다음 페이지에서 429를 받습니다. 작업은 처음부터
  다시 하므로 다음 주기도 같습니다. 시도 횟수를 깎지 않으니 이 상태는 저절로 끝나지 않습니다.

워커 종료(SIGTERM, 제한 대기 중):

```sh
$ kill -TERM <w1 tsx pid> <w2 tsx pid>; sleep 3
{"t":"2026-09-22T22:22:17.118Z","worker":"w1","pid":45140,"event":"shutdown","signal":"SIGTERM"}
{"t":"2026-09-22T22:22:17.123Z","worker":"w1","pid":45140,"event":"closed"}
{"t":"2026-09-22T22:22:17.118Z","worker":"w2","pid":45139,"event":"shutdown","signal":"SIGTERM"}
{"t":"2026-09-22T22:22:17.123Z","worker":"w2","pid":45139,"event":"closed"}
$ pgrep -fl "collector/worker/index.ts" || echo "no worker process"
no worker process
$ docker compose exec -T redis redis-cli client list | wc -l     # API 연결 + redis-cli 자신
       2
```

### 3-2. limiter를 대상 서버 임계값에 맞추면(1개/11초) 429 없이 끝난다

`DEFAULT_WORKER_LIMITER` 주석의 식대로, demo02 작업(요청 4개)이 창(10초에 5개)에 하나씩만
들어가게 조였습니다. 11초는 창 10초에 여유 1초를 둔 값입니다. 남은 3건을 같은 큐에서 이어서 처리합니다.

```sh
$ WORKER_NAME=w1 TARGET_ORIGIN=http://127.0.0.1:8081 WORKER_LIMIT_MAX=1 WORKER_LIMIT_DURATION_MS=11000 nohup ./node_modules/.bin/tsx collector/worker/index.ts >> w1.log 2>&1 &
$ WORKER_NAME=w2 ... (같은 환경변수) >> w2.log 2>&1 &
$ sleep 45
completed=204 failed=0
{"t":"2026-09-22T22:22:26.792Z","worker":"w1","pid":52430,"event":"ready","queue":"collections","origin":"http://127.0.0.1:8081","concurrency":1,"limiter":{"max":1,"duration":11000}}
{"t":"2026-09-22T22:22:26.815Z","worker":"w1","pid":52430,"event":"completed","jobId":"col_f1f566c403a037a1df53fdd248af8e6f","attemptsMade":0,"rows":8}
{"t":"2026-09-22T22:22:37.810Z","worker":"w1","pid":52430,"event":"completed","jobId":"col_d1c09116bea90e41a8a851d50eb7f536","attemptsMade":0,"rows":12}
{"t":"2026-09-22T22:22:26.792Z","worker":"w2","pid":52431,"event":"ready","queue":"collections","origin":"http://127.0.0.1:8081","concurrency":1,"limiter":{"max":1,"duration":11000}}
{"t":"2026-09-22T22:22:48.842Z","worker":"w2","pid":52431,"event":"completed","jobId":"col_15752c3f1ace21af95c28d9bc9cfa30a","attemptsMade":0,"rows":12}
    365 /login         200
    369 /auth/otp      200
    369 /transactions  200
    378 /transactions  200
  11366 /login         200
  11368 /auth/otp      200
  11370 /transactions  200
  11372 /transactions  200
  22387 /login         200
  22393 /auth/otp      200
  22394 /transactions  200
  22404 /transactions  200
$ ./results.sh     # 3절의 4건
api statuses: {'completed': 4} rows(sum result.count)= 36 attemptsMade= {1: 4}
```

429가 한 번도 나지 않았고 작업은 11초 간격으로 한 건씩, 두 워커에 나뉘어 돌았습니다(limiter도
큐 단위라 워커를 가로질러 셉니다). 3-1에서 제한을 19번 받은 두 작업도 `attemptsMade` 1(성공
한 번)로 끝났습니다.

### 3-3. 요청 수가 창보다 많은 작업은 limiter로도 끝나지 않는다

demo01 작업은 요청 10개라 창(5개)에 들어가지 않습니다. 3-2와 같은 워커(1개/11초)로 한 건을 넣었습니다.

```sh
$ ./post-all.sh      # demo01, 2026-01-02 00:00:01 ~ 2026-01-10 00:00:00
   1 202 queued
distinct ids: 1
$ sleep 38
{"t":"2026-09-22T22:23:24.104Z","worker":"w2","pid":52431,"event":"rate-limited","jobId":"col_f278a63e53ef0de894ae4b7dd1bb3b64","attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:23:34.125Z","worker":"w2",...,"attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:23:44.139Z","worker":"w2",...,"attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:23:54.161Z","worker":"w2",...,"attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-22T22:24:04.180Z","worker":"w2",...,"attemptsMade":0,"waitMs":10000,"detail":"HTTP 429"}
     19 /login         200
     20 /auth/otp      200
     21 /transactions  200
     22 /transactions  200
     23 /transactions  200
     23 /transactions  429
  10035 /login         200
  ...(10초마다 같은 여섯 줄)
  40099 /transactions  429
$ curl -s localhost:8090/collections/col_f278a63e53ef0de894ae4b7dd1bb3b64
{"id":"col_f278a63e53ef0de894ae4b7dd1bb3b64","status":"queued","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-02 00:00:01","to":"2026-01-10 00:00:00"},"attemptsMade":0}
```

매 주기 로그인 2 + 3페이지까지 받고 4페이지에서 429, 제한이 풀리면 다시 로그인부터입니다.
`attemptsMade` 0으로 영원히 `queued`입니다. 받은 페이지를 이어 가지 않는 한(작업 안에서 페이지
진행을 남기거나 페이지 단위로 쪼개기) 풀리지 않습니다. 이 기록은 한계로 남기고 고치지 않았습니다.
또 3-2의 limiter(11초)가 아니라 10초 간격으로 다시 출발했습니다. **`queue.rateLimit`이 limiter와
같은 키를 조건 없이 덮어쓰기 때문입니다**(#13 리뷰로 확정, 4-4절). bullmq 6.3.8
`redis-queue-backend.js`의 `setRateLimit`은 `SET bull:<큐>:limiter MAX_SAFE_INTEGER PX <ms>` 한 줄이고,
limiter가 창을 세는 키도 같은 `bull:<큐>:limiter`입니다. 그래서 429가 한 번 나면 그 주기는 limiter
창이 아니라 Retry-After 간격이 됩니다.

## 4. #13 리뷰 재현 스크립트 재실행(수정 뒤)

빈 컨텍스트 리뷰가 만든 재현 스크립트(r2~r5)를 수정 뒤 리포 루트에서 `pnpm -s tsx <경로>`로 다시
돌렸습니다. 스크립트는 리포 밖(검수자 작업 디렉터리)에 있어서 여기에는 출력과, 제가 바꾼 변형의
차이만 남깁니다. 끝나고 `review13` 키 0개, Redis 연결은 redis-cli 자신 1개였습니다.

### 4-1. r3: IP_BLOCKED가 대기 작업을 영구 failed로 비우던 것

수정 전(리뷰 기록): 2초 차단 동안 demo02 대기 5건이 전부 `failed`·DLQ 5건, 차단이 풀린 뒤 같은
요청을 다시 넣어도 작업 ID가 같아 `failed`로 남았습니다. 수정 뒤 IP_BLOCKED는 Retry-After만큼 큐
전체를 멈춥니다(`queue.ts` DISPOSITION).

```
$ pnpm -s tsx review13/r3-ipblock-drains-queue.mts      # 원본: 창 10초에 2요청, 초과 1회에 2초 차단
{"phase":"during-block","elapsedMs":11465,"states":"timeout","kinds":[null,null,null,null,null],"dlq":0,"targetHits":["/login 200","/auth/otp 200","/transactions 403","/login 200","/auth/otp 200","/transactions 403", ...(같은 세 줄 반복)]}
{"phase":"after-unblock-readd","health":200,"loginStatus":403,"states":["waiting","waiting","waiting","waiting","waiting"]}
$ pnpm -s tsx review13-mine/r3b-ipblock-maxreq4.mts     # 변형: maxRequests 2 -> 4, 대기 한도 10초 -> 20초
{"phase":"during-block","elapsedMs":8115,"states":["completed","completed","completed","completed","completed"],"kinds":[null,null,null,null,null],"dlq":0,"targetHits":["/login 200","/auth/otp 200","/transactions 200","/transactions 200","/login 403","/login 200","/auth/otp 200","/transactions 200","/transactions 200","/login 403", ...]}
{"phase":"after-unblock-readd","health":200,"loginStatus":403,"states":["completed","completed","completed","completed","completed"]}
```

- 원본 조건에서는 더 이상 failed도 DLQ도 없습니다(대기 5건은 `waiting`). 그러나 작업 하나가 요청 4개인데
  창이 2개라, 차단이 풀리면 로그인 2개 뒤 1페이지에서 다시 막히기를 되풀이하며 끝나지 않습니다.
  3-3절과 같은 범주(창보다 큰 작업)입니다(TROUBLESHOOTING 4번).
- 작업 하나가 창에 들어가는 변형(N=4)에서는 차단 한 번(2초)에 한 건씩, 5건이 8.1초에 전부 완료됐습니다.
  DLQ 0건입니다. 마지막 줄의 `loginStatus` 403은 스크립트가 5번째 작업 직후 보낸 확인용 로그인이 다시
  차단을 부른 것입니다.

### 4-2. r4: 처리 중 워커가 두 번 죽은 작업이 DLQ에 남지 않던 것

```
$ pnpm -s tsx review13/r4-stalled-no-dlq.mts            # 원본: 자식 워커가 createProcessor로 Worker를 직접 만든다
[C] FAILED col_s job stalled more than allowable limit
{"state":"failed","failedReason":"job stalled more than allowable limit","parsed":{"kind":null,"detail":"job stalled more than allowable limit"},"attemptsMade":1,"dlqCount":0}
$ pnpm -s tsx review13-mine/r4b-stalled-dlq.mts         # 변형: 자식 워커를 createCollectionWorker로 만든다(lockDuration 1초, stalledInterval 0.5초)
[A] COLLECT_CALLED
[A] SIGKILL while processing; state=active
[B] COLLECT_CALLED
[B] SIGKILL while processing; state=active
[C] FAILED col_s job stalled more than allowable limit
[C] {"event":"dead-letter","jobId":"col_s","attemptsMade":1,"kind":null,"detail":"BullMQ가 프로세서 밖에서 실패시켰다: job stalled more than allowable limit"}
{"state":"failed","failedReason":"job stalled more than allowable limit","parsed":{"kind":null,"detail":"job stalled more than allowable limit"},"attemptsMade":1,"dlqCount":1,"dlq":{"originalId":"col_s","kind":null,"detail":"BullMQ가 프로세서 밖에서 실패시켰다: job stalled more than allowable limit","attemptsMade":1,"failedAt":"2026-09-22T22:46:19.506Z","request":{"loginId":"demo02","accountNo":"a","from":"f","to":"t"},"raw":null}}
```

이 실패는 프로세서를 거치지 않으므로(BullMQ가 `defa` 필드를 보고 `failed` 이벤트만 낸다) DLQ는
Worker의 `failed` 이벤트에서 씁니다. 그 처리기는 `createCollectionWorker`가 붙입니다. 원본 r4의 자식은
`createProcessor`로 Worker를 직접 만들어 처리기가 없으므로 수정 뒤에도 DLQ 0건이 맞고, 진입점
(`index.ts`)과 같은 조립을 쓰는 변형에서 DLQ 1건이 됐습니다.

### 4-3. r5: fail-now에서 DLQ 쓰기 실패가 재수집을 부르던 것

```
$ pnpm -s tsx review13/r5-failnow-dlq-error.mts
{"collectCalls":1,"attemptsMade":1,"failedReason":"UNKNOWN: 1차 인증 2xx 본문이 예상과 다르다","dlq":{"kind":"UNKNOWN","attemptsMade":1,"hasRaw":true},"events":["dead-letter-error:undefined:undefined","dead-letter:UNKNOWN:1"]}
```

수정 전(리뷰 기록)은 collect 2회였습니다. 이제 첫 DLQ 쓰기가 실패해도 처분(UnrecoverableError)대로
끝나고(collect 1회, `attemptsMade` 1), 못 쓴 항목을 `failed` 이벤트에서 다시 써 DLQ에 원본까지 남았습니다.

### 4-4. r2: queue.rateLimit이 limiter 창을 덮어쓴다(코드 변경 없음, 사실 확인)

```
$ pnpm -s tsx review13/r2-ratelimit-overwrites-limiter.mts   # limiter 1개/4초
baseline: no 429 (limiter 1 job / 4000ms)
{"retryAfterSec":null,"starts":[{"job":"A","t":15,"pttlAtStart":3998},{"job":"B","t":4017,"pttlAtStart":3998},{"job":"C","t":8020,"pttlAtStart":3997}]}
A gets 429 with Retry-After 0.3s
{"retryAfterSec":0.3,"starts":[{"job":"A","t":15,"pttlAtStart":3998},{"job":"A","t":322,"pttlAtStart":3997},{"job":"B","t":4325,"pttlAtStart":3997},{"job":"C","t":8326,"pttlAtStart":3999}]}
A gets 429 with Retry-After 7s (longer than limiter window)
{"retryAfterSec":7,"starts":[{"job":"A","t":11,"pttlAtStart":3999},{"job":"A","t":7015,"pttlAtStart":3998},{"job":"B","t":11018,"pttlAtStart":3997}]}
```

0.3초짜리 429 뒤 A는 limiter 창(4초)을 무시하고 0.3초 뒤 다시 출발했고, 7초짜리 뒤에는 7초 뒤에
출발했습니다. 소스(bullmq 6.3.8 `redis-queue-backend.js` `setRateLimit`)는 `SET bull:<큐>:limiter
MAX_SAFE_INTEGER PX <ms>`를 조건 없이 보냅니다. 3-3절의 10초 간격이 이것입니다.

### 4-5. 1~3절 수치에 대한 영향

IP_BLOCKED 처분 변경은 1·2절(200건, 재투입)에 영향이 없습니다. 그 구간에 출발지 차단 스위치는 꺼져
있었고 대상 서버 응답은 1401건 전부 200이었습니다(1절 `statusCode` 집계). 3절도 `ipBlock: false`였습니다.
다시 측정하지 않았습니다.

## 정리

```sh
$ pkill -TERM -f "tsx/dist/cli.mjs collector/worker/index.ts"; sleep 2
{"t":"2026-09-22T22:24:14.497Z","worker":"w1","pid":52430,"event":"closed"}
{"t":"2026-09-22T22:24:14.497Z","worker":"w2","pid":52431,"event":"closed"}
$ pkill -TERM -f "tsx/dist/cli.mjs collector/api/server.ts"; pkill -TERM -f "tsx/dist/cli.mjs target/server.ts"; sleep 2
$ pgrep -fl "collector/worker/index.ts|collector/api/server.ts|target/server.ts" || echo "no lab process"
no lab process
$ lsof -nP -i :8081 -i :8090 || echo "8081/8090 closed"
8081/8090 closed
$ docker compose exec -T redis redis-cli client list | wc -l     # redis-cli 자신만
       1
$ grep -c "demo-pass" w1.log w2.log api.log target.log
w1.log:0
w2.log:0
target.log:0
api.log:0
$ # 실험 큐 키 삭제: bull:collections:* 213, bull:collections-dead:* 1(meta), results:collections:* 204
$ sleep 11; docker compose exec -T redis redis-cli dbsize     # 제한 키(PX 10초)가 만료된 뒤
0
```

`bull:collections-dead:meta`는 워커가 DLQ 큐 객체를 만들 때 생긴 메타 키입니다. 이 실측에서
DLQ 항목은 없었습니다(처분별 DLQ 동작은 `process.test.ts`).

## 부록: 스크립트

리포 루트에서 `REPO=<리포 경로>`를 내보내고 실행했습니다. 로그 파일은 스크립트와 같은 디렉터리에 있습니다.

### bodies.mts

```ts
// 200건 요청 본문을 만들고, 원장(target/transactions.ts)으로 기대 행 수를 계산한다.
// 사용: pnpm -s tsx bodies.mts <리포 루트> > bodies.jsonl   (기대 합계는 stderr)
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ?? '.';
const { buildLedger } = await import(pathToFileURL(`${root}/target/transactions.ts`).href);
const H = 3_600_000;
const base = Date.UTC(2026, 0, 2);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const jobs: { loginId: string; accountNo: string; from: string; to: string; count: number }[] = [];
for (let i = 0; i < 100; i += 1) {
  // demo01: 시작일 34가지(원장 안) x 길이 1~3일
  const from = base + (i % 34) * 24 * H;
  jobs.push({ loginId: 'demo01', accountNo: '000-11-222333', from: fmt(from), to: fmt(from + (1 + Math.floor(i / 34)) * 24 * H - 1000), count: 137 });
}
for (let i = 0; i < 100; i += 1) {
  // demo02: 시작 6시간 칸 10가지 x 길이 1~10칸
  const from = base + (i % 10) * 6 * H;
  jobs.push({ loginId: 'demo02', accountNo: '000-44-555666', from: fmt(from), to: fmt(from + (1 + Math.floor(i / 10)) * 6 * H - 1000), count: 12 });
}
let total = 0;
let zero = 0;
for (const j of jobs) {
  const n = buildLedger(j.accountNo, j.count).filter((r: { at: string }) => r.at >= j.from && r.at <= j.to).length;
  total += n;
  if (n === 0) zero += 1;
  console.log(JSON.stringify({ loginId: j.loginId, accountNo: j.accountNo, from: j.from, to: j.to }));
}
console.error(JSON.stringify({ jobs: jobs.length, distinct: new Set(jobs.map((j) => JSON.stringify(j))).size, expectedRows: total, zeroRowJobs: zero }));
```

### post-all.sh

```bash
#!/usr/bin/env bash
# bodies.jsonl의 줄마다 POST /collections. 상태 코드와 응답 status 분포를 찍는다.
set -euo pipefail
API=${API:-http://127.0.0.1:8090}
: > ids.txt
codes=$(while IFS= read -r body; do
  out=$(curl -s -w '\n%{http_code}' -H 'content-type: application/json' -d "$body" "$API/collections")
  code=$(tail -n1 <<<"$out"); json=$(head -n1 <<<"$out")
  id=$(sed -E 's/.*"id":"([^"]+)".*/\1/' <<<"$json"); st=$(sed -E 's/.*"status":"([^"]+)".*/\1/' <<<"$json")
  echo "$id" >> ids.txt
  echo "$code $st"
done < bodies.jsonl | sort | uniq -c)
echo "$codes"
echo "distinct ids: $(sort -u ids.txt | wc -l | tr -d ' ')"

```

### poll.sh

```bash
#!/usr/bin/env bash
# 완료+실패가 N이 될 때까지 Redis 집합 크기를 본다. 경과 시간(ms)을 찍는다.
set -euo pipefail
N=${1:-200}; start=${2:?start ms}
R="docker compose -f $REPO/docker-compose.yml exec -T redis redis-cli"
while :; do
  c=$($R zcard bull:collections:completed); f=$($R zcard bull:collections:failed)
  if [ $((c + f)) -ge "$N" ]; then break; fi
  sleep 0.2
done
now=$(python3 -c 'import time; print(int(time.time()*1000))')
echo "completed=$c failed=$f elapsedMs=$((now - start))"

```

### results.sh

```bash
#!/usr/bin/env bash
# ids.txt의 작업을 API로 조회해 상태·행 수 합계를, Redis에서 결과 키 수·HLEN 합계를 본다.
set -euo pipefail
API=${API:-http://127.0.0.1:8090}
R="docker compose -f $REPO/docker-compose.yml exec -T redis redis-cli"
sort -u ids.txt | while read -r id; do curl -s "$API/collections/$id"; echo; done > views.jsonl
echo "api statuses: $(python3 -c 'import json,collections,sys; v=[json.loads(l) for l in open("views.jsonl")]; print(dict(collections.Counter(x["status"] for x in v)), "rows(sum result.count)=", sum(x.get("result",{}).get("count",0) for x in v), "attemptsMade=", dict(collections.Counter(x["attemptsMade"] for x in v)))')"
kr=$($R eval "local s=0 local ks=redis.call('keys', ARGV[1]) for _,k in ipairs(ks) do s=s+redis.call('hlen',k) end return {#ks, s}" 0 'results:collections:*' | tr -d '\r')
echo "result keys=$(sed -n 1p <<<"$kr") rows(sum HLEN)=$(sed -n 2p <<<"$kr")"

```

### target-trace.py

```python
# target.log(Fastify JSON 로그)에서 mark 이후 요청을 "시각(시작 기준 ms) 경로 상태"로 뽑는다.
import json, sys
mark = int(open(sys.argv[1]).read().strip()); start = int(sys.argv[2]); end = int(open(sys.argv[3]).read().strip()) if len(sys.argv) > 3 else 10**9
urls = {}
for i, line in enumerate(open('target.log')):
    if i < mark or i >= end: continue
    try: r = json.loads(line)
    except: continue
    if 'req' in r: urls[r['reqId']] = r['req']['url'].split('?')[0]
    if 'res' in r:
        u = urls.get(r['reqId'], '?')
        if u.startswith('/admin') or u == '/health': continue
        print(f"{r['time'] - start:>7} {u:<14} {r['res']['statusCode']}")
```

### bursts.py

```python
# target-trace.py 출력에서 1초 넘게 비는 자리로 요청을 묶는다. 묶음 사이 간격이 곧 큐가 멈춘 시간이다.
import sys
rows = [l.split() for l in open(sys.argv[1])]
bursts, prev = [], None
for t, u, s in rows:
    t = int(t)
    if prev is None or t - prev > 1000:
        bursts.append({'start': t, 'end': t, 'n': 0, '200': 0, '429': 0})
    b = bursts[-1]; b['end'] = t; b['n'] += 1; b[s] = b.get(s, 0) + 1; prev = t
for b in bursts: print(b)
print('gaps between bursts ms:', [bursts[i + 1]['start'] - bursts[i]['end'] for i in range(len(bursts) - 1)])
```
