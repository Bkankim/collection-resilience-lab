# D3 증거: 출발지 전환(#14) 실측 기록

`collector/client/origins.test.ts`와 `collector/worker/process.test.ts`의 `큐 워커: 출발지 전환(#14)`이 전환 규칙을
CI에서 검증합니다. 다만 그 테스트 안에서는 출발지가 전부 127.0.0.1이라, 대상 서버가 소켓 주소로 출발지를 가르는
것은 볼 수 없습니다. 이 파일은 **compose로 띄운 대상 서버·프록시 2개와 호스트의 워커 프로세스 2개**로 대상
서버 로그에 찍힌 출발지 주소를 본 기록입니다(D1 규칙).

| 절 | 코드 | 무엇을 보나 |
|---|---|---|
| 1 | 50a5e23 (전환 전) | 출발지가 하나라 IP_BLOCKED면 큐 전체가 Retry-After만큼 멈춘다 |
| 2 | - | 가설 H1(대상 서버 위치), H2(undici 연결 풀), H3(세션과 출발지) |
| 3 | 이 브랜치 | 전환 전후 출발지 주소, 모두 막혔을 때 가장 빠른 해제까지 정지, 결과 행 수 = 원장 |
| 4 | 이 브랜치 | 창이 두 워커의 로그인 비용과 같으면(N=4) 모두 막힌 채 NO_PROGRESS로만 DLQ |
| 5 | 이 브랜치 | 출발지별 성공·실패 수 로그, 테스트와 대조 실행 |
| 6 | final-review 반영 뒤 | 리뷰 결함 수정, keep-alive 확인, 3절 조건 재실측 |

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-27 KST (로그 시각은 UTC 2026-09-26 18:39~18:56) |
| Node | 워커 v26.4.0, 대상 서버 컨테이너 v24.21.0 (`node:24-alpine`) |
| bullmq / ioredis / undici | 6.3.8 / 5.11.1 / 8.10.2 |
| Redis | `docker compose` redis:7-alpine (7.4.11). 원래 떠 있던 컨테이너를 그대로 썼다 |
| 프록시 | tinyproxy 1.11.2 (alpine 3.20 패키지) 두 개, 고정 IP 172.28.14.11(`proxy-a`, 호스트 3128), 172.28.14.12(`proxy-b`, 호스트 3129) |
| 대상 서버 | 1절은 호스트 `PORT=8081 tsx target/server.ts`. 2절 H1 뒤부터 compose `target`(172.28.14.10, 호스트 8080) |
| 워커 | `WORKER_NAME=w1`, `w2` 두 프로세스(1절은 w1 하나). `TARGET_ORIGIN=http://target:8080`, `WORKER_PROXIES=http://127.0.0.1:3128,http://127.0.0.1:3129`, concurrency 1, limiter 기본, 진행 기반 상한 기본 3 |
| 큐 | 다른 작업과 섞이지 않게 절마다 새 큐(`d3origin-pre`, `d3origin`, `d3origin2`). 작업은 부록의 `enqueue.mts`로 넣었다 |
| 컨테이너 런타임 | colima 0.10.3, Docker Compose 5.3.0, curl 8.7.1 |

대상 서버 로그 시각은 colima VM 시계라 호스트(워커 로그)보다 0.1~0.2초 앞서고, 3절 도중 한 번 109ms 뒤로 물러났습니다
(req-1u). 시각은 같은 로그 안에서만 비교하고, 3절 표는 로그 순서대로 둡니다.

demo01(137건)은 7페이지이고, 작업 하나가 보내는 요청은 로그인 2 + 페이지 7 + 끝을 확인하는 빈 8페이지 1개입니다.
기간이 다른 demo01 작업 4건의 원장 행 수는 137, 137, 133, 129입니다.

## 1. 전환 전(50a5e23): 출발지가 하나라 큐 전체가 Retry-After만큼 멈춘다

```sh
$ PORT=8081 tsx target/server.ts                    # 호스트
$ QUEUE_NAME=d3origin-pre WORKER_NAME=w1 TARGET_ORIGIN=http://127.0.0.1:8081 tsx collector/worker/index.ts
$ curl -s -H 'content-type: application/json' -d '{"switches":{"rateLimit":true,"ipBlock":true},"thresholds":{"windowSec":2,"maxRequests":4,"blockAfter":2,"blockDurationSec":10}}' localhost:8081/admin/switches
{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":2,"maxRequests":4,"blockAfter":2,"blockDurationSec":10,"sessionTtlSec":60}}
$ tsx enqueue.mts d3origin-pre demo01 000-11-222333 2026-01-01 2026-09-01
col_55791c502578c0f4189d5673eea749ae
```

워커 로그:

```
{"t":"2026-09-26T18:40:58.269Z","worker":"w1","pid":88736,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":2000,"detail":"HTTP 429"}
{"t":"2026-09-26T18:41:00.294Z","worker":"w1","pid":88736,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"IP_BLOCKED","waitMs":10000,"detail":"HTTP 403 + Retry-After, 본문 IP_BLOCKED"}
{"t":"2026-09-26T18:41:10.317Z","worker":"w1","pid":88736,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":2000,"detail":"HTTP 429"}
{"t":"2026-09-26T18:41:12.340Z","worker":"w1","pid":88736,"event":"completed","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"rows":137}
```

대상 서버 요청(부록 `trace.py`, 첫 요청 기준 ms, 출발지, 경로, 페이지, 상태):

```
첫 요청 2026-09-26T18:40:58.236Z
      0 127.0.0.1       /login            200
      4 127.0.0.1       /auth/otp         200
     20 127.0.0.1       /transactions   1 200
     29 127.0.0.1       /transactions   2 200
     33 127.0.0.1       /transactions   3 429
   2043 127.0.0.1       /login            200
   2045 127.0.0.1       /auth/otp         200
   2048 127.0.0.1       /transactions   3 200
   2054 127.0.0.1       /transactions   4 200
   2057 127.0.0.1       /transactions   5 403
  12067 127.0.0.1       /login            200
  12069 127.0.0.1       /auth/otp         200
  12072 127.0.0.1       /transactions   5 200
  12077 127.0.0.1       /transactions   6 200
  12081 127.0.0.1       /transactions   7 429
  14092 127.0.0.1       /login            200
  14094 127.0.0.1       /auth/otp         200
  14096 127.0.0.1       /transactions   7 200
  14101 127.0.0.1       /transactions   8 200
$ tsx status.mts d3origin-pre col_55791c502578c0f4189d5673eea749ae
{"id":"col_55791c502578c0f4189d5673eea749ae","state":"completed","attemptsMade":1,"results":137,"ledger":137,"match":true}
```

