# D2 증거: 응답 분류기 실측 기록

`collector/client/classify.test.ts`와 `parse.test.ts`가 같은 판정을 CI에서 검증합니다.
이 파일은 **실제 포트를 연 대상 서버에서 curl로 받은 바이트**를 파일로 저장하고,
그 바이트를 그대로 `classify()`에 넣은 기록입니다. 테스트는 대상 서버 렌더러로
바이트를 만들지만 소켓·Fastify 직렬화·curl을 거치지 않으므로, 그 경계를 여기서 봅니다.

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-23 |
| Node | v26.4.0 |
| 서버 | `PORT=8081 pnpm tsx target/server.ts &` (새로 띄운 프로세스에 한 번에 채취, 끝나고 종료) |
| 계정 | `demo01` / `demo-pass-01` (리포에 공개된 실험용 고정 계정) |
| 출발지 | 전부 `127.0.0.1` |

속도 제한·차단 절은 D1과 같이 **스위치 3개와 임계값 5개를 전부 명시**해 조건을
세웠습니다. 적용된 조건은 서버 응답 그대로 아래에 적었습니다.

---

## 1. 채취

```sh
B=http://localhost:8081; C=cap; J='content-type: application/json'
cap(){ name=$1; shift; curl -s -D $C/$name.h -o $C/$name.b "$@"; printf '%-22s %s\n' $name "$(head -1 $C/$name.h | tr -d '\r')"; }
curl -s -X POST $B/admin/reset -H "$J" -d '{}'
cap 01-login-fail -X POST $B/login -H "$J" -d '{"id":"demo01","password":"wrong"}'
cap 02-no-session $B/transactions
cap 03-login-ok -c $C/jar -X POST $B/login -H "$J" -d '{"id":"demo01","password":"demo-pass-01"}'
cap 04-otp-required -b $C/jar $B/transactions
cap 05-otp-rejected -b $C/jar -X POST $B/auth/otp -H "$J" -d '{"token":"000000"}'
cap 06-otp-ok -b $C/jar -c $C/jar -X POST $B/auth/otp -H "$J" -d "{\"token\":\"$TOTP\"}"   # TOTP는 otplib generateSync로 생성
cap 07-page1 -b $C/jar "$B/transactions?page=1"
cap 08-page7 -b $C/jar "$B/transactions?page=7"
cap 09-page8-empty -b $C/jar "$B/transactions?page=8"
cap 10-bad-page -b $C/jar "$B/transactions?page=0"
curl -s -X POST $B/admin/switches -H "$J" -d '<스위치 3개·임계값 5개 전부 명시>'
{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":2,"blockAfter":2,"blockDurationSec":30,"sessionTtlSec":60}}
cap 11-rl-pass1 ...; cap 12-rl-pass2 ...; cap 13-rate-limited ...; cap 14-ip-blocked ...   # 같은 출발지로 연속 4회
curl -s -X POST $B/admin/switches -H "$J" -d '<스위치 3개·임계값 5개 전부 명시>'
{"switches":{"rateLimit":false,"ipBlock":false,"sessionExpiry":true},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":1}}
sleep 2
cap 15-session-expired -b $C/jar "$B/transactions?page=1"
kill <서버 pid>   # 이후 lsof -i :8081 -> 비어 있음
```

```
01-login-fail          HTTP/1.1 401 Unauthorized
02-no-session          HTTP/1.1 401 Unauthorized
03-login-ok            HTTP/1.1 200 OK
04-otp-required        HTTP/1.1 403 Forbidden
05-otp-rejected        HTTP/1.1 403 Forbidden
06-otp-ok              HTTP/1.1 200 OK
07-page1               HTTP/1.1 200 OK
08-page7               HTTP/1.1 200 OK
09-page8-empty         HTTP/1.1 200 OK
10-bad-page            HTTP/1.1 400 Bad Request
11-rl-pass1            HTTP/1.1 200 OK
12-rl-pass2            HTTP/1.1 200 OK
13-rate-limited        HTTP/1.1 429 Too Many Requests
14-ip-blocked          HTTP/1.1 403 Forbidden
15-session-expired     HTTP/1.1 401 Unauthorized
```

### 판정에 쓰이는 헤더와 본문 (채취 파일 그대로)

