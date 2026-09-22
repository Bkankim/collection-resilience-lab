# D2 증거: BullMQ 스파이크(속도 제한·지연·복구 불가 오류)

이슈 #13 코멘트의 "먼저 할 것". 워커 설계의 `CONSUMES_ATTEMPT`(속도 제한·출발지 차단·세션
만료는 시도 횟수를 깎지 않는다)가 BullMQ 동작에 기대고 있는데, PLAN.md 기술 선택표의 그 줄에
리포 안 검증이 없었다. 실제 Redis에 물어서 확인한다.

> **PLAN.md 기술 선택표와 다른 점 (PLAN.md는 고치지 않았다. 판단은 검수자에게 넘긴다)**
>
> PLAN.md: "`worker.rateLimit()`이 '큐 전체를 멈춘다'는 대응과 그대로 맞고, 이때 작업의 시도 횟수를 깎지 않는다."
>
> - **시도 횟수를 깎지 않는다: 맞다.** 속도 제한 5번 뒤 성공한 작업이 `attempts: 3`에서 완료됐다(1번).
> - **큐 전체를 멈춘다: Worker 옵션에 `limiter`가 있을 때만 맞다.** `limiter`가 없으면 `rateLimit()`을
>   부른 워커 하나만 쉬고, 같은 큐의 다른 워커는 제한 창 안에서 바로 작업을 꺼낸다(2·3번, `q23-nolimiter-w2`).
> - **`worker.rateLimit()`은 6.3.8 타입 정의에서 deprecated다**("Use queue.rateLimit method instead").
>   `queue.rateLimit()`도 같은 결과를 냈다(1번 `q1-queue-limiter`).
> - **함정: `maxStartedAttempts`를 켜면 속도 제한도 센다.** 속도 제한으로 되돌아갈 때마다
>   `attemptsStarted`가 오르고, 상한 3에서 작업이 "job started more than allowable limit"로 실패했다
>   (1번 `q1-worker-limiter-maxStarted3`). #13에서 이 옵션을 켜면 CONSUMES_ATTEMPT 설계가 깨진다.

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-23 |
| Node | v26.4.0 |
| bullmq / ioredis | 6.3.8 / 5.11.1 |
| Redis | `docker compose` redis:7-alpine (redis-cli 7.4.11), `redis://127.0.0.1:6379` |
| 스크립트 | `scripts/spike/bullmq-rate-limit.ts` (리포에 있음, `pnpm typecheck` 대상) |

큐 이름은 `spike-<실행 ID>-<실험>`이라 다른 큐와 섞이지 않는다. 끝나면 워커를 닫고 큐를
obliterate한다. 같은 스크립트를 두 번 돌려 같은 결론을 얻었고, 아래는 두 번째 실행 전문이다.
시각 `t`는 실험 시작부터의 밀리초다.

```sh
$ pnpm typecheck
$ tsc --noEmit
$ pnpm -s tsx scripts/spike/bullmq-rate-limit.ts
```