출발지는 127.0.0.1 하나입니다. 2057ms에 403(IP_BLOCKED, Retry-After 10)을 받고 12067ms까지 **10초 동안 요청이 0건**입니다.
큐 전체가 차단 시간만큼 멈췄고 시도 횟수는 0입니다. 작업은 이어받기(#19)로 끝났습니다.

## 2. 가설

### H1: 대상 서버를 호스트에 두면 두 프록시가 같은 출발지로 보인다 (확정, 예상과 모양이 다름)

프록시만 compose로 띄우고 1절의 호스트 대상 서버(8081)로 보냈습니다. 컨테이너에서 호스트는 `host.docker.internal`
(192.168.5.2)입니다. 로그인을 보내면 계정 잠금 카운터가 오르므로 세션 없는 조회를 보냈습니다.

```sh
$ curl -s -x http://127.0.0.1:3128 http://host.docker.internal:8081/transactions
{"error":"NO_SESSION"}
$ curl -s -x http://127.0.0.1:3129 http://host.docker.internal:8081/transactions
{"error":"NO_SESSION"}
$ curl -s http://127.0.0.1:8081/transactions
{"error":"NO_SESSION"}
# 대상 서버 로그의 incoming request
GET /transactions host=host.docker.internal:8081 remoteAddress=127.0.0.1
GET /transactions host=host.docker.internal:8081 remoteAddress=127.0.0.1
GET /transactions host=127.0.0.1:8081 remoteAddress=127.0.0.1
```

두 프록시가 같은 주소일 뿐 아니라 호스트에서 바로 보낸 요청과도 같은 127.0.0.1입니다. 가설은 VM 게이트웨이 주소를
예상했지만, colima는 VM에서 호스트로 가는 연결을 호스트의 루프백으로 넘깁니다. 어느 쪽이든 출발지는 하나라 가설은
맞습니다. 그래서 대상 서버를 compose 네트워크(`origins`, 172.28.14.0/24)에 넣었습니다(`target/Dockerfile`).

```sh
$ curl -s -x http://127.0.0.1:3128 http://target:8080/transactions
$ curl -s -p -x http://127.0.0.1:3128 http://target:8080/transactions   # CONNECT
$ curl -s -x http://127.0.0.1:3129 http://target:8080/transactions
$ curl -s -p -x http://127.0.0.1:3129 http://target:8080/transactions   # CONNECT
$ curl -s http://127.0.0.1:8080/transactions
(다섯 번 모두 {"error":"NO_SESSION"})
# docker compose logs target 의 incoming request
GET /transactions host=target:8080 remoteAddress=172.28.14.11
GET /transactions host=target:8080 remoteAddress=172.28.14.11
GET /transactions host=target:8080 remoteAddress=172.28.14.12
GET /transactions host=target:8080 remoteAddress=172.28.14.12
GET /transactions host=127.0.0.1:8080 remoteAddress=172.28.14.1
```

프록시마다 고정 IP가 출발지로 찍히고, 호스트에서 바로 보낸 요청(관리 API가 여기로 온다)은 게이트웨이 172.28.14.1입니다.

### H2: 출발지마다 ProxyAgent를 두면 전환 직후 요청이 새 출발지로 나간다 (확정)

같은 전송 코드(`createUndiciTransport`)에 출발지마다 `ProxyAgent`를 따로 넣어 번갈아 보냈습니다(부록 `h2.mts`).
대상 서버 로그의 주소와 포트입니다.

```
a1 172.28.14.11 56104
a2 172.28.14.11 56112
a3 172.28.14.11 56116
b1 172.28.14.12 44612
b2 172.28.14.12 44626
b3 172.28.14.12 44630
a4 172.28.14.11 56122
g-a 172.28.14.11 56130                # dispatcher 없는 전송, 전역 = A
g-b 172.28.14.12 44646                # 같은 전송, 전역을 B로 바꾼 뒤
a5-while-global-b 172.28.14.11 56132  # A를 쥔 전송은 전역이 B여도 A
```

- 전환 직후 첫 요청(b1, a4)부터 새 주소입니다. 옛 출발지로 새지 않았습니다.
- 대상 서버가 보는 포트가 요청마다 다릅니다. undici 8.10.2는 http 대상에 CONNECT를 쓰지 않고 절대 경로 요청을 프록시로
  보내며(`proxy-agent.js` `shouldProxyTunnel`: `proxyTunnel === true`이거나 https일 때만 터널), tinyproxy는 그 요청마다
  대상으로 새 연결을 엽니다(위 포트가 요청마다 다르고, tinyproxy 로그에 요청 하나마다 `Established connection to host "target"`
  다음 `Closed connection`이 찍힌다. 3·4절 동안 요청·연결·닫힘 수가 proxy-a 58·58·58, proxy-b 46·46·46). 그래서 이 구성에서는
  대상 서버 쪽 keep-alive가 출발지를 넘나들 여지가 없습니다. 워커와 프록시 사이의 연결은 `ProxyAgent`마다 따로입니다.
- 섞이는 경우는 dispatcher 없이 만든 전송입니다. 그 전송은 **요청 시점의** 전역 dispatcher로 나가므로(g-a, g-b) 어디로
  나갈지가 전역 상태에 달립니다. 그래서 출발지마다 dispatcher를 쥔 전송을 따로 만들고 바꾸지 않습니다(`origins.ts`).
  반대 방향(전역을 바꿔도 A를 쥔 전송은 A)은 a5가 보입니다.

같은 확인을 CI에서도 합니다. `origins.test.ts`가 프록시 두 개를 이 프로세스에 띄우고, 출발지마다 제 프록시로만 나가는지
(A A B B A)를 봅니다. 둘 다 127.0.0.1이라 주소 대신 프록시가 실은 헤더로 가릅니다.

### H3: 대상 서버는 세션을 출발지에 묶지 않는다 (확정, 가정대로 다시 로그인한다)

`target/sessions.ts`의 `Session`에는 발급 출발지 필드가 없고, `target/app.ts`는 세션을 쿠키로만 찾습니다. 실제로 A로
로그인한 세션을 B로 보냈습니다(부록 `h3.mts`).

```
login via A: ok
page 1 via B: ok 12 rows stats {"logins":1,"reauths":0,"requests":3}
POST /login 172.28.14.11 200
POST /auth/otp 172.28.14.11 200
GET /transactions?account=000-44-555666&page=1 172.28.14.12 200
```

전환 뒤 세션을 다시 만들지 않아도 이 대상 서버에서는 동작합니다. 세션을 발급 출발지에 묶는 기관을 가정해(`errors.ts`
`FIRST_REMEDY.IP_BLOCKED`의 REAUTH) 전환 뒤에는 로그인부터 다시 합니다. 대상 서버는 바꾸지 않았습니다. 대가는 전환마다
로그인 2요청이고, 3절에서 그만큼 창을 더 씁니다.

## 3. 전환 뒤: 다른 출발지로 바로 이어 받고, 모두 막히면 가장 빠른 해제까지 멈춘다

compose 대상 서버를 다시 띄워(`docker compose restart target`, 차단 상태 초기화) 워커 2개로 demo01 작업 4건을 넣었습니다.
임계값은 W=2초, N=8, M=2, T=10초입니다. N=8은 두 워커가 같이 출발해도 로그인(4요청) 뒤에 페이지를 받을 자리가 남는 값입니다
(같지 않은 경우가 4절).

```sh
$ docker compose up -d                      # target, proxy-a, proxy-b, redis
$ QUEUE_NAME=d3origin2 TARGET_ORIGIN=http://target:8080 WORKER_PROXIES=http://127.0.0.1:3128,http://127.0.0.1:3129 WORKER_NAME=w1 tsx collector/worker/index.ts
$ (w2 같은 환경변수)
{"t":"2026-09-26T18:54:54.617Z","worker":"w1","pid":22301,"event":"ready","queue":"d3origin2","origin":"http://target:8080","proxies":["http://127.0.0.1:3128","http://127.0.0.1:3129"],"concurrency":1,"limiter":{"max":100,"duration":1000},"noProgressCycles":3}
$ curl -s -H 'content-type: application/json' -d '{"switches":{"rateLimit":true,"ipBlock":true},"thresholds":{"windowSec":2,"maxRequests":8,"blockAfter":2,"blockDurationSec":10}}' localhost:8080/admin/switches
{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":2,"maxRequests":8,"blockAfter":2,"blockDurationSec":10,"sessionTtlSec":60}}
$ tsx enqueue.mts d3origin2 demo01 000-11-222333 2026-01-01 2026-09-01 2026-01-02 2026-09-01 2026-01-03 2026-09-01 2026-01-04 2026-09-01
col_55791c502578c0f4189d5673eea749ae
col_fe99bf7049c4171bb4a0210ea1b2a012
col_d92aa799027219910430374909f4c7e8
col_a0f4623b3dc526686dda8319afcadfe8
(3초마다 status.mts, 4건 모두 끝날 때까지)
elapsed 26s
{"id":"col_55791c502578c0f4189d5673eea749ae","state":"completed","attemptsMade":1,"results":137,"ledger":137,"match":true}
{"id":"col_fe99bf7049c4171bb4a0210ea1b2a012","state":"completed","attemptsMade":1,"results":137,"ledger":137,"match":true}
{"id":"col_d92aa799027219910430374909f4c7e8","state":"completed","attemptsMade":1,"results":133,"ledger":133,"match":true}
{"id":"col_a0f4623b3dc526686dda8319afcadfe8","state":"completed","attemptsMade":1,"results":129,"ledger":129,"match":true}
```

**4건 모두 완료, 결과 행 수(HLEN `results:d3origin2:<id>`)가 원장과 같습니다.** DLQ(`d3origin2-dead`)는 0건, 끝난 뒤
`progress:d3origin2`는 `pages 32 seen 30 cycles 0`입니다.

### 3-1. 전환 전후 출발지 주소 (대상 서버 로그 원문)

`docker compose logs --no-log-prefix target`에서 관리 API 줄을 뺀 원문입니다(`hostname`·`pid`·`level`은 같은 값이라 한 줄만 둡니다: `"pid":23,"hostname":"714c8c535e75"`, 컨테이너 ID).

```
{"level":30,"time":1790448897722,"reqId":"req-a","req":{"method":"GET","url":"/transactions?account=000-11-222333&page=3","host":"target:8080","remoteAddress":"172.28.14.11","remotePort":48650},"msg":"incoming request"}
{"level":30,"time":1790448897722,"reqId":"req-a","res":{"statusCode":429},"responseTime":0.21865399999933288,"msg":"request completed"}
{"level":30,"time":1790448897722,"reqId":"req-b","req":{"method":"GET","url":"/transactions?account=000-11-222333&page=3","host":"target:8080","remoteAddress":"172.28.14.11","remotePort":48666},"msg":"incoming request"}
{"level":30,"time":1790448897722,"reqId":"req-b","res":{"statusCode":403},"responseTime":0.09542200000032608,"msg":"request completed"}
{"level":30,"time":1790448897725,"reqId":"req-c","req":{"method":"POST","url":"/login","host":"target:8080","remoteAddress":"172.28.14.12","remotePort":54052},"msg":"incoming request"}
{"level":30,"time":1790448897725,"reqId":"req-c","res":{"statusCode":200},"responseTime":0.2692670000005819,"msg":"request completed"}
{"level":30,"time":1790448897727,"reqId":"req-d","req":{"method":"POST","url":"/auth/otp","host":"target:8080","remoteAddress":"172.28.14.12","remotePort":54066},"msg":"incoming request"}
{"level":30,"time":1790448897727,"reqId":"req-d","res":{"statusCode":200},"responseTime":0.3877810000003592,"msg":"request completed"}
{"level":30,"time":1790448897729,"reqId":"req-e","req":{"method":"GET","url":"/transactions?account=000-11-222333&page=3","host":"target:8080","remoteAddress":"172.28.14.12","remotePort":54068},"msg":"incoming request"}
```

w1이 172.28.14.11에서 3페이지에 403(req-b)을 받고 **3ms 뒤** 172.28.14.12에서 로그인부터 다시 해(req-c, req-d) 3페이지를
이어 받습니다(req-e). 워커 로그의 같은 자리입니다. 같은 순간 w2는 같은 출발지에서 429(req-a)를 받아 전환하지 않고 큐를 멈췄습니다.

```
{"t":"2026-09-26T18:54:57.611Z","worker":"w1","pid":22301,"event":"origin-result","jobId":"col_fe99bf7049c4171bb4a0210ea1b2a012","origin":"http://127.0.0.1:3128","outcome":"IP_BLOCKED","ok":0,"failed":1}
{"t":"2026-09-26T18:54:57.611Z","worker":"w1","pid":22301,"event":"origin-rotated","jobId":"col_fe99bf7049c4171bb4a0210ea1b2a012","from":"http://127.0.0.1:3128","to":"http://127.0.0.1:3129","blockedUntil":"2026-09-26T18:55:07.611Z","detail":"HTTP 403 + Retry-After, 본문 IP_BLOCKED"}
{"t":"2026-09-26T18:54:57.611Z","worker":"w2","pid":22300,"event":"origin-result","jobId":"col_55791c502578c0f4189d5673eea749ae","origin":"http://127.0.0.1:3128","outcome":"RATE_LIMITED","ok":0,"failed":1}
{"t":"2026-09-26T18:54:57.611Z","worker":"w2","pid":22300,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":2000,"detail":"HTTP 429"}
{"t":"2026-09-26T18:54:57.634Z","worker":"w1","pid":22301,"event":"origin-result","jobId":"col_fe99bf7049c4171bb4a0210ea1b2a012","origin":"http://127.0.0.1:3129","outcome":"ok","ok":1,"failed":0}
{"t":"2026-09-26T18:54:57.636Z","worker":"w1","pid":22301,"event":"completed","jobId":"col_fe99bf7049c4171bb4a0210ea1b2a012","attemptsMade":0,"rows":137}
```

전환에는 `rate-limited`가 없습니다. 큐를 멈추지 않았고(주기로 세지 않았고) `attemptsMade`는 0으로 완료했습니다.

### 3-2. 모두 막히면 가장 빨리 풀리는 시각까지 큐 전체가 멈추고 이어 간다

전체 요청(로그 순서, 첫 요청 2026-09-26T18:54:57.667Z 기준 ms):

```
      0 172.28.14.11    /login            200
      1 172.28.14.11    /login            200
      9 172.28.14.11    /auth/otp         200
     11 172.28.14.11    /auth/otp         200
     36 172.28.14.11    /transactions   1 200
     37 172.28.14.11    /transactions   1 200
     50 172.28.14.11    /transactions   2 200
     51 172.28.14.11    /transactions   2 200
     55 172.28.14.11    /transactions   3 429
     55 172.28.14.11    /transactions   3 403
     58 172.28.14.12    /login            200      <- w1 전환(3-1)
     60 172.28.14.12    /auth/otp         200
     62 172.28.14.12    /transactions   3 200
     65 172.28.14.12    /transactions   4 200
     69 172.28.14.12    /transactions   5 200
     72 172.28.14.12    /transactions   6 200
     76 172.28.14.12    /transactions   7 200
     79 172.28.14.12    /transactions   8 200      <- w1 첫 작업 완료
   2075 172.28.14.12    /login            200      <- 큐 정지(w2의 429, 2초)가 끝남. w1은 A가 막힌 것을 알아 B로
   2080 172.28.14.11    /login            403      <- w2는 A가 막힌 것을 모른다(프로세스마다 상태) -> 403 받고 B로
   2083 172.28.14.12    /auth/otp         200
   2089 172.28.14.12    /login            200
   2095 172.28.14.12    /transactions   1 200
   2098 172.28.14.12    /auth/otp         200
   2100 172.28.14.12    /transactions   3 200
   2101 172.28.14.12    /transactions   2 200
   2104 172.28.14.12    /transactions   4 200
   2104 172.28.14.12    /transactions   3 429
   2108 172.28.14.12    /transactions   5 403      <- B도 막힘. w2 모두 막힘, A의 해제(7977ms 뒤)까지 정지
  10101 172.28.14.11    /login            200      <- A가 풀려 A로 재개
  10107 172.28.14.11    /auth/otp         200
  10111 172.28.14.11    /transactions   5 200
  10117 172.28.14.11    /transactions   6 200
  10123 172.28.14.11    /transactions   7 200
  10128 172.28.14.11    /transactions   8 200
  10136 172.28.14.11    /login            200
  10138 172.28.14.11    /auth/otp         200
  10139 172.28.14.11    /transactions   3 429
  12165 172.28.14.11    /login            200
  12166 172.28.14.11    /login            200
  12173 172.28.14.11    /auth/otp         200
  12174 172.28.14.11    /auth/otp         200
  12177 172.28.14.11    /transactions   3 200
  12179 172.28.14.11    /transactions   1 200
  12184 172.28.14.11    /transactions   4 200
  12185 172.28.14.11    /transactions   2 200
  12191 172.28.14.11    /transactions   5 403
  12192 172.28.14.11    /transactions   3 403
  12194 172.28.14.12    /login            200      <- 두 워커 모두 B로 전환
  12195 172.28.14.12    /login            200
  12196 172.28.14.12    /auth/otp         200
  12197 172.28.14.12    /auth/otp         200
  12198 172.28.14.12    /transactions   3 200
  12198 172.28.14.12    /transactions   5 200
  12201 172.28.14.12    /transactions   4 200
  12202 172.28.14.12    /transactions   6 200
  12205 172.28.14.12    /transactions   5 429
  12205 172.28.14.12    /transactions   7 403      <- B도 막힘. w1 모두 막힘, 9985ms 정지
  22232 172.28.14.11    /login            200      <- A로 재개
  22233 172.28.14.11    /login            200
  22235 172.28.14.11    /auth/otp         200
  22236 172.28.14.11    /auth/otp         200
  22239 172.28.14.11    /transactions   5 200
  22240 172.28.14.11    /transactions   7 200
  22132 172.28.14.11    /transactions   6 200      <- VM 시계가 여기서 109ms 물러났다(로그 순서가 맞다)
  22132 172.28.14.11    /transactions   8 200
  22137 172.28.14.11    /transactions   7 429
  25175 172.28.14.11    /login            200
  25179 172.28.14.11    /auth/otp         200
  25184 172.28.14.11    /transactions   7 200
  25189 172.28.14.11    /transactions   8 200
```

첫 번째 "모두 막힘"의 워커 로그와 대상 서버 원문입니다. w2가 A(10초)와 B(10초)를 모두 막고, 가장 빨리 풀리는 A까지
7977ms를 멈춥니다. 대상 서버에는 그동안 요청이 0건이고, A가 풀리는 시각에 A(172.28.14.11)로 재개합니다.

```
{"t":"2026-09-26T18:54:59.659Z","worker":"w2","pid":22300,"event":"origin-result","jobId":"col_55791c502578c0f4189d5673eea749ae","origin":"http://127.0.0.1:3129","outcome":"IP_BLOCKED","ok":0,"failed":1}
{"t":"2026-09-26T18:54:59.659Z","worker":"w2","pid":22300,"event":"origins-exhausted","jobId":"col_55791c502578c0f4189d5673eea749ae","waitMs":7977,"releases":[{"origin":"http://127.0.0.1:3128","blockedUntil":"2026-09-26T18:55:07.636Z"},{"origin":"http://127.0.0.1:3129","blockedUntil":"2026-09-26T18:55:09.659Z"}]}
{"t":"2026-09-26T18:54:59.659Z","worker":"w2","pid":22300,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"IP_BLOCKED","waitMs":7977,"detail":"HTTP 403 + Retry-After, 본문 IP_BLOCKED"}
{"t":"2026-09-26T18:55:07.727Z","worker":"w2","pid":22300,"event":"origin-result","jobId":"col_55791c502578c0f4189d5673eea749ae","origin":"http://127.0.0.1:3128","outcome":"ok","ok":1,"failed":2}
{"t":"2026-09-26T18:55:07.729Z","worker":"w2","pid":22300,"event":"completed","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"rows":137}
```

```
{"time":1790448899774,"reqId":"req-u","req":{"method":"GET","url":"/transactions?account=000-11-222333&page=5","host":"target:8080","remoteAddress":"172.28.14.12","remotePort":54194},"msg":"incoming request"}
{"time":1790448899775,"reqId":"req-u","res":{"statusCode":403},"msg":"request completed"}
{"time":1790448907766,"reqId":"req-v","req":{"method":"POST","url":"/login","host":"target:8080","remoteAddress":"172.28.14.11","remotePort":48950},"msg":"incoming request"}
{"time":1790448907768,"reqId":"req-v","res":{"statusCode":200},"msg":"request completed"}
```

(대상 서버 원문에서 `level`·`pid`·`hostname`·`responseTime`만 뺐습니다.) req-u와 req-v 사이 7992ms, 워커가 건 정지 7977ms와
VM·호스트 시계 차이 안에서 같습니다. 두 번째 "모두 막힘"(w1, `waitMs` 9985)은 req-1n(12205ms, B 403)에서 req-1o(22232ms, A
로그인)까지 10026ms입니다. 두 번 모두 대기가 그 작업이 받은 Retry-After(10초)가 아니라 **가장 빨리 풀리는 출발지의 남은
시간**입니다. 정지는 기존 IP_BLOCKED 경로(`rate-limited` + `COUNT_CYCLE`)로 걸렸습니다. 주기마다 누군가 페이지를 받아 상한에 닿지 않았고,
끝난 뒤 `progress:d3origin2`의 `cycles`는 0입니다(주기마다의 값은 찍지 않았습니다).

프로세스마다 상태를 든 결과도 보입니다. 2080ms에 w2는 w1이 이미 겪은 A의 차단을 몰라 A로 한 번 보내 403을 받은 뒤에야
B로 바꿨습니다. 대상 서버는 차단 중인 출발지의 요청을 M 누적에 더하지 않으므로 차단이 길어지지는 않습니다(`target/switches.ts`
`admit`). 그리고 두 워커는 늘 목록의 첫 출발지부터 쓰므로 같은 출발지의 창을 같이 먹습니다.

## 4. 창이 두 워커의 로그인 비용과 같으면: 모두 막힌 채 진행이 없어 NO_PROGRESS로만 DLQ

3절 전에 N=4, M=2(나머지는 같다)로 먼저 돌렸습니다(큐 `d3origin`). 네 건 모두 16초 만에 failed였습니다.

```
{"id":"col_55791c502578c0f4189d5673eea749ae","state":"failed","attemptsMade":1,"results":40,"ledger":137,"match":false}
{"id":"col_fe99bf7049c4171bb4a0210ea1b2a012","state":"failed","attemptsMade":1,"results":0,"ledger":137,"match":false}
{"id":"col_d92aa799027219910430374909f4c7e8","state":"failed","attemptsMade":1,"results":0,"ledger":133,"match":false}
{"id":"col_a0f4623b3dc526686dda8319afcadfe8","state":"failed","attemptsMade":1,"results":0,"ledger":129,"match":false}
```

```
첫 요청 2026-09-26T18:53:38.550Z
      0 172.28.14.11    /login            200
      2 172.28.14.11    /login            200
     10 172.28.14.11    /auth/otp         200
     12 172.28.14.11    /auth/otp         200
     13 172.28.14.11    /transactions   1 429
     14 172.28.14.11    /transactions   1 403
     19 172.28.14.12    /login            200
     22 172.28.14.12    /auth/otp         200
     45 172.28.14.12    /transactions   1 200
     56 172.28.14.12    /transactions   2 200
     60 172.28.14.12    /transactions   3 429
   2074 172.28.14.11    /login            403
   2082 172.28.14.12    /login            200
   2083 172.28.14.12    /login            200
   2088 172.28.14.12    /auth/otp         200
   2090 172.28.14.12    /auth/otp         200
   2092 172.28.14.12    /transactions   3 403
   2094 172.28.14.12    /transactions   1 403
  10111 172.28.14.11    /login            200
  10112 172.28.14.11    /login            200
  10114 172.28.14.11    /auth/otp         200
  10115 172.28.14.11    /auth/otp         200
  10116 172.28.14.11    /transactions   1 429
  10117 172.28.14.11    /transactions   3 403
  12132 172.28.14.11    /login            403
  12134 172.28.14.12    /login            200
  12140 172.28.14.12    /login            200
  12144 172.28.14.12    /auth/otp         200
  12146 172.28.14.12    /auth/otp         200
  12147 172.28.14.12    /transactions   1 429
  12150 172.28.14.12    /transactions   3 403
  14180 172.28.14.12    /login            403
  14182 172.28.14.11    /login            403
```

```
{"t":"2026-09-26T18:53:50.706Z","worker":"w1","pid":19628,"event":"dead-letter","jobId":"col_fe99bf7049c4171bb4a0210ea1b2a012","attemptsMade":1,"kind":"NO_PROGRESS","detail":"큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 1페이지에서 멈춤). ..."}
{"t":"2026-09-26T18:53:50.706Z","worker":"w2","pid":19629,"event":"dead-letter","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":1,"kind":"NO_PROGRESS","detail":"큐 전체에서 속도 제한·차단 주기 3번 연속 새 페이지 없음(이 작업은 3페이지에서 멈춤). ..."}
{"t":"2026-09-26T18:53:52.714Z","worker":"w1","pid":19628,"event":"dead-letter","jobId":"col_a0f4623b3dc526686dda8319afcadfe8","attemptsMade":1,"kind":"NO_PROGRESS",...}
{"t":"2026-09-26T18:53:52.715Z","worker":"w2","pid":19629,"event":"dead-letter","jobId":"col_d92aa799027219910430374909f4c7e8","attemptsMade":1,"kind":"NO_PROGRESS",...}
```

전환 코드의 결함인지부터 봤습니다.

- 가설 a, 전환이 주기로 세어져 상한을 앞당겼다: 기각. 주기는 `rate-limited` 사건에서만 세고, 전환(`origin-rotated`) 뒤에는
  `rate-limited`가 없습니다. 주기를 센 것은 429 정지와 "모두 막힘" 정지뿐입니다.
- 가설 b, 창(N=4)이 같이 출발한 두 워커의 로그인(2 × 2요청)과 같다: 확정. 0~12ms에 로그인 두 벌이 창을 다 쓰고 두 워커의
  1페이지가 둘 다 거부됩니다. M=2라 그 두 번째 거부에서 바로 출발지가 막힙니다. 풀린 뒤(10111ms, 12134ms)에도 같은 모양입니다.
  `d3-resume.md` 5절(N=2, 워커 하나)과 같은 "창이 로그인 비용 이하"의 경우이고, 출발지가 둘이어도 두 워커가 같은 출발지로
  같이 출발하므로 풀리지 않습니다.
- 가설 c, 프로세스마다 상태라 다른 워커가 막힌 출발지로 또 보낸다: 참이지만(2074ms, 12132ms) 원인은 아닙니다. 요청 하나가
  더 나갈 뿐입니다.

출발지가 모두 막힌 채 진행이 없을 때도 DLQ로는 진행 기반 상한(NO_PROGRESS)으로만 갔습니다. IP_BLOCKED나 TRANSIENT로 간
항목은 없고, 시도 횟수는 전부 0에서 끝났습니다(`attemptsMade` 1은 실패로 옮긴 그 한 번). 3절은 N=8로 올려 이 경우를 피했습니다.

## 5. 출발지별 성공·실패 수, 테스트

출발지를 쓴 수집 한 번마다 워커가 한 줄을 남깁니다. `outcome`은 이번 결과, `ok`·`failed`는 그 워커 프로세스에서 그 출발지의
누적 수입니다. 고르는 데는 쓰지 않습니다.

```
{"t":"2026-09-26T18:55:22.830Z","worker":"w2","pid":22300,"event":"origin-result","jobId":"col_a0f4623b3dc526686dda8319afcadfe8","origin":"http://127.0.0.1:3128","outcome":"ok","ok":3,"failed":4}
```

테스트(`REDIS_URL=redis://127.0.0.1:6379 pnpm test`): 259개 통과(기존 244 + `origins.test.ts` 9 + 워커 6). 워커 테스트는 이
프로세스 안에서 출발지를 가를 수 없어서, 출발지마다 대상 서버 앞에 문을 하나 두고 그 문이 대상 서버와 같은 모양의 403·429를
돌려주게 했습니다. 페이지는 실제 대상 서버가 줍니다.

| 테스트 | 무엇을 보나 |
|---|---|
| IP_BLOCKED면 다른 출발지로 바로 바꿔 다시 로그인하고 받은 페이지부터 이어 받는다 | A 3페이지 403(5초) → B 로그인부터, 3페이지부터. `rate-limited` 0건, 주기 키 없음, 시도 0, 3초 안에 완료, 결과 = 원장 |
| 429에서는 출발지를 바꾸지 않고 지금처럼 큐를 멈춘다 | 요청 전부 A, `rate-limited` RATE_LIMITED 1건, 429 뒤 1초 요청 0건 |
| 막힌 출발지는 Retry-After 동안 다음 작업에서도 빠지고, 풀리면 첫 출발지로 돌아온다 | 로그인 출발지 A(403), B, B, A |
| 모두 막히면 가장 빨리 풀리는 시각까지 큐 전체를 멈추고(주기 1), 풀린 출발지로 이어 간다 | A 1초, B 3초. 정지는 A의 남은 시간(1초 이하, 마지막 차단의 3초가 아님), 그동안 요청 0건, 주기 1, A로 재개 |
| 모두 막힌 채 아무도 나아가지 못하면 DLQ로는 NO_PROGRESS로만 간다 | `origins-exhausted` 3번, 시도 0, DLQ NO_PROGRESS |
| 출발지 풀이 없으면 지금 동작 그대로다 | 수집 함수에 출발지가 오지 않고, `origin-*` 사건 0건, IP_BLOCKED는 Retry-After만큼 정지 |

대조 실행(고치려는 것을 빼고 실패하는지, TROUBLESHOOTING 5번): 전환을 끄면 첫째·셋째·넷째가, 429에도 전환하면 둘째가,
"모두 막힘"의 정지를 가장 빠른 해제 대신 그 작업의 Retry-After로 걸면 넷째가 실패했습니다. 되돌리면 통과합니다.

## 6. final-review 반영 뒤: 차단기 재확인, 큐 정지 중 전환 보류, 모두 막힌 채 시작하지 않기

final-review(수정 전 diff 기준 버그 리뷰)의 판정대로 고쳤습니다. 항목마다 먼저 테스트를 쓰고, 고치기 전 코드에서 그 테스트가
실패하는 것을 본 뒤에 고쳤습니다(새 테스트 8개가 고치기 전 코드에서 8개 모두 실패, 고친 뒤 통과).

| 항목 | 무엇이 틀렸나 | 고친 것 |
|---|---|---|
| #1 | `WORKER_PROXIES` 오류 메시지가 원문(자격증명 포함)을 실었다. 스킴 검사가 자격증명 검사보다 앞이라 `socks5://user:pass@host`가 원문째 로그에 남았다 | 메시지에 몇 번째 항목인지와 이유만 싣는다. 스킴·호스트 조각도 싣지 않는다(`TOKEN:@host`처럼 스킴 자리에 비밀이 오는 값) |
| #2 | `origin-rotated`의 `blockedUntil`이 풀이 든 값이 아니라 이번 Retry-After 기준이었다 | `OriginPool.block`이 실제 해제 시각을 돌려주고 로그는 그 값을 싣는다 |
| #3 | 자격증명 차단기를 처리 시작에서 한 번만 봤다. 전환하면 로그인을 다시 보내므로, 그사이 같은 로그인 ID의 다른 작업이 AUTH_FAILED로 차단기를 걸어도 틀린 비밀번호가 한 번 더 나갔다 | 전환해 다시 수집하기 직전마다 차단기를 본다. 걸려 있으면 로그인하지 않고 차단기 처분(DLQ)으로 간다 |
| #5 | 처리 안의 전환은 BullMQ로 돌아가지 않아, 다른 워커의 429가 건 큐 정지 중에도 새 출발지로 로그인·페이지가 나갔다. 속도 제한을 출발지 전환으로 비켜 가는 셈이다 | 전환 직전에 `queue.getRateLimitTtl(Number.MAX_SAFE_INTEGER)`로 큐 정지가 남았는지 본다. 남았으면 바꾸지 않고(`origin-rotation-held`) 그 남은 시간만큼 큐 정지 경로로 간다 |
| #6 | 모두 막혔다고 아는데도 `pick()`이 아직 막힌 출발지를 돌려줘 확정적인 403을 한 번 더 보냈다(concurrency 2 이상, 다른 워커의 짧은 정지가 앞선 정지를 덮어쓴 경우) | 처리를 시작할 때 풀의 출발지가 모두 막혀 있으면 로그인을 보내지 않고 가장 빠른 해제까지 큐를 멈춘다(`origins-exhausted`) |
| #9 | `WORKER_PROXIES`를 주고 `TARGET_ORIGIN`을 빠뜨리면 기본값 127.0.0.1:8080이 되고, 그것은 프록시 컨테이너 안에서 프록시 자신이라 전부 5xx였다 | 워커를 시작할 때 던진다(`resolveTargetOrigin`) |

`getRateLimitTtl`에 `Number.MAX_SAFE_INTEGER`를 넘기는 이유: `queue.rateLimit`은 limiter 키를 그 값으로 두고(bullmq 6.3.8
`setRateLimit`), 워커 limiter는 같은 키로 평소 꺼낸 작업 수를 셉니다. `getRateLimitTtl` 스크립트는 키 값이 넘긴 값 이상일 때만
남은 시간을 주므로, 이 값으로 물으면 평소 세기(초당 100개 미만)는 0이고 속도 제한 정지만 남은 시간이 나옵니다.

`TARGET_ORIGIN` 없이 띄운 워커:

```sh
$ QUEUE_NAME=d3origin3 WORKER_PROXIES=http://127.0.0.1:3128,http://127.0.0.1:3129 tsx collector/worker/index.ts
  if (proxies.length > 0) throw new RangeError('WORKER_PROXIES를 주면 TARGET_ORIGIN도 줘야 한다(프록시가 보는 대상 서버 주소, compose면 http://target:8080)');
(exit 1)
```

### 6-1. keep-alive (#7): 확정되지 않아 고치지 않았다

리뷰는 ProxyAgent가 기본 keep-alive이고 tinyproxy가 응답마다 클라이언트 연결을 닫으므로 닫힌 소켓을 재사용해 네트워크 오류가
날 수 있다고 봤습니다(#15 측정의 중계가 keep-alive로 502를 낸 선례). 확인한 것:

```sh
$ curl -s -i -x http://127.0.0.1:3128 http://target:8080/health
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
content-length: 11
Date: Sat, 26 Sep 2026 20:06:14 GMT
$ curl -sv -x http://127.0.0.1:3128 http://target:8080/health http://target:8080/health 2>&1 | grep -iE 'connected to|left intact|closing'
* Connected to 127.0.0.1 (127.0.0.1) port 3128
* Connection #0 to host 127.0.0.1 left intact
* Closing connection
* Connected to 127.0.0.1 (127.0.0.1) port 3128
* Connection #1 to host 127.0.0.1 left intact
$ tsx burst.mts 200     # ProxyAgent 하나로 /health와 세션 없는 /transactions를 번갈아 await하며 연속 요청
{"requests":200,"results":{"status:200":100,"status:401":100}}
tinyproxy: client_connects=202 requests=202 upstream=202 closed=202     # curl 2 + burst 200
$ tsx burst.mts 500 (두 번)
{"requests":500,"results":{"status:200":250,"status:401":250}}
{"requests":500,"results":{"status:200":250,"status:401":250}}
```

tinyproxy는 `Connection: close` 헤더 없이 HTTP/1.1로 답하고 응답마다 클라이언트 연결을 닫습니다(연결 수 = 요청 수). 그런데
undici는 다음 요청 전에 닫힌 것을 알아채고 새 연결을 열어, 연속 1200요청에서 네트워크 오류가 0건이었습니다. #15의 502는
그 러너의 앞단 중계가 닫힌 연결을 재사용한 것이고 이 경로에는 그 중계가 없습니다. 확정되지 않아 keep-alive를 끄지 않았습니다.
응답과 닫힘 사이에 다음 요청이 끼어드는 경쟁은 있을 수 있고, 그때는 TRANSIENT로 재시도합니다.

### 6-2. 3절 조건 재실측 (큐 `d3origin3`)

3절과 같은 조건(compose 대상 서버 재시작, 워커 2개, W=2초 N=8 M=2 T=10초, demo01 4건)입니다.

```
elapsed 23s
{"id":"col_55791c502578c0f4189d5673eea749ae","state":"completed","attemptsMade":1,"results":137,"ledger":137,"match":true}
{"id":"col_fe99bf7049c4171bb4a0210ea1b2a012","state":"completed","attemptsMade":1,"results":137,"ledger":137,"match":true}
{"id":"col_d92aa799027219910430374909f4c7e8","state":"completed","attemptsMade":1,"results":133,"ledger":133,"match":true}
{"id":"col_a0f4623b3dc526686dda8319afcadfe8","state":"completed","attemptsMade":1,"results":129,"ledger":129,"match":true}
dead: 0 progress: pages 32 seen 24 cycles 0
```

**4건 모두 완료, 결과 행 수 = 원장, DLQ 0.** 전체 요청(첫 요청 기준 ms, 이번에는 VM 시계가 물러나지 않았습니다):

```
첫 요청 2026-09-26T20:06:56.638Z
      0 172.28.14.11    /login            200
      1 172.28.14.11    /login            200
      8 172.28.14.11    /auth/otp         200
     10 172.28.14.11    /auth/otp         200
     38 172.28.14.11    /transactions   1 200
     38 172.28.14.11    /transactions   1 200
     50 172.28.14.11    /transactions   2 200
     50 172.28.14.11    /transactions   2 200
     55 172.28.14.11    /transactions   3 429
     55 172.28.14.11    /transactions   3 403
     63 172.28.14.12    /login            200
     65 172.28.14.12    /auth/otp         200
     67 172.28.14.12    /transactions   3 200
     71 172.28.14.12    /transactions   4 200
     75 172.28.14.12    /transactions   5 200
     78 172.28.14.12    /transactions   6 200
     81 172.28.14.12    /transactions   7 200
     85 172.28.14.12    /transactions   8 200
   2085 172.28.14.11    /login            403
   2087 172.28.14.12    /login            200
   2094 172.28.14.12    /auth/otp         200
   2095 172.28.14.12    /login            200
   2098 172.28.14.12    /transactions   3 200
   2100 172.28.14.12    /auth/otp         200
   2103 172.28.14.12    /transactions   1 200
   2106 172.28.14.12    /transactions   4 200
   2109 172.28.14.12    /transactions   2 200
   2110 172.28.14.12    /transactions   5 429
   2113 172.28.14.12    /transactions   3 403
  10119 172.28.14.11    /login            200
  10128 172.28.14.11    /auth/otp         200
  10133 172.28.14.11    /transactions   3 200
  10134 172.28.14.11    /login            200
  10139 172.28.14.11    /auth/otp         200
  10141 172.28.14.11    /transactions   4 200
  10143 172.28.14.11    /transactions   5 200
  10148 172.28.14.11    /transactions   5 200
  10149 172.28.14.11    /transactions   6 429
  10153 172.28.14.11    /transactions   6 403
  12165 172.28.14.12    /login            200
  12165 172.28.14.11    /login            403
  12171 172.28.14.12    /auth/otp         200
  12172 172.28.14.12    /login            200
  12174 172.28.14.12    /transactions   6 200
  12176 172.28.14.12    /auth/otp         200
  12179 172.28.14.12    /transactions   6 200
  12182 172.28.14.12    /transactions   7 200
  12186 172.28.14.12    /transactions   7 200
  12187 172.28.14.12    /transactions   8 429
  12192 172.28.14.12    /transactions   8 403
  20178 172.28.14.11    /login            200
  20184 172.28.14.11    /auth/otp         200
  20188 172.28.14.11    /transactions   8 200
  20197 172.28.14.11    /login            200
  20200 172.28.14.11    /auth/otp         200
  20201 172.28.14.11    /transactions   8 200
  20206 172.28.14.11    /login            200
  20208 172.28.14.11    /auth/otp         200
  20209 172.28.14.11    /transactions   1 429
  22231 172.28.14.11    /login            200
  22235 172.28.14.11    /auth/otp         200
  22237 172.28.14.11    /transactions   1 200
  22242 172.28.14.11    /transactions   2 200
  22246 172.28.14.11    /transactions   3 200
  22252 172.28.14.11    /transactions   4 200
  22256 172.28.14.11    /transactions   5 200
  22259 172.28.14.11    /transactions   6 200
  22262 172.28.14.11    /transactions   7 403
  22264 172.28.14.12    /login            200
  22266 172.28.14.12    /auth/otp         200
  22268 172.28.14.12    /transactions   7 200
  22270 172.28.14.12    /transactions   8 200
```

- 전환: 55ms에 172.28.14.11에서 403, 63ms에 172.28.14.12로 로그인부터 다시(w2), 85ms에 그 작업 완료.
- 모두 막힘: 2113ms(B 403) 뒤 10119ms까지 요청 0건, A로 재개. 12192ms(B 403) 뒤 20178ms까지 0건, A로 재개.
- **큐 정지 중 전환 보류(#5, 새 동작)**: 10149ms에 w1이 A에서 429를 받아 큐를 2초 멈추고, 4ms 뒤(10153ms) w2가 A에서 403을 받았습니다.
  고치기 전이라면 w2는 곧바로 B로 로그인했을 자리입니다. 이번에는 바꾸지 않고 남은 정지(1996ms)만큼 멈췄고, 다음 요청은 12165ms입니다.

```
{"t":"2026-09-26T20:07:06.679Z","worker":"w1","pid":16185,"event":"origin-result","jobId":"col_55791c502578c0f4189d5673eea749ae","origin":"http://127.0.0.1:3128","outcome":"RATE_LIMITED","ok":0,"failed":3}
{"t":"2026-09-26T20:07:06.679Z","worker":"w1","pid":16185,"event":"rate-limited","jobId":"col_55791c502578c0f4189d5673eea749ae","attemptsMade":0,"kind":"RATE_LIMITED","waitMs":2000,"detail":"HTTP 429"}
{"t":"2026-09-26T20:07:06.683Z","worker":"w2","pid":16184,"event":"origin-result","jobId":"col_d92aa799027219910430374909f4c7e8","origin":"http://127.0.0.1:3128","outcome":"IP_BLOCKED","ok":0,"failed":2}
{"t":"2026-09-26T20:07:06.684Z","worker":"w2","pid":16184,"event":"origin-rotation-held","jobId":"col_d92aa799027219910430374909f4c7e8","from":"http://127.0.0.1:3128","to":"http://127.0.0.1:3129","waitMs":1996}
{"t":"2026-09-26T20:07:06.684Z","worker":"w2","pid":16184,"event":"rate-limited","jobId":"col_d92aa799027219910430374909f4c7e8","attemptsMade":0,"kind":"IP_BLOCKED","waitMs":1996,"detail":"HTTP 403 + Retry-After, 본문 IP_BLOCKED"}
```

대상 서버 원문(`level`·`pid`·`hostname`·`responseTime` 뺌)도 같습니다. 403(req-14) 뒤 2011ms 동안 요청이 없고, 다음은 B의 로그인입니다.

```
{"time": 1790453226787, "reqId": "req-13", "req": {"method": "GET", "url": "/transactions?account=000-11-222333&page=6", "host": "target:8080", "remoteAddress": "172.28.14.11", "remotePort": 39218}, "msg": "incoming request"}
{"time": 1790453226787, "reqId": "req-13", "res": {"statusCode": 429}, "msg": "request completed"}
{"time": 1790453226791, "reqId": "req-14", "req": {"method": "GET", "url": "/transactions?account=000-11-222333&page=6", "host": "target:8080", "remoteAddress": "172.28.14.11", "remotePort": 39230}, "msg": "incoming request"}
{"time": 1790453226791, "reqId": "req-14", "res": {"statusCode": 403}, "msg": "request completed"}
{"time": 1790453228802, "reqId": "req-15", "req": {"method": "POST", "url": "/login", "host": "target:8080", "remoteAddress": "172.28.14.12", "remotePort": 55844}, "msg": "incoming request"}
{"time": 1790453228803, "reqId": "req-15", "res": {"statusCode": 200}, "msg": "request completed"}
```

이번 실행에서는 "처리를 시작할 때 모두 막혀 있음"(#6)과 "전환 직전 차단기"(#3)가 일어나지 않았습니다(concurrency 1, 자격증명
정상). 두 경로는 워커 테스트만 봅니다.

## 안 한 것

- 워커끼리 차단 상태를 나누지 않았습니다(Redis 공유 없음). 3절 2080ms처럼 워커마다 한 번씩 막힌 출발지로 보냅니다.
  나누려면 해제 시각을 큐 단위 키에 두고 고를 때 읽으면 되지만, 고르는 자리마다 Redis 왕복이 하나 늘어서 이번에는 두지 않았습니다.
- 두 워커가 같은 첫 출발지로 같이 출발해 창을 나눠 먹는 모양(4절)은 그대로입니다. 워커마다 다른 출발지부터 쓰게 하면 풀릴 수
  있지만, 그것은 속도 제한을 출발지 수만큼 늘려 받는 것이라 이슈 범위(429에서 바꾸지 않는다)와 같은 이유로 하지 않았습니다.
- 프록시 컨테이너가 죽은 경우(연결 거부)는 TRANSIENT로 분류되어 지금처럼 재시도합니다. 출발지를 바꾸지 않습니다. 실측하지 않았습니다.
- 대상 서버 이미지(`target/Dockerfile`)는 로컬 compose에서만 빌드했습니다. CI에 이미지 빌드를 넣지 않았습니다.
- **전환 상한과 목록 순서 때문에 생기는 거짓 "모두 막힘"(final-review #4, 한계로 둠).** 한 처리의 전환은 출발지 수 - 1번까지이고
  다음 출발지는 목록 순서로 고릅니다. 출발지 2개에서 A가 짧게 막혀 B로 바꾼 뒤, B의 로그인 도중 A가 풀렸는데 B도 403이면 A가
  비었는데도 "모두 막힘"으로 가서 1ms 정지하고 무진행 주기 하나를 셉니다. 출발지 3개면 풀린 A를 다시 골라 C를 써 보지 못한 채
  상한에 닿습니다. 영향은 1ms 정지와 무진행 1주기입니다. 고치려면 전환 예산 규칙(써 본 출발지 집합, 풀린 출발지의 재사용)을 다시
  짜야 해서 이번에는 두었습니다. 확정 방법: B의 수집 안에서 A의 해제 시각을 넘기는 가짜 시계 테스트로 `origins-exhausted`에
  풀린 출발지가 있고 `waitMs` 1, 출발지 3개에서 C가 수집에 오지 않는 것을 봅니다.
- final-review #8(Retry-After 0이면 같은 출발지로 A에서 A로 전환)은 기각했습니다. 대상 서버는 Retry-After를 최소 1초로 줍니다(`target/switches.ts` `secondsUntil`).

## 부록: 스크립트

리포 밖 작업 디렉터리에 두고 `node_modules`를 리포의 것으로 링크해 `tsx`로 돌렸습니다. 아래 `<리포>`는 리포 루트의 절대 경로입니다.

### enqueue.mts

```ts
// 사용: tsx enqueue.mts <큐> <loginId> <accountNo> <from> <to> [<from> <to> ...]
import { Queue } from 'bullmq';
import { COLLECT_JOB, COLLECT_JOB_OPTIONS, createRedis, jobIdOf } from '<리포>/collector/queue.ts';
const [name, loginId, accountNo, ...periods] = process.argv.slice(2) as string[];
const redis = createRedis('producer');
const queue = new Queue(name!, { connection: redis });
for (let i = 0; i < periods.length; i += 2) {
  const from = `${periods[i]} 00:00:00`, to = `${periods[i + 1]} 23:59:59`;
  const jobId = jobIdOf(loginId!, accountNo!, from, to);
  await queue.add(COLLECT_JOB, { loginId, accountNo, from, to }, { ...COLLECT_JOB_OPTIONS, jobId });
  console.log(jobId);
}
await queue.close(); await redis.quit();
```

### status.mts

```ts
// 사용: tsx status.mts <큐> <jobId...>  상태, 결과 행 수(HLEN), 원장 기대 행 수
import { Queue } from 'bullmq';
import { createRedis, resultsKey } from '<리포>/collector/queue.ts';
import { buildLedger } from '<리포>/target/transactions.ts';
const [name, ...ids] = process.argv.slice(2) as string[];
const COUNT: Record<string, number> = { '000-11-222333': 137, '000-44-555666': 12 };
const redis = createRedis('producer');
const queue = new Queue(name!, { connection: redis });
for (const id of ids) {
  const job = await queue.getJob(id);
  const state = await queue.getJobState(id);
  const d = job!.data;
  const expected = buildLedger(d.accountNo, COUNT[d.accountNo]!).filter((r) => r.at >= d.from && r.at <= d.to).length;
  const have = await redis.hlen(resultsKey(name!, id));
  console.log(JSON.stringify({ id, state, attemptsMade: job!.attemptsMade, results: have, ledger: expected, match: have === expected }));
}
await queue.close(); await redis.quit();
```

### trace.py

```python
# 사용: python3 trace.py <대상 서버 로그> [시작 줄]  첫 요청 기준 ms, 출발지, 경로, 페이지, 상태 (관리 API·health 제외)
import json, re, sys
from datetime import datetime, timezone
lines = open(sys.argv[1]).read().splitlines()[int(sys.argv[2]) if len(sys.argv) > 2 else 0:]
req = {}; rows = []
for l in lines:
    try: o = json.loads(l)
    except Exception: continue
    if 'req' in o and o.get('msg') == 'incoming request': req[o['reqId']] = o
    elif 'res' in o and o['reqId'] in req:
        q = req.pop(o['reqId'])['req']; url = q['url']; path = url.split('?')[0]
        if path.startswith('/admin') or path == '/health': continue
        m = re.search(r'[?&]page=(\d+)', url)
        rows.append((o['time'], q.get('remoteAddress'), path, m.group(1) if m else '', o['res']['statusCode']))
if rows:
    t0 = rows[0][0]
    print(f"첫 요청 {datetime.fromtimestamp(t0/1000, timezone.utc).replace(tzinfo=None).isoformat(timespec='milliseconds')}Z")
    for t, a, p, pg, s in rows: print(f"{t-t0:7d} {a:<15} {p:<14} {pg:>2} {s}")
```

(시각은 응답 줄의 `time`입니다. 3절처럼 VM 시계가 물러나면 로그 순서와 시각이 어긋납니다.)

### h2.mts

```ts
// H2: 출발지마다 ProxyAgent를 하나씩 두고 바꿔 끼우면 전환 직후 요청이 새 출발지로 나가는가.
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createUndiciTransport } from '<리포>/collector/client/transport.ts';
const target = 'http://target:8080';
const a = new ProxyAgent('http://127.0.0.1:3128');
const b = new ProxyAgent('http://127.0.0.1:3129');
const send = async (label: string, t: ReturnType<typeof createUndiciTransport>) => {
  const res = await t({ method: 'GET', path: `/health?h2=${label}` });
  console.log(label, 'status' in res ? res.status : JSON.stringify(res));
};
const ta = createUndiciTransport({ origin: target, dispatcher: a });
const tb = createUndiciTransport({ origin: target, dispatcher: b });
for (const l of ['a1', 'a2', 'a3']) await send(l, ta);
for (const l of ['b1', 'b2', 'b3']) await send(l, tb);
await send('a4', ta);
const tg = createUndiciTransport({ origin: target });
const before = getGlobalDispatcher();
setGlobalDispatcher(a); await send('g-a', tg);
setGlobalDispatcher(b); await send('g-b', tg);
await send('a5-while-global-b', ta);
setGlobalDispatcher(before);
await Promise.all([a.close(), b.close()]);
```

### h3.mts

```ts
// H3: A로 로그인한 세션 쿠키를 B로 보내면 대상 서버가 받는가.
import { ProxyAgent } from 'undici';
import { systemClock } from '<리포>/collector/client/clock.ts';
import { lookupCredentials } from '<리포>/collector/client/credentials.ts';
import { CollectorSession } from '<리포>/collector/client/session.ts';
import { createUndiciTransport } from '<리포>/collector/client/transport.ts';
import type { Transport } from '<리포>/collector/client/transport.ts';
const a = new ProxyAgent('http://127.0.0.1:3128'), b = new ProxyAgent('http://127.0.0.1:3129');
const ta = createUndiciTransport({ origin: 'http://target:8080', dispatcher: a });
const tb = createUndiciTransport({ origin: 'http://target:8080', dispatcher: b });
let via: Transport = ta;
const session = new CollectorSession({ transport: (req) => via(req), clock: systemClock, credentials: lookupCredentials('demo02')! });
console.log('login via A:', (await session.login()) ?? 'ok');
via = tb;
const page = await session.fetchPage('000-44-555666', 1);
console.log('page 1 via B:', page.ok ? `ok ${page.page.rows.length} rows` : page.kind, 'stats', JSON.stringify(session.stats));
await Promise.all([a.close(), b.close()]);
```

### burst.mts

```ts
// #7: ProxyAgent 하나로 연속 요청을 N번 보내 네트워크 오류가 나는지 본다.
import { ProxyAgent } from 'undici';
import { createUndiciTransport } from '<리포>/collector/client/transport.ts';
const n = Number(process.argv[2] ?? 60);
const agent = new ProxyAgent('http://127.0.0.1:3128');
const t = createUndiciTransport({ origin: 'http://target:8080', dispatcher: agent });
const out: Record<string, number> = {};
for (let i = 0; i < n; i++) {
  const path = i % 2 === 0 ? '/health' : '/transactions?account=000-44-555666&page=1';
  const res = await t({ method: 'GET', path });
  const key = 'network' in res ? `network:${res.network.code ?? res.network.name}` : `status:${res.status}`;
  out[key] = (out[key] ?? 0) + 1;
}
console.log(JSON.stringify({ requests: n, results: out }));
await agent.close();
```