```
== 01-login-fail
HTTP/1.1 401 Unauthorized
x-auth-failed: 1
{"error":"BAD_CREDENTIALS"}
== 02-no-session
HTTP/1.1 401 Unauthorized
{"error":"NO_SESSION"}
== 04-otp-required
HTTP/1.1 403 Forbidden
{"error":"OTP_REQUIRED"}
== 05-otp-rejected
HTTP/1.1 403 Forbidden
{"error":"OTP_REJECTED"}
== 09-page8-empty                                      (iconv -f EUC-KR -t UTF-8)
HTTP/1.1 200 OK
content-type: text/html; charset=euc-kr
  <p id="summary" data-account="000-11-222333" data-total="137" data-page="8" data-page-size="20" data-total-pages="7">
    <tbody>
    </tbody>
== 10-bad-page
HTTP/1.1 400 Bad Request
{"error":"BAD_PAGE"}
== 13-rate-limited
HTTP/1.1 429 Too Many Requests
retry-after: 10
{"error":"RATE_LIMITED","origin":"127.0.0.1","retryAfterSec":10}
== 14-ip-blocked
HTTP/1.1 403 Forbidden
retry-after: 30
{"error":"IP_BLOCKED","origin":"127.0.0.1","retryAfterSec":30}
== 15-session-expired
HTTP/1.1 401 Unauthorized
x-session-expired: 1
{"error":"SESSION_EXPIRED"}

$ wc -c 07-page1.b; xxd 07-page1.b | grep -m1 c6e4      # 한글이 EUC-KR 2바이트 (c6e4 c0cc c1f6 = 페이지)
    5423 07-page1.b
00000110: 3120 2f20 3720 c6e4 c0cc c1f6 0a20 203c  1 / 7 .......  <
```

## 2. 저장한 바이트를 classify()에 넣기

헤더 파일을 소문자 키 레코드로 읽고(undici와 같은 모양), 본문 파일을 `Buffer`로
그대로 넣습니다. 네트워크 오류 두 건은 흉내가 아니라 실제 소켓으로 만듭니다.
서버를 내린 뒤의 8081(ECONNREFUSED)과, 연결은 받고 응답하지 않는 서버에
`AbortSignal.timeout(300)`을 건 요청(TimeoutError)입니다.

```sh
$ pnpm -s tsx classify-captured.mts cap
```

스크립트는 리포 밖(작업용 임시 디렉터리)에 두고 리포 루트에서 실행했습니다. 확장자가
`.ts`이면 `package.json`의 `"type": "module"` 범위 밖이라 tsx가 CJS로 변환하고 최상위
`await`에서 `Top-level await is currently not supported with the "cjs" output format`으로
멈춥니다. `.mts`로 두면 됩니다.

```
01-login-fail         AUTH_FAILED  "HTTP 401 + X-Auth-Failed, 본문 BAD_CREDENTIALS"
02-no-session         SESSION_EXPIRED  "HTTP 401, 본문 NO_SESSION (세션 없음)"
03-login-ok           PARSE_FAILED  "charset이 EUC-KR이 아니다: utf-8"  raw=status 200, body 14B
04-otp-required       UNKNOWN  "Retry-After 없는 403, 본문 OTP_REQUIRED"  raw=status 403, body 24B
05-otp-rejected       TRANSIENT  "HTTP 403, 본문 OTP_REJECTED (2차 인증 코드 거부)"
06-otp-ok             PARSE_FAILED  "charset이 EUC-KR이 아니다: utf-8"  raw=status 200, body 16B
07-page1              ok page=1/7 total=137 rows=20  첫 행 seq=1 2026-01-02 00:26:48 ATM출금 출금=196000 입금=0 잔액=3054000
08-page7              ok page=7/7 total=137 rows=17  첫 행 seq=121 2026-02-01 01:04:01 환급 출금=0 입금=1261000 잔액=14498000
09-page8-empty        ok page=8/7 total=137 rows=0
10-bad-page           UNKNOWN  "처리 규칙이 없는 상태 코드 400, 본문 BAD_PAGE"  raw=status 400, body 20B
11-rl-pass1           ok page=1/7 total=137 rows=20  첫 행 seq=1 2026-01-02 00:26:48 ATM출금 출금=196000 입금=0 잔액=3054000
12-rl-pass2           ok page=2/7 total=137 rows=20  첫 행 seq=21 2026-01-07 00:13:07 ATM출금 출금=659000 입금=0 잔액=5685000
13-rate-limited       RATE_LIMITED  "HTTP 429"  retryAfterSec=10
14-ip-blocked         IP_BLOCKED  "HTTP 403 + Retry-After, 본문 IP_BLOCKED"  retryAfterSec=30
15-session-expired    SESSION_EXPIRED  "HTTP 401 + X-Session-Expired"
16-conn-refused       TRANSIENT  "네트워크 ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8081"
17-timeout            TRANSIENT  "네트워크 TimeoutError: The operation was aborted due to timeout"
```

