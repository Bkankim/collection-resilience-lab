# D3 증거: 이어받기와 진행 기반 상한(#19) 실측 기록

`collector/worker/process.test.ts`의 `큐 워커: 이어받기와 진행 기반 상한(#19)`이 완료 기준을 CI에서
검증합니다. 이 파일은 **실제 포트에 띄운 대상 서버(8081)·API(8090)와 별도 프로세스 워커 2개**에 curl로
요청을 넣은 기록입니다(D1 규칙). `d2-pipeline.md` 3-3절에서 끝나지 않던 demo01 작업이 무엇으로 바뀌었는지,
그리고 처음 구현(작업마다 센 상한)이 실측에서 오탐한 것과 고친 뒤(큐 전체로 센 상한)를 나란히 남깁니다.

| 절 | 코드 | 무엇을 보나 |
|---|---|---|
| 1 | 1158b74 (이어받기 전) | 기본 임계값에서 demo01이 끝나지 않는다 |
| 2 | 2a7622b, 6e2af48 | 같은 작업이 받은 페이지부터 이어받아 끝난다. 도중의 API 응답 |
| 3 | 2a7622b (작업마다 센 상한) | 속도 제한 + 출발지 차단, 워커 2개에서 NO_PROGRESS 오탐 |
| 4 | 6e2af48 (큐 전체로 센 상한) | 3절과 같은 조건에서 두 작업 모두 완료. 굶주림 |
| 5 | 6e2af48 | N=2(로그인 비용 이하)에서 NO_PROGRESS |
| 6 | fb9d6fa (리뷰 결함 수정) | 5절이 남긴 상태가 멀쩡한 큐를 실패시킨 것 등 세 결함, 4·5절 재실행 |
| 7 | a986ffc, 28c857c (최종 리뷰 수정) | 큐 정지를 주기 창에 맞춘 뒤 4절 조건 한 번 더 |

2a7622b·6e2af48·fb9d6fa의 이어받기 코드(페이지마다 결과·체크포인트)는 같습니다. 달라진 것은 상한을 세는
방법뿐입니다. **4·5절(6e2af48)의 상한에는 결함이 셋 있었고 6절에서 고쳤습니다.** 4·5절은 그 코드의 기록으로
남깁니다.

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-25 KST (로그 시각은 UTC 2026-09-25 12:00~12:29) |
| Node | v26.4.0 |
| bullmq / ioredis / undici | 6.3.8 / 5.11.1 / 8.10.2 |
| Redis | `docker compose` redis:7-alpine (7.4.11) |
| 대상 서버 | `PORT=8081 tsx target/server.ts` (1~5절 내내 같은 프로세스가 아니라 1~3절, 4~5절 두 번 띄움) |
| API | `PORT=8090 tsx collector/api/server.ts` (큐 `collections`) |
| 워커 | `WORKER_NAME=w1`, `w2` 두 프로세스. `TARGET_ORIGIN=http://127.0.0.1:8081`, concurrency 1, limiter 기본 `{ max: 100, duration: 1000 }`, 진행 기반 상한 기본 3 |
| 출발지 | 전부 `127.0.0.1` (대상 서버가 보기에 출발지 하나) |
| curl | 8.7.1 |