```
{"bullmq":"6.3.8","redis":"redis://127.0.0.1:6379","runId":"mud7t6oa"}
{"exp":"q1-worker-limiter","t":13,"call":1,"attemptsMade":0,"attemptsStarted":1}
{"exp":"q1-worker-limiter","t":218,"call":2,"attemptsMade":0,"attemptsStarted":2}
{"exp":"q1-worker-limiter","t":423,"call":3,"attemptsMade":0,"attemptsStarted":3}
{"exp":"q1-worker-limiter","t":627,"call":4,"attemptsMade":0,"attemptsStarted":4}
{"exp":"q1-worker-limiter","t":830,"call":5,"attemptsMade":0,"attemptsStarted":5}
{"exp":"q1-worker-limiter","t":1035,"call":6,"attemptsMade":0,"attemptsStarted":6}
{"exp":"q1-worker-limiter","calls":6,"elapsedMs":1042,"final":"completed","attemptsMade":1,"attemptsStarted":6,"failedReason":null}
{"exp":"q1-queue-limiter","t":11,"call":1,"attemptsMade":0,"attemptsStarted":1}
{"exp":"q1-queue-limiter","t":214,"call":2,"attemptsMade":0,"attemptsStarted":2}
{"exp":"q1-queue-limiter","t":420,"call":3,"attemptsMade":0,"attemptsStarted":3}
{"exp":"q1-queue-limiter","t":625,"call":4,"attemptsMade":0,"attemptsStarted":4}
{"exp":"q1-queue-limiter","t":830,"call":5,"attemptsMade":0,"attemptsStarted":5}
{"exp":"q1-queue-limiter","t":1034,"call":6,"attemptsMade":0,"attemptsStarted":6}
{"exp":"q1-queue-limiter","calls":6,"elapsedMs":1050,"final":"completed","attemptsMade":1,"attemptsStarted":6,"failedReason":null}
{"exp":"q1-worker-nolimiter","t":11,"call":1,"attemptsMade":0,"attemptsStarted":1}
{"exp":"q1-worker-nolimiter","t":216,"call":2,"attemptsMade":0,"attemptsStarted":2}
{"exp":"q1-worker-nolimiter","t":419,"call":3,"attemptsMade":0,"attemptsStarted":3}
{"exp":"q1-worker-nolimiter","t":624,"call":4,"attemptsMade":0,"attemptsStarted":4}
{"exp":"q1-worker-nolimiter","t":829,"call":5,"attemptsMade":0,"attemptsStarted":5}
{"exp":"q1-worker-nolimiter","t":1033,"call":6,"attemptsMade":0,"attemptsStarted":6}
{"exp":"q1-worker-nolimiter","calls":6,"elapsedMs":1058,"final":"completed","attemptsMade":1,"attemptsStarted":6,"failedReason":null}
{"exp":"q1-worker-limiter-maxStarted3","t":12,"call":1,"attemptsMade":0,"attemptsStarted":1}
{"exp":"q1-worker-limiter-maxStarted3","t":215,"call":2,"attemptsMade":0,"attemptsStarted":2}
{"exp":"q1-worker-limiter-maxStarted3","t":420,"call":3,"attemptsMade":0,"attemptsStarted":3}
{"exp":"q1-worker-limiter-maxStarted3","calls":3,"elapsedMs":651,"final":"failed","attemptsMade":1,"attemptsStarted":4,"failedReason":"job started more than allowable limit"}
{"exp":"q23-limiter-w1","t":18,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-limiter-w1","t":1023,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-limiter-w1","t":1024,"worker":"w1","job":"b","attemptsMade":0}
{"exp":"q23-limiter-w1","t":1025,"worker":"w1","job":"c","attemptsMade":0}
{"exp":"q23-limiter-w1","t":1025,"worker":"w1","job":"d","attemptsMade":0}
{"exp":"q23-limiter-w1","limitedAt":18,"processedOnRel":{"a":1022,"b":1023,"c":1024,"d":1025},"attemptsMade":{"a":1,"b":1,"c":1,"d":1}}
{"exp":"q23-nolimiter-w1","t":9,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-nolimiter-w1","t":1011,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-nolimiter-w1","t":1014,"worker":"w1","job":"b","attemptsMade":0}
{"exp":"q23-nolimiter-w1","t":1016,"worker":"w1","job":"c","attemptsMade":0}
{"exp":"q23-nolimiter-w1","t":1017,"worker":"w1","job":"d","attemptsMade":0}
{"exp":"q23-nolimiter-w1","limitedAt":9,"processedOnRel":{"a":1010,"b":1011,"c":1014,"d":1016},"attemptsMade":{"a":1,"b":1,"c":1,"d":1}}
{"exp":"q23-limiter-w2","t":18,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-limiter-w2","t":19,"worker":"w2","job":"b","attemptsMade":0}
{"exp":"q23-limiter-w2","t":1023,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-limiter-w2","t":1024,"worker":"w2","job":"c","attemptsMade":0}
{"exp":"q23-limiter-w2","t":1026,"worker":"w2","job":"d","attemptsMade":0}
{"exp":"q23-limiter-w2","limitedAt":18,"processedOnRel":{"a":1021,"b":17,"c":1021,"d":1024},"attemptsMade":{"a":1,"b":1,"c":1,"d":1}}
{"exp":"q23-nolimiter-w2","t":15,"worker":"w1","job":"a","attemptsMade":0}
{"exp":"q23-nolimiter-w2","t":15,"worker":"w2","job":"b","attemptsMade":0}
{"exp":"q23-nolimiter-w2","t":17,"worker":"w2","job":"c","attemptsMade":0}
{"exp":"q23-nolimiter-w2","t":18,"worker":"w2","job":"a","attemptsMade":0}
{"exp":"q23-nolimiter-w2","t":19,"worker":"w2","job":"d","attemptsMade":0}
{"exp":"q23-nolimiter-w2","limitedAt":15,"processedOnRel":{"a":17,"b":14,"c":15,"d":18},"attemptsMade":{"a":1,"b":1,"c":1,"d":1}}
{"exp":"q4-delayed","t":8,"call":1,"attemptsMade":0,"attemptsStarted":1}
{"exp":"q4-delayed","t":215,"call":2,"attemptsMade":0,"attemptsStarted":2}
{"exp":"q4-delayed","t":423,"call":3,"attemptsMade":0,"attemptsStarted":3}
{"exp":"q4-delayed","t":631,"call":4,"attemptsMade":0,"attemptsStarted":4}
{"exp":"q4-delayed","calls":4,"elapsedMs":653,"final":"completed","attemptsMade":1,"attemptsStarted":4,"failedReason":null}
{"exp":"q5-unrecoverable","t":13,"call":1,"attemptsMade":0}
{"exp":"q5-unrecoverable","calls":1,"elapsedMs":35,"final":"failed","attemptsMade":1,"attemptsStarted":1,"failedReason":"AUTH_FAILED: HTTP 401 + X-Auth-Failed"}
{"exp":"q5-plain","t":14,"call":1,"attemptsMade":0}
{"exp":"q5-plain","t":82,"call":2,"attemptsMade":1}
{"exp":"q5-plain","t":153,"call":3,"attemptsMade":2}
{"exp":"q5-plain","calls":3,"elapsedMs":175,"final":"failed","attemptsMade":3,"attemptsStarted":3,"failedReason":"AUTH_FAILED: HTTP 401 + X-Auth-Failed"}
{"cleanup":"done","leftoverKeys":{"bull:spike-mud7t6oa-q23-nolimiter-w2:limiter":55,"bull:spike-mud7t6oa-q23-limiter-w2:limiter":10}}
```