### 읽는 법

- **09는 실패가 아니다.** 요약 줄이 `page=8 / totalPages=7`이라고 말하고 행이 0개라
  둘이 맞는다. 이게 PARSE_FAILED로 나오면 차단 없는 기준선 성공률이 100%가 안 된다.
- **04와 05는 같은 403이고 둘 다 Retry-After가 없지만 판정이 다르다.** 04(2차 인증 전
  조회)는 우리 흐름이 틀린 것이라 UNKNOWN으로 원본을 남긴다. 05(코드 거부)는 30초
  경계에 걸린 코드가 대부분이라 다음 코드로 다시 하면 된다.
- **03·06은 계약 밖 입력이라 PARSE_FAILED가 나온다.** `classify()`의 적용 범위는
  거래내역 응답(`GET /transactions`) 전부와, 인증 응답(`POST /login`, `POST /auth/otp`)
  중 **2xx가 아닌 것**이다. 인증 2xx 본문의 해석과 쿠키 교체는 세션 흐름(#9)이 한다.
  `classify()`는 200을 거래내역 화면으로만 읽으므로 인증 200을 넣으면 PARSE_FAILED가
  된다. 여기서는 계약 밖에서 무엇이 나오는지 보이려고 일부러 넣었다. 01(`X-Auth-Failed`)과
  05(`OTP_REJECTED`) 분기가 분류기에 있는 이유가 이 계약이다. 둘은 인증 응답에서만 온다.
- 13의 `retryAfterSec=10`은 서버가 준 값이다. 기본값(`DEFAULT_RATE_LIMIT_WAIT_SEC`,
  역시 10)과 우연히 같으므로, 헤더를 읽었는지는 detail로 가린다. 헤더 없이 기본값을
  쓰면 detail에 "Retry-After 헤더 없음"이 붙는다(테스트로 고정).

## 부록: 판정 스크립트 전문

```ts
// 사용: pnpm tsx <이 파일> <캡처 디렉터리>   (리포 루트에서)
import { createServer } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '<리포>/collector/client/classify.ts';
import type { ClassifyInput, Headers } from '<리포>/collector/client/classify.ts';

const dir = process.argv[2]!;

function readHeaders(file: string): { status: number; headers: Headers } {
  const lines = readFileSync(file, 'latin1').split('\r\n').filter((l) => l !== '');
  const status = Number(lines[0]!.split(' ')[1]);
  const headers: Headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    const prev = headers[key];
    headers[key] = prev === undefined ? value : ([] as string[]).concat(prev, value);
  }
  return { status, headers };
}

function show(name: string, input: ClassifyInput): void {
  const r = classify(input);
  if (r.ok) {
    const p = r.page;
    const first = p.rows[0];
    console.log(`${name}  ok page=${p.page}/${p.totalPages} total=${p.total} rows=${p.rows.length}` +
      (first ? `  첫 행 seq=${first.seq} ${first.at} ${first.memo} 출금=${first.withdrawal} 입금=${first.deposit} 잔액=${first.balance}` : ''));
    return;
  }
  const extra = r.kind === 'PARSE_FAILED' || r.kind === 'UNKNOWN'
    ? `  raw=${'network' in r.raw ? 'network' : `status ${r.raw.status}, body ${r.raw.body.length}B`}`
    : r.retryAfterSec !== undefined ? `  retryAfterSec=${r.retryAfterSec}` : '';
  console.log(`${name}  ${r.kind}  "${r.detail}"${extra}`);
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.h')).sort()) {
  const name = file.slice(0, -2);
  const { status, headers } = readHeaders(join(dir, file));
  show(name.padEnd(20), { status, headers, body: readFileSync(join(dir, `${name}.b`)) });
}

// 네트워크 오류는 실제 소켓으로 만든다. 서버를 내린 뒤의 8081과, 응답하지 않는 서버.
function toNetwork(e: unknown): ClassifyInput {
  const err = e as { name?: string; message: string; cause?: { code?: string; name?: string; message?: string } };
  const code = err.cause?.code;
  const name = err.name === 'TypeError' ? err.cause?.name : err.name;
  return { network: { ...(code ? { code } : {}), ...(name ? { name } : {}), message: err.cause?.message ?? err.message } };
}
try { await fetch('http://127.0.0.1:8081/health'); } catch (e) { show('16-conn-refused'.padEnd(20), toNetwork(e)); }

const silent = createServer(() => {});
await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
const port = (silent.address() as { port: number }).port;
try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) }); } catch (e) { show('17-timeout'.padEnd(20), toNetwork(e)); }
silent.close(); silent.unref();
process.exit(0);
```