큐 `collections`에는 이전 기록(d2, #13 리뷰)의 작업이 남아 있어 비우지 않았습니다. 작업 ID가 겹치지 않게
절마다 기간을 바꿨습니다(같은 요청은 같은 작업 ID라 새로 돌지 않습니다). 4절을 시작할 때 DLQ에는 3절의 항목
1건이 있었고, `progress:collections` 키는 없었습니다.

demo01(137건)은 7페이지이고, 작업 하나가 보내는 요청은 로그인 2 + 페이지 7 + 끝을 확인하는 빈 8페이지
1개입니다. 대상 서버 기본 임계값은 W=10초, N=5, M=3, T=30초입니다. 스크립트는 부록에 있습니다.

## 1. 이어받기 전(1158b74): 매 주기 1페이지부터 다시 받아 끝나지 않는다

`git worktree`로 1158b74를 꺼내 API와 워커 2개를 거기서 띄웠습니다. 대상 서버 코드는 두 커밋 사이에 바뀌지
않았습니다(`git diff 1158b74 HEAD -- target` 0줄).

```sh
$ curl -s -H 'content-type: application/json' -d '{"switches":{"rateLimit":true}}' localhost:8081/admin/switches
{"switches":{"rateLimit":true,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}
$ curl -s -H 'content-type: application/json' -d '{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-01","to":"2026-09-01"}' localhost:8090/collections
{"id":"col_55791c502578c0f4189d5673eea749ae","status":"queued"}
$ sleep 45
{"t":"2026-09-25T12:01:44.185Z","worker":"w2","pid":3329,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-25T12:01:54.234Z","worker":"w1","pid":3332,"event":"rate-limited",...,"attemptsMade":0,...}
{"t":"2026-09-25T12:02:04.258Z","worker":"w1","pid":3332,"event":"rate-limited",...,"attemptsMade":0,...}
{"t":"2026-09-25T12:02:14.283Z","worker":"w1","pid":3332,"event":"rate-limited",...,"attemptsMade":0,...}
{"t":"2026-09-25T12:02:24.305Z","worker":"w2","pid":3329,"event":"rate-limited",...,"attemptsMade":0,...}
$ python3 trace.py <mark>        # 시각(첫 요청 기준 ms) 경로 페이지 상태
      0 /login            200
      4 /auth/otp         200
     27 /transactions  1  200
     35 /transactions  2  200
     36 /transactions  3  200
     37 /transactions  4  429
  10067 /login            200
  10072 /auth/otp         200
  10073 /transactions  1  200
  10084 /transactions  2  200
  10085 /transactions  3  200
  10085 /transactions  4  429
  ...(10초마다 같은 여섯 줄, 40157ms까지 다섯 주기)
$ curl -s localhost:8090/collections/col_55791c502578c0f4189d5673eea749ae
{"id":"col_55791c502578c0f4189d5673eea749ae","status":"queued","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-01 00:00:00","to":"2026-09-01 23:59:59"},"attemptsMade":0}
```

`d2-pipeline.md` 3-3절과 같은 모양입니다. 매 주기 로그인 2 + 1~3페이지로 창(5개)을 채우고 4페이지에서 429,
제한이 풀리면 다시 1페이지부터입니다. 40초 동안 다섯 주기, `attemptsMade` 0으로 `queued`입니다.

## 2. 이어받기 뒤: 같은 작업이 4페이지·7페이지에서 이어받아 끝난다

1절의 워커와 API를 SIGTERM으로 내리고, **같은 큐에 대기 중인 같은 작업**을 2a7622b의 API·워커 2개가
꺼내게 했습니다. 작업 데이터에는 체크포인트가 없으므로 1페이지부터 시작합니다. 3초마다 API 응답과 Redis의
작업 데이터·결과 행 수를 찍었습니다.

```sh
$ docker compose exec -T redis redis-cli hget bull:collections:col_55791c502578c0f4189d5673eea749ae data
{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-01 00:00:00","to":"2026-09-01 23:59:59"}
$ # 워커 2개(2a7622b) 시작 뒤 3초마다: API 응답 / 작업 데이터 / HLEN results:collections:<id>
--- +3s
{"id":"col_55791c502578c0f4189d5673eea749ae","status":"queued","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-01 00:00:00","to":"2026-09-01 23:59:59"},"attemptsMade":0}
{"loginId":"demo01",...,"checkpoint":{"nextPage":4,"noProgressCycles":0}}
60
--- +12s
{"id":"col_55791c502578c0f4189d5673eea749ae","status":"queued","request":{...},"attemptsMade":0}
{"loginId":"demo01",...,"checkpoint":{"nextPage":7,"noProgressCycles":0}}
120
--- +21s
{"id":"col_55791c502578c0f4189d5673eea749ae","status":"completed","request":{...},"attemptsMade":1,"result":{"count":137,"rows":[...]}}
{"loginId":"demo01",...,"checkpoint":{"nextPage":8,"noProgressCycles":0}}
137
```

(`noProgressCycles`는 2a7622b의 작업별 계수입니다. 6e2af48에서 없앴습니다.)

```
{"t":"2026-09-25T12:02:57.618Z","worker":"w2",...,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":10000,"detail":"HTTP 429"}
{"t":"2026-09-25T12:03:07.649Z","worker":"w2",...,"event":"rate-limited",...}
{"t":"2026-09-25T12:03:17.672Z","worker":"w2",...,"event":"completed","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"rows":137}
      0 /login            200
      3 /auth/otp         200
      4 /transactions  1  200
     17 /transactions  2  200
     22 /transactions  3  200
     25 /transactions  4  429
  10036 /login            200
  10038 /auth/otp         200
  10041 /transactions  4  200
  10048 /transactions  5  200
  10053 /transactions  6  200
  10056 /transactions  7  429
  20068 /login            200
  20070 /auth/otp         200
  20072 /transactions  7  200
  20075 /transactions  8  200
$ tsx ledger-check.mts view.json 000-11-222333 137 '2026-01-01 00:00:00' '2026-09-01 23:59:59'
{"status":"completed","count":137,"rows":137,"expected":137,"equal":true}
```

- **끝났다.** 1절에서 40초 동안 다섯 번 4페이지에서 막히던 작업이 두 번의 제한(20초)을 거쳐 완료됐습니다.
  두 번째 주기는 4페이지, 세 번째는 7페이지부터 받았고 1~3페이지를 다시 받지 않았습니다. 결과 137행이
  원장과 같습니다.
- **도중의 부분 결과가 완료로 보이지 않는다.** Redis에 60행, 120행이 쓰여 있는 동안 API는 `queued`이고
  `result`가 없었습니다. API는 `completed`일 때만 결과를 읽습니다.
- **체크포인트가 API 응답에 섞이지 않는다.** 작업 데이터에는 `checkpoint`가 있는데 응답의 `request`는 네
  필드뿐입니다.

6e2af48로 같은 조건(워커 2개, 속도 제한만)에서 새 작업 하나(`from 2026-01-07`, 117행)를 돌린 것도 같은
모양입니다. `1 2 3 4(429) | 4 5 6 7(429) | 7 8`, 20초, 원장과 일치(`{"status":"completed","count":117,"rows":117,"expected":117,"equal":true}`).

## 3. 처음 구현(2a7622b, 작업마다 센 상한): 속도 제한 + 출발지 차단, 워커 2개에서 오탐

차단을 함께 켜고(기본 M=3, T=30초) demo01 작업 2건(`from 2026-01-02`, `from 2026-01-03`)을 넣었습니다.
(같이 넣은 `from 2026-01-01` 요청은 2절의 작업과 같은 ID라 새로 돌지 않았습니다.)

```sh
$ curl -s ... -d '{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' localhost:8081/admin/switches
$ # 워커 로그 요약: 시각 워커 사건 작업(끝 6자) 종류 대기ms 행
12:03:48.879 w2 rate-limited b2a012 RATE_LIMITED 10000
12:03:48.891 w1 rate-limited f4c7e8 RATE_LIMITED 10000
12:03:58.908 w1 rate-limited b2a012 IP_BLOCKED 30000
12:03:58.911 w2 rate-limited f4c7e8 IP_BLOCKED 30000
12:04:28.931 w2 rate-limited b2a012 RATE_LIMITED 10000
12:04:28.955 w1 rate-limited f4c7e8 RATE_LIMITED 10000
12:04:38.970 w2 rate-limited b2a012 IP_BLOCKED 30000
12:04:38.974 w1 rate-limited f4c7e8 IP_BLOCKED 30000
12:04:38.977 w2 dead-letter b2a012 NO_PROGRESS   속도 제한·차단 주기 3번 연속 새 페이지 없음(4페이지에서 멈춤). ...
12:05:09.008 w2 rate-limited f4c7e8 RATE_LIMITED 10000
12:05:19.028 w2 completed f4c7e8   133
      0 /login            200
      1 /auth/otp         200
      1 /transactions  1  200
      4 /transactions  2  200
      7 /transactions  3  200
      9 /transactions  4  429
     19 /login            429
  10031 /login            200
  10032 /login            200
  10032 /auth/otp         200
  10035 /transactions  1  200
  10036 /auth/otp         200
  10037 /transactions  4  403
  10040 /transactions  2  403
  40054 /login            200
  40054 /login            200
  40057 /auth/otp         200
  40057 /auth/otp         200
  40060 /transactions  2  200
  40060 /transactions  4  429
  40085 /transactions  3  429
  50094 /login            200
  50095 /login            200
  50096 /auth/otp         200
  50097 /auth/otp         200
  50099 /transactions  3  200
  50099 /transactions  4  403
  50103 /transactions  4  403
  ...(80121ms에 f4c7e8이 4~6페이지와 7페이지 429, 90153ms에 7·8페이지로 끝)
$ docker compose exec -T redis redis-cli hget bull:collections-dead:col_fe99bf7049c4171bb4a0210ea1b2a012 data
{"originalId":"col_fe99bf7049c4171bb4a0210ea1b2a012","kind":"NO_PROGRESS","detail":"속도 제한·차단 주기 3번 연속 새 페이지 없음(4페이지에서 멈춤). ... 마지막 실패 IP_BLOCKED: HTTP 403 + Retry-After, 본문 IP_BLOCKED","attemptsMade":1,...,"request":{...,"checkpoint":{"nextPage":4,"noProgressCycles":2}},"raw":null}
```

작업 b2a012(`from 2026-01-02`)는 첫 주기에 1~3페이지를 받고, 그 뒤 세 주기(10031ms 403, 40054ms 429,
50094ms 403)를 한 페이지도 없이 지나 DLQ에 NO_PROGRESS로 갔습니다(결과 60행, 실패라 API는 행을 보이지
않습니다). 같은 세 주기에 다른 작업 f4c7e8은 1·1·1페이지를 받았고, 이어 4~6페이지, 7페이지와 빈 8페이지를 받아
133행(원장과 일치)으로 완료했습니다. **큐는 주기마다 나아가고 있었습니다.**

원인: 두 워커가 제한이 풀릴 때마다 같이 출발해 로그인 두 벌(4요청)이 창(5개)을 거의 다 쓰고, 다섯 번째
요청(한 페이지)을 먼저 보낸 작업만 나아갑니다. 작업마다 세면 "창이 로그인 비용보다 크면 주기마다 나아간다"는
전제가 작업 하나가 출발지 하나를 쓸 때만 맞습니다. 이 오탐을 받고 진행을 큐 전체로 세기로 했습니다(#19,
6e2af48).

## 4. 큐 전체로 센 상한(6e2af48): 같은 조건에서 두 작업 모두 완료

3절과 같은 스위치·임계값, 워커 2개, demo01 작업 2건(`from 2026-01-08`, `from 2026-01-09`).

```sh
$ ./run.sh blk '{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' 2026-01-08 2026-01-09
{"id":"col_b312cb346cf1aeb0b994539ef1dae0d4","status":"queued"}
{"id":"col_45c313f2b068a4d3b9ca4810126be6d8","status":"queued"}
elapsed 201s
$ ./events.sh blk
12:24:25.797 w1 rate-limited 6be6d8 RATE_LIMITED 10000
12:24:25.797 w2 rate-limited dae0d4 RATE_LIMITED 10000
12:24:35.811 w1 rate-limited 6be6d8 IP_BLOCKED 30000
12:24:35.816 w2 rate-limited dae0d4 IP_BLOCKED 30000
12:25:05.849 w2 rate-limited dae0d4 RATE_LIMITED 10000
12:25:15.870 w1 rate-limited dae0d4 RATE_LIMITED 10000
12:25:15.873 w2 rate-limited 6be6d8 IP_BLOCKED 30000
12:25:45.894 w1 rate-limited dae0d4 RATE_LIMITED 10000
12:25:45.899 w2 rate-limited 6be6d8 RATE_LIMITED 10000
12:25:55.910 w2 rate-limited dae0d4 IP_BLOCKED 30000
12:25:55.916 w1 rate-limited 6be6d8 IP_BLOCKED 30000
12:26:25.949 w1 rate-limited dae0d4 RATE_LIMITED 10000
12:26:25.955 w2 rate-limited 6be6d8 RATE_LIMITED 10000
12:26:35.966 w2 rate-limited dae0d4 IP_BLOCKED 30000
12:26:35.971 w1 rate-limited 6be6d8 IP_BLOCKED 30000
12:27:05.986 w1 rate-limited dae0d4 RATE_LIMITED 10000
12:27:05.989 w2 rate-limited 6be6d8 RATE_LIMITED 10000
12:27:15.998 w1 rate-limited 6be6d8 IP_BLOCKED 30000
12:27:16.000 w2 completed dae0d4   113
12:27:46.030 w2 completed 6be6d8   109
$ python3 trace.py <mark> target2.log
      0 /login            200
      1 /auth/otp         200
      2 /transactions  1  200
      4 /transactions  2  200
      7 /transactions  3  200
     10 /transactions  4  429
     10 /login            429
  10018 /login            200
  10019 /login            200
  10020 /auth/otp         200
  10021 /auth/otp         200
  10023 /transactions  4  200
  10023 /transactions  1  403
  10029 /transactions  5  403
  40044 /login            200
  40047 /auth/otp         200
  40049 /transactions  5  200
  40054 /transactions  6  200
  40057 /transactions  7  200
  40062 /transactions  8  429
  50075 /login            200
  50076 /login            200
  50078 /auth/otp         200
  50079 /auth/otp         200
  50082 /transactions  1  200
  50082 /transactions  8  429
  50086 /transactions  2  403
  80100 /login            200
  ...
  80106 /transactions  2  200
  80106 /transactions  8  429
  80112 /transactions  3  429
  90122 /transactions  3  200
  90122 /transactions  8  403
  90128 /transactions  4  403
 120161 /transactions  4  200
 120161 /transactions  8  429
 120167 /transactions  5  429
 130178 /transactions  5  200
 130179 /transactions  8  403
 130183 /transactions  6  403
 160198 /transactions  6  200
 160198 /transactions  8  429
 160202 /transactions  7  429
 170210 /transactions  8  200
 170211 /transactions  7  403
 200236 /transactions  7  200
 200241 /transactions  8  200
   (…는 매 주기의 /login·/auth/otp 네 줄을 줄인 것. 전체는 trace-blk.txt 74줄)
$ tsx ledger-check.mts ... (두 작업)
{"status":"completed","count":113,"rows":113,"expected":113,"equal":true}
{"status":"completed","count":109,"rows":109,"expected":109,"equal":true}
$ docker compose exec -T redis redis-cli hgetall progress:collections
pages 21  seen 20  cycles 0  until 1790339266018
$ docker compose exec -T redis redis-cli llen bull:collections-dead:wait
1          # 3절의 항목 그대로. 이 절에서 늘지 않았다
```

- **두 작업 모두 완료했고 원장과 일치합니다.** DLQ는 늘지 않았습니다. 3.3분(201초), 큐 정지 10번(429로
  10초 5번, 403 차단으로 30초 5번. 5×10 + 5×30 = 200초)입니다.
- **주기마다 누군가는 한 페이지 이상 받았습니다.** 요청 묶음 11개(0·10018·40044·…·200232ms) 모두에
  200을 받은 거래내역 페이지가 있습니다. 그래서 큐 전체의 연속 무진행 수는 매번 0으로 돌아갔고, 끝난 뒤
  `cycles`도 0입니다.
- **굶주림이 보입니다.** dae0d4(`from 2026-01-08`)는 40062ms에 7페이지까지 받은 뒤, 8페이지(끝을 확인하는
  빈 페이지) 요청이 여섯 주기 연속 429·403을 받았습니다(50082~160198ms, 약 2분). 그동안 6be6d8이 매 주기
  한 페이지씩 받아 큐가 나아갔으므로 상한에 걸리지 않았고, 170210ms에 8페이지를 받아 끝났습니다. 작업마다
  셌다면 이 작업이 DLQ로 갔습니다. **이 상한은 공정성을 다루지 않습니다.** 큐가 나아가는 동안 한 작업이
  계속 지는 것은 막지 않고, 작업이 계속 들어오는 큐에서 한 작업이 얼마나 늦어지는지는 재지 않았습니다.

## 5. N=2(로그인 비용 이하)에서 NO_PROGRESS (6e2af48)

창 10초에 요청 2개. 로그인 2요청이 창을 다 써서 1페이지에서 429입니다. 워커 2개, 작업 1건(`from 2026-01-10`).

```sh
$ ./run.sh n2 '{"switches":{"rateLimit":true,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":2,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' 2026-01-10
{"id":"col_13a4d326c400b1306dbe0cd6c3119c66","status":"queued"}
elapsed 31s
$ ./events.sh n2
12:28:05.722 w2 rate-limited 119c66 RATE_LIMITED 10000
12:28:15.735 w2 rate-limited 119c66 RATE_LIMITED 10000
12:28:25.748 w2 rate-limited 119c66 RATE_LIMITED 10000
12:28:35.761 w2 rate-limited 119c66 RATE_LIMITED 10000
12:28:35.768 w2 dead-letter 119c66 NO_PROGRESS   큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 1페이지에서 멈춤). ...
      0 /login            200
      0 /auth/otp         200
      1 /transactions  1  429
  10011 /login            200
  10013 /auth/otp         200
  10014 /transactions  1  429
  20024 /login            200
  20026 /auth/otp         200
  20027 /transactions  1  429
  30038 /login            200
  30039 /auth/otp         200
  30040 /transactions  1  429
$ curl -s localhost:8090/collections/col_13a4d326c400b1306dbe0cd6c3119c66
{"id":"col_13a4d326c400b1306dbe0cd6c3119c66","status":"failed","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-10 00:00:00","to":"2026-09-01 23:59:59"},"attemptsMade":1,"failure":{"kind":"NO_PROGRESS","detail":"큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 1페이지에서 멈춤). 창이 동시에 출발하는 워커들의 로그인 비용(워커당 2요청) 이하인지 대상 서버 임계값을 확인할 것. 마지막 실패 RATE_LIMITED: HTTP 429"}}
$ docker compose exec -T redis redis-cli hget bull:collections-dead:col_13a4d326c400b1306dbe0cd6c3119c66 data
{"originalId":"col_13a4d326c400b1306dbe0cd6c3119c66","kind":"NO_PROGRESS",...,"attemptsMade":1,"failedAt":"2026-09-25T12:28:35.764Z","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-10 00:00:00","to":"2026-09-01 23:59:59"},"raw":null}
$ docker compose exec -T redis redis-cli hgetall progress:collections
pages 21  seen 21  cycles 3  until 1790339325782
```

- 한 페이지도 못 받고 `attemptsMade` 0으로 돌다가, DLQ와 API 모두 kind NO_PROGRESS, `attemptsMade` 1로 끝났습니다.
- **429가 세 번이 아니라 네 번입니다.** 이 작업의 첫 제한 때 `pages`(21)가 `seen`(20)보다 컸습니다. 4절 마지막
  주기(170208ms 묶음의 403) 뒤에 6be6d8이 7페이지를 받았기 때문입니다(200236ms, 8페이지는 빈 페이지라 세지
  않습니다).
  "직전 주기 뒤로 큐의 어느 작업이든 페이지를 받았다"에 해당해 첫 주기는 진행으로 셌고, 그 뒤 세 주기로
  상한에 닿았습니다. 상태를 큐 전체로 두는 대가로, 앞선 작업의 진행이 다음 작업의 첫 주기에 넘어옵니다.
  CI 테스트(새 큐, `progress` 키 없음)에서는 세 번입니다.

## 6. 리뷰 결함 수정(fb9d6fa): 지난 사고의 연속 수·완료·늦게 센 페이지

빈 컨텍스트 리뷰가 6e2af48의 큐 전체 상한에서 셋을 찾았고, 리뷰 재현 스크립트(리포 밖, 워커를 같은
프로세스에 띄우고 진행 키를 심는다)로 모두 재현됐습니다.

| 결함 | 재현 | 6e2af48 | fb9d6fa |
|---|---|---|---|
| 1a. 지난 사고의 상태(5절 끝 pages 21 seen 21 cycles 3)를 이어받아, 회복된 큐의 첫 429에서 멀쩡한 작업이 실패 | `stale` | seed 없음 completed, seed 있음 failed("4번 연속") | 둘 다 completed |
| 1b·1c. 받은 페이지를 결과·체크포인트를 쓴 뒤에 세고, 같은 정지 안에서는 진행을 다시 보지 않아 다른 워커의 429가 무진행으로 셈 | `race 3 seed3` | 3회 모두 두 작업 failed | 3회 모두 completed. `race 5 seed`(연속 2 심음)도 0/5 실패 |
| 2. 페이지 없이 끝난 완료(빈 계좌 등)를 진행으로 세지 않음 | `completion` | completed completed failed failed failed | 5건 모두 completed |
| 3. 체크포인트와 진행 세기 사이에 죽으면 진행을 잃음 | (재현 없음, 코드 읽기) | | 받자마자 세므로 닫힘 |

고친 규칙(`process.ts` `DEFAULT_NO_PROGRESS_CYCLES`·`COUNT_CYCLE` 주석): 진행은 페이지를 받거나 작업을 완료한 것이고,
페이지는 받자마자(결과를 쓰기 전에) 셉니다. 같은 정지 안에서도 앞선 제한 뒤에 진행이 있었으면 0입니다. 직전 정지가
끝나고 60초가 지나 온 제한은 연속이 아니라 1부터 셉니다. 네 경우는 워커 테스트로 고정했고, 6e2af48의 process.ts로
돌리면 네 테스트 모두 실패합니다.

### 6-1. 재실행 준비: 남아 있던 진행 키 하나를 지웠다

5절이 남긴 `progress:collections`가 바로 결함 1a의 상태라, 재실행 전에 **그 키 하나만** 지웠습니다. 큐의 작업·결과·
DLQ는 그대로 두고, 작업 ID가 겹치지 않게 기간을 바꿨습니다.

```sh
$ docker compose exec -T redis redis-cli hgetall progress:collections
pages 21  seen 21  cycles 3  until 1790339325782
$ docker compose exec -T redis redis-cli del progress:collections
1
$ docker compose exec -T redis redis-cli llen bull:collections-dead:wait
2
```

대상 서버·API·워커 2개를 fb9d6fa 코드(7672244, 뒤 커밋은 테스트만 더함)로 새로 띄웠습니다. 조건은 실행 조건 표와 같습니다.

### 6-2. 속도 제한 + 출발지 차단, 기본값, 워커 2개, demo01 2건

4절과 같은 조건, 작업은 `from 2026-01-11`, `from 2026-01-12`.

```sh
$ ./run.sh blk2 '{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' 2026-01-11 2026-01-12
{"id":"col_d591f811334c867c0def8204e64a7523","status":"running"}
{"id":"col_85e077b799509dc3b1ca7086d7dd16aa","status":"queued"}
elapsed 211s
$ ./events.sh blk2          # 앞부분과 끝
13:10:42.542 w1 rate-limited dd16aa RATE_LIMITED 10000
13:10:42.546 w2 rate-limited 4a7523 RATE_LIMITED 10000
13:10:52.576 w1 rate-limited 4a7523 IP_BLOCKED 30000
13:10:52.581 w2 rate-limited dd16aa IP_BLOCKED 30000
...(30초·10초 간격으로 두 작업이 같이 제한을 받는 줄이 이어짐)
13:13:22.772 w1 rate-limited 4a7523 RATE_LIMITED 10000
13:13:22.775 w2 completed dd16aa   97
13:13:32.801 w1 rate-limited 4a7523 RATE_LIMITED 10000
13:13:42.850 w1 rate-limited 4a7523 IP_BLOCKED 30000
13:14:12.878 w2 completed 4a7523   101
$ # 요청 묶음마다(첫 요청 ms, lo=/login au=/auth/otp, 숫자=거래내역 페이지)
0      lo(200) au(200) 1(200) lo(200) au(200) 1(429) 2(429)
10056  lo(200) lo(200) au(200) au(200) 1(200) 2(403) 2(403)
40092  lo(200) lo(200) au(200) au(200) 2(200) 2(429) 3(429)
50140  lo(200) lo(200) au(200) au(200) 3(200) 2(403) 4(403)
80158  lo(200) lo(200) au(200) au(200) 4(200) 2(429) 5(429)
90181  lo(200) au(200) lo(200) 5(200) au(200) 2(403) 6(403)
120214 lo(200) lo(200) au(200) au(200) 6(200) 2(429) 7(429)
130232 lo(200) lo(200) au(200) au(200) 7(200) 2(403) 8(403)
160256 lo(200) lo(200) au(200) au(200) 8(200) 2(429)
170269 lo(200) au(200) 2(200) 3(200) 4(200) 5(429)
180313 lo(200) au(200) 5(200) 6(200) 7(200) 8(403)
210359 lo(200) au(200) 8(200)
$ tsx ledger-check.mts ... (두 작업)
{"status":"completed","count":101,"rows":101,"expected":101,"equal":true}
{"status":"completed","count":97,"rows":97,"expected":97,"equal":true}
$ docker compose exec -T redis redis-cli hgetall progress:collections
seen 15  cycles 0  until 1790342052849  pages 16
$ docker compose exec -T redis redis-cli llen bull:collections-dead:wait
2
```

- 두 작업 모두 완료, 원장과 일치, DLQ 추가 0건입니다. 211초, 큐 정지 11번(429로 10초 6번, 403 차단으로 30초 5번.
  6×10 + 5×30 = 210초). 요청 묶음 12개 모두에 200을 받은 페이지가 있습니다.
- **굶주림은 4절보다 길었습니다.** 4a7523(`from 2026-01-11`)은 첫 묶음에 1페이지를 받은 뒤 2페이지 요청이
  10056~160256ms의 여덟 묶음 동안 429·403이었습니다(약 150초). 그동안 dd16aa가 묶음마다 한 페이지씩 받았습니다.
  dd16aa가 끝난 뒤 창을 혼자 쓰며 두 묶음에 3페이지씩 받아 끝났습니다. 고친 코드도 공정성은 다루지 않습니다.

### 6-3. N=2, demo01 1건

6-2가 끝나고 20초 뒤(직전 정지가 끝난 13:14:12에서 60초 안) 시작했습니다. `from 2026-01-13`.

```sh
$ date -u +%H:%M:%S; docker compose exec -T redis redis-cli hgetall progress:collections
13:14:32
seen 15  cycles 0  until 1790342052849  pages 16
$ ./run.sh n2b '{"switches":{"rateLimit":true,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":2,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' 2026-01-13
{"id":"col_9c89a62b77eec5058366bd417bbf915f","status":"queued"}
elapsed 31s
$ ./events.sh n2b
13:14:32.773 w2 rate-limited bf915f RATE_LIMITED 10000
13:14:42.794 w1 rate-limited bf915f RATE_LIMITED 10000
13:14:52.809 w1 rate-limited bf915f RATE_LIMITED 10000
13:15:02.823 w1 rate-limited bf915f RATE_LIMITED 10000
13:15:02.830 w1 dead-letter bf915f NO_PROGRESS   큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 1페이지에서 멈춤). ...
      0 /login            200
      1 /auth/otp         200
      1 /transactions  1  429
  10016 /login            200
  10020 /auth/otp         200
  10022 /transactions  1  429
  20034 /login            200
  20036 /auth/otp         200
  20036 /transactions  1  429
  30047 /login            200
  30049 /auth/otp         200
  30050 /transactions  1  429
$ curl -s localhost:8090/collections/col_9c89a62b77eec5058366bd417bbf915f
{"id":"col_9c89a62b77eec5058366bd417bbf915f","status":"failed","request":{"loginId":"demo01","accountNo":"000-11-222333","from":"2026-01-13 00:00:00","to":"2026-09-01 23:59:59"},"attemptsMade":1,"failure":{"kind":"NO_PROGRESS","detail":"큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 1페이지에서 멈춤). ..."}}
$ docker compose exec -T redis redis-cli hgetall progress:collections
seen 16  cycles 3  until 1790342112818  pages 16
$ docker compose exec -T redis redis-cli llen bull:collections-dead:wait
3
```

- N=2는 여전히 NO_PROGRESS로 DLQ에 갑니다. 429는 이번에도 네 번입니다. 직전 정지가 끝난 지 60초가 안 돼 연속이
  이어졌고, 6-2의 마지막 완료(4a7523, `pages` 16 > `seen` 15)가 첫 주기의 진행으로 세어졌습니다. 완료도 진행으로
  센다는 고친 규칙 그대로입니다. 60초가 지난 뒤 시작했거나 앞 실행이 없었으면 세 번입니다(CI 테스트).
- 남은 `progress:collections`는 cycles 3입니다. 60초 안에 멀쩡한 작업이 429를 받으면 5절과 같은 일이 생길 수
  있지만, 60초가 지나면 다음 제한은 1부터 셉니다(6절 결함 1a 수정).
- DLQ 메시지의 "새 페이지 없음"은 지금 규칙(페이지나 완료)보다 좁은 말입니다. 문구는 고치지 않았습니다.
- 끝나고 네 프로세스(대상 서버·API·워커 2개)는 띄울 때 적은 PID로만 내렸고 포트는 비었습니다.

## 7. 최종 리뷰 수정(a986ffc, 28c857c) 뒤 한 번 더: 속도 제한 + 출발지 차단, 워커 2개

a986ffc는 큐 정지를 각 작업의 Retry-After가 아니라 주기 창(`until`) 끝에 맞춥니다. 같은 정지 안에서 뒤에
온 짧은 제한이 앞선 긴 정지를 덮어쓰지 않게 하려는 것이라 COUNT_CYCLE의 동작이 바뀌어, 4절 조건을 28c857c
코드로 한 번 돌렸습니다. 작업은 `from 2026-01-14`, `from 2026-01-15`. `progress:collections`는 6-3이 남긴
상태(`pages 16 seen 16 cycles 3`, 약 90분 전)를 그대로 두었습니다.

```sh
$ ./run.sh blk3 '{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}' 2026-01-14 2026-01-15
{"id":"col_126b49d6d2987bde0d9b5fcd25928710","status":"queued"}
{"id":"col_fd5aa411f8ff919aa3d99b8aa4c4e8b9","status":"queued"}
elapsed 181s
14:46:58.968 w1 completed 928710   89
14:47:49.023 w2 completed c4e8b9   85
$ # 요청 묶음(첫 요청 ms, lo=/login au=/auth/otp, 숫자=거래내역 페이지)
0      lo(200) au(200) 1(200) lo(200) au(200) 1(429) 2(429)
10034  lo(200) lo(200) au(200) au(200) 2(200) 1(403) 3(403)
40061  lo(200) lo(200) au(200) au(200) 3(200) 1(429) 4(429)
50075  lo(200) au(200) 4(200) lo(200) au(200) 1(403) 5(403)
80090  lo(200) lo(200) au(200) au(200) 5(200) 1(429) 6(429)
90107  lo(200) lo(200) au(200) au(200) 6(200) 1(403) 7(403)
120123 lo(200) lo(200) au(200) au(200) 7(200) 1(429) 8(429)
130140 lo(200) lo(200) au(200) au(200) 8(200) 1(403)
160150 lo(200) au(200) 1(200) 2(200) 3(200) 4(429)
170165 lo(200) au(200) 4(200) 5(200) 6(200) 7(429)
180189 lo(200) au(200) 7(200) 8(200)
$ # 묶음 사이 간격(ms)
[10034, 30027, 10014, 30015, 10017, 30016, 10017, 30010, 10015, 10024]
$ tsx ledger-check.mts ... (두 작업)
{"status":"completed","count":89,"rows":89,"expected":89,"equal":true}
{"status":"completed","count":85,"rows":85,"expected":85,"equal":true}
$ docker compose exec -T redis redis-cli hgetall progress:collections
seen 30  cycles 0  until 1790347669035  pages 32
$ docker compose exec -T redis redis-cli llen bull:collections-dead:wait
3
```

- 두 작업 모두 완료, 원장과 일치, DLQ 추가 0건입니다. 181초, 큐 정지 10번(429로 10초 6번, 403 차단으로
  30초 4번. 6×10 + 4×30 = 180초). 묶음 사이 간격이 그 묶음의 Retry-After(10초·30초)와 수십 ms 안에서 같았습니다.
- 약 90분 전의 `cycles 3`은 첫 주기에 작업을 실패시키지 않았습니다(60초 끊김 규칙).
- c4e8b9(`from 2026-01-15`)는 1페이지 요청이 0~130140ms의 여덟 묶음 동안 429·403이었습니다. 굶주림은 6-2와 같은 길이입니다.
- **이번 실행에는 한 정지 안에 429와 403이 섞인 묶음이 없었습니다.** a986ffc가 고친 경우(긴 정지 뒤 짧은
  제한)는 실측에서 일어나지 않았고, 워커 테스트로만 확인했습니다.
- 네 프로세스는 띄울 때 적은 PID로만 내렸습니다.

## 정리

| 조건 | 이어받기 전(1158b74) | 작업마다 센 상한(2a7622b) | 큐 전체로 센 상한(6e2af48) | 리뷰 수정(fb9d6fa) |
|---|---|---|---|---|
| 속도 제한, W=10 N=5, demo01 1건 | 40초 동안 다섯 주기 모두 4페이지에서 막혀 `queued` | 20초에 완료, 137행 원장 일치 | 20초에 완료, 117행 원장 일치 | (다시 재지 않음. 이어받기 코드는 같다) |
| 속도 제한 + 차단, 기본값, 워커 2개, demo01 2건 | (재지 않음) | 1건 NO_PROGRESS 오탐(큐는 주기마다 나아감), 1건 완료 | 2건 모두 완료(201초). 1건이 여섯 주기 굶음 | 2건 모두 완료(211초, 최종 수정 뒤 181초). 1건이 여덟 주기 굶음(두 번 모두) |
| N=2, demo01 1건 | (재지 않음) | (실측 안 함, CI만) | 429 네 번 뒤 NO_PROGRESS. 끝 상태 cycles 3이 남음 | 429 네 번 뒤 NO_PROGRESS(앞 실행의 완료가 첫 주기 진행) |
| 5절 끝 상태(cycles 3) 위의 멀쩡한 작업 | | | 첫 429에 NO_PROGRESS(리뷰 재현) | 60초 지난 연속은 끊겨 완료(리뷰 재현, 워커 테스트, 7절 실측) |

- 끝나지 않던 것은 풀렸습니다. 창보다 큰 작업이 받은 페이지부터 이어받아 끝납니다.
- 로그인 비용 이하 창은 NO_PROGRESS로 DLQ에 남습니다. 시도 횟수는 깎지 않았습니다.
- 남는 것: 굶주림(4절 여섯 주기, 6-2 여덟 주기), 60초 안에 시작한 다음 실행의 첫 주기가 앞선 진행을 넘겨받는
  것(5절, 6-3), 페이지를 받은 뒤 진행을 세는 한 번 왕복보다 짧은 경쟁(fb9d6fa 커밋의 Not-tested), 세션 재사용
  없음(매 주기 로그인 2요청, 이슈 #19의 안 하는 것).
- 프로세스는 띄울 때 적어 둔 PID로만 내렸습니다. 큐 `collections`에서 지운 것은 6-1의 `progress:collections` 키
  하나뿐입니다. 작업·결과·DLQ(3건)는 남아 있습니다.

## 부록: 스크립트

### run.sh

```bash
#!/usr/bin/env bash
# 사용: run.sh <이름> <스위치 JSON> <from...>  demo01 작업을 from마다 하나씩(to 2026-09-01) 넣고 끝날 때까지 본다.
set -uo pipefail
SP=$(cd "$(dirname "$0")" && pwd); cd "$SP"
name=$1; sw=$2; shift 2
curl -s -H 'content-type: application/json' -d "$sw" localhost:8081/admin/switches; echo
wc -l < target2.log | tr -d ' ' > mark-$name; wc -l < w1.log | tr -d ' ' > markw1-$name; wc -l < w2.log | tr -d ' ' > markw2-$name
: > ids-$name.txt
for f in "$@"; do
  curl -s -H 'content-type: application/json' -d "{\"loginId\":\"demo01\",\"accountNo\":\"000-11-222333\",\"from\":\"$f\",\"to\":\"2026-09-01\"}" localhost:8090/collections | tee -a ids-$name.txt; echo >> ids-$name.txt; echo
done
start=$(date +%s)
while :; do
  done_n=0
  for id in $(python3 -c "import json,sys;[print(json.loads(l)['id']) for l in open('ids-$name.txt') if l.strip()]"); do
    s=$(curl -s localhost:8090/collections/$id | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
    case $s in completed|failed) done_n=$((done_n+1));; esac
  done
  [ "$done_n" = "$#" ] && break
  [ $(( $(date +%s) - start )) -gt 400 ] && { echo TIMEOUT; break; }
  sleep 2
done
echo "elapsed $(( $(date +%s) - start ))s"
```

### events.sh

```bash
#!/usr/bin/env bash
# 사용: events.sh <이름>  그 실행 동안의 워커 로그를 시각순으로 줄여 찍는다.
cd "$(dirname "$0")"; n=$1
(tail -n +$(( $(cat markw1-$n)+1 )) w1.log; tail -n +$(( $(cat markw2-$n)+1 )) w2.log) | sort | python3 -c '
import json,sys
for l in sys.stdin:
    r=json.loads(l); print(r["t"][11:23], r["worker"], r["event"], r.get("jobId","")[-6:], r.get("kind",""), r.get("waitMs",""), r.get("rows",""), (r.get("detail","") or "")[:70])'
```

### trace.py

```python
# target.log(Fastify JSON 로그)에서 mark 줄 이후 요청을 "시각(첫 요청 기준 ms) 경로 페이지 상태"로 뽑는다.
import json, sys
mark = int(sys.argv[1]) if len(sys.argv) > 1 else 0
urls, start = {}, None
for i, line in enumerate(open(sys.argv[2] if len(sys.argv) > 2 else 'target.log')):
    if i < mark: continue
    try: r = json.loads(line)
    except Exception: continue
    if 'req' in r: urls[r['reqId']] = r['req']['url']
    if 'res' in r:
        u = urls.get(r['reqId'], '?')
        if u.startswith('/admin') or u == '/health': continue
        path, _, q = u.partition('?')
        page = dict(p.split('=') for p in q.split('&') if '=' in p).get('page', '')
        if start is None: start = r['time']
        print(f"{r['time'] - start:>7} {path:<14} {page:<2} {r['res']['statusCode']}")
```

### ledger-check.mts

```ts
// API 응답(result.rows)을 대상 서버 원장과 비교한다. 인자: 응답 JSON 경로, 계좌, 건수, from, to.
import { readFileSync } from 'node:fs';
import { buildLedger } from '<리포>/target/transactions.ts';
const [file, account, count, from, to] = process.argv.slice(2) as [string, string, string, string, string];
const view = JSON.parse(readFileSync(file, 'utf8'));
const expected = buildLedger(account, Number(count)).filter((r) => r.at >= from && r.at <= to);
console.log(JSON.stringify({ status: view.status, count: view.result?.count, rows: view.result?.rows.length, expected: expected.length, equal: JSON.stringify(view.result?.rows) === JSON.stringify(expected) }));
```