```sh
$ sleep 2; docker compose exec -T redis redis-cli --scan --pattern 'bull:spike-*' | wc -l
       0
```

## 질문별 결론

### 1. `rateLimit` + `RateLimitError` 뒤 `attemptsMade`가 오르지 않는가? **예**

6.3.8에서 이름과 시그니처는 그대로다. `Worker.RateLimitError()`(정적 메서드), `worker.rateLimit(ms)`(deprecated),
`queue.rateLimit(ms)`. 프로세서가 5번 연속 제한을 걸고 6번째에 성공하게 했다(`attempts: 3`보다 많이).

- `q1-worker-limiter`, `q1-queue-limiter`, `q1-worker-nolimiter` 모두 호출 1~6의 `attemptsMade`가 0이고,
  최종 `completed`, `attemptsMade` 1(성공 한 번), `attemptsStarted` 6이다. 제한 5번이 실패로 가지 않았다.
- 호출 사이 간격이 약 200ms로 `rateLimit(200)`과 맞는다.
- 오르는 것은 `attemptsStarted`다. `maxStartedAttempts: 3`을 켜면(`q1-worker-limiter-maxStarted3`) 세 번째
  제한 뒤 네 번째로 꺼낼 때 `failed`, `"job started more than allowable limit"`가 됐다. 기본값은 undefined다.

### 2. Worker 옵션에 `limiter`가 없으면 `rateLimit()`이 동작하지 않는가? **절반만 예**

`a`가 `rateLimit(1000)`을 걸고, 같은 큐의 `b`·`c`·`d`가 그 1초 안에 꺼내지는지 봤다.

- 워커 1개(`q23-limiter-w1`, `q23-nolimiter-w1`): `limiter`가 있든 없든 `b`·`c`·`d`는 약 1초 뒤(1014~1025ms)에
  꺼내졌다. **부른 워커 자신은 쉰다.**
- 워커 2개, `limiter` 없음(`q23-nolimiter-w2`): w1이 15ms에 제한을 걸었는데 w2가 17~19ms에 `c`·`a`·`d`를
  꺼냈다. **다른 워커는 멈추지 않는다.**
- 원인(bullmq 6.3.8 소스): `rateLimit()`은 제한 키를 Redis에 `PX`로 세팅한다. 작업을 꺼내는 스크립트
  (`moveToActive-11.lua` → `getRateLimitTTL`)는 `limiter.max`가 있을 때만 그 키를 본다. 부른 워커는
  `RateLimitError`를 받은 자리(`worker.js` `handleFailed`)에서 키의 남은 수명을 읽어 자기만 쉰다.

따라서 "큐 전체를 멈춘다"가 필요하면 `limiter`는 필수다.

### 3. `rateLimit`이 같은 큐의 다른 Worker 인스턴스까지 멈추는가? **예(`limiter`가 있을 때)**

`q23-limiter-w2`: w1이 18ms에 `a`로 제한을 걸었다. w2는 19ms에 `b`를 꺼냈다(`b`의 `processedOn` 17ms, 제한
직전에 이미 꺼낸 작업이다). 그 뒤 w1·w2 누구도 1초 동안 작업을 꺼내지 않았고, 1023~1026ms에 `a`·`c`·`d`가
나뉘어 꺼내졌다. 두 워커는 연결과 인스턴스가 다르다.

### 4. `moveToDelayed(ts, token)` + `DelayedError`가 `attemptsMade`를 올리지 않는가? **예**

`q4-delayed`: 3번 지연(각 200ms) 뒤 성공. 호출 1~4의 `attemptsMade`가 0이고 최종 `completed`,
`attemptsMade` 1, `attemptsStarted` 4다. 속도 제한처럼 `attemptsStarted`는 오른다. 1번의
`maxStartedAttempts` 함정이 여기에도 해당한다(출발지 전환 #14 대비).

### 5. `UnrecoverableError`는 attempts가 남아도 즉시 failed인가? **예**, `failedReason`은 메시지 그대로

- `q5-unrecoverable`(`attempts: 3`): 호출 1번, 최종 `failed`, `attemptsMade` 1,
  `failedReason` `"AUTH_FAILED: HTTP 401 + X-Auth-Failed"`. 오류 이름이 앞에 붙지 않고 메시지 그대로다.
  #12의 `formatFailedReason`/`parseFailedReason`(`KIND: detail`) 형식이 그대로 읽힌다.
- 대조군 `q5-plain`(보통 `Error`): 호출 3번(`attemptsMade` 0→1→2) 뒤 `failed`, `attemptsMade` 3.

## 기타

- 정리: 스크립트 종료 직후 `limiter` 키 2개가 남았다(`leftoverKeys`, 남은 수명 10ms·55ms). obliterate가
  지우지 않는 제한 키이고, `PX`로 곧 만료된다. 2초 뒤 `bull:spike-*`는 0개였다.
- `q23-limiter-w1`과 `q23-nolimiter-w1`의 `processedOnRel`에서 `a`가 1000ms대(1010·1022)인 것은 제한 뒤 다시 꺼낸
  시각이 남은 것이다. 처음 꺼낸 시각은 로그 줄의 `t`(9·18ms)다.
