# D1 증거: 수집 대상 서버 실행 기록

`target/app.test.ts`가 같은 내용을 CI에서 검증합니다. 이 파일은 **실제로 포트를
열고 curl로 주고받은 기록**입니다. 테스트는 `app.inject()`를 쓰므로 소켓과
쿠키 자를 거치지 않는데, 그 차이에서 실제 결함이 하나 나왔습니다(11절, 그리고
`docs/TROUBLESHOOTING.md` 2번).

## 실행 조건

| 항목 | 값 |
|---|---|
| 채취일 | 2026-09-22 |
| Node | v26.4.0 |
| 서버 | `PORT=8081 tsx target/server.ts` (새로 띄운 프로세스에 한 번에 채취) |
| 계정 | `demo01` / `demo-pass-01` (리포에 공개된 실험용 고정 계정) |
| 출발지 | 전부 `127.0.0.1`. 출발지 분리는 프록시 컨테이너를 붙이는 D3(#14)에서 다룹니다 |

9·10·11절은 각각 `POST /admin/reset` 뒤에 **스위치 3개와 임계값 5개를 전부
명시해서** 조건을 세웁니다. 관리 API의 설정은 병합이라 빠뜨린 키에 이전 값이
남고, 그러면 절끼리 조건이 새어 조건을 기록한다는 문서가 자기 조건을 틀리게
적게 됩니다. 각 절의 첫 응답에 그때 적용된 `W/N/M/T/S`가 전부 찍혀 있습니다.
수치는 조건과 같이 봐야 합니다.

> 9·10절에서 차단을 통과한 요청이 200이 아니라 401인 것은 직전 `reset`이 세션도
> 지웠기 때문입니다. **차단 판정이 인증보다 먼저 일어나는 것**이 여기서 보입니다.
> 차단에 걸린 요청은 429/403이고, 통과한 요청만 인증 단계로 내려가 401을 받습니다.

---

### 0. 헬스체크

```
$ curl -i $B/health
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
content-length: 11
```

### 1. 인증 없이 조회 -> 401 (구분 헤더 없음)

```
$ curl -i $B/transactions
HTTP/1.1 401 Unauthorized
content-type: application/json; charset=utf-8
```

### 2. 비밀번호 오류 -> 401 + X-Auth-Failed

```
$ curl -i -X POST $B/login -d '{"id":"demo01","password":"wrong"}'
HTTP/1.1 401 Unauthorized
x-auth-failed: 1
content-type: application/json; charset=utf-8
```

### 3. 로그인 성공 -> Set-Cookie (HttpOnly / Path / Max-Age)

```
$ curl -i -X POST $B/login -d '{"id":"demo01","password":"demo-pass-01"}'
HTTP/1.1 200 OK
set-cookie: lab_session=rhbebuX2sveBCbGDhSa0FqCTV3YhA8q5; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800
content-type: application/json; charset=utf-8

# 1차 세션 식별자: rhbebuX2sveB...
```

### 4. 1차만 통과한 세션으로 조회 -> 403

```
$ curl -i -b jar $B/transactions
HTTP/1.1 403 Forbidden
content-type: application/json; charset=utf-8
```

### 5. OTP 오류 -> 403 (1차 상태 유지, 401 아님)

```
$ curl -i -b jar -X POST $B/auth/otp -d '{"token":"000000"}'
HTTP/1.1 403 Forbidden
content-type: application/json; charset=utf-8
```

### 6. OTP 통과 -> 세션 식별자 재발급 (권한이 바뀌는 두 번째 지점)

```
$ curl -i -b jar -X POST $B/auth/otp -d '{"token":"<TOTP>"}'
HTTP/1.1 200 OK
set-cookie: lab_session=GdcHk-gmf3SEaSifPiHZX0_UjuVr19w6; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800
content-type: application/json; charset=utf-8

# 2차 세션 식별자: GdcHk-gmf3SE...   1차와 다른가: 예
```

### 7. 거래내역 조회 -> 200, EUC-KR

```
$ curl -i -b jar '$B/transactions?page=1'
HTTP/1.1 200 OK
content-type: text/html; charset=euc-kr
content-length: 5423

# 본문 바이트 - 한글이 EUC-KR 2바이트인지 (c6e4 c0cc c1f6 = 페이지)
00000110: 3120 2f20 3720 c6e4 c0cc c1f6 0a20 203c  1 / 7 .......  <
00000120: 2f70 3e0a 2020 3c74 6162 6c65 2069 643d  /p>.  <table id=

# EUC-KR로 디코드
  <p id="summary" data-account="000-11-222333" data-total="137" data-page="1" data-page-size="20" data-total-pages="7">
        <td class="memo">ATM출금</td>
        <td class="memo">통신요금</td>
```

### 8. 마지막 페이지(7) 이후 -> 빈 목록이지만 표 구조는 그대로

```
$ curl -b jar '$B/transactions?page=8' | iconv -f EUC-KR -t UTF-8
  <p id="summary" data-account="000-11-222333" data-total="137" data-page="8" data-page-size="20" data-total-pages="7">
  <table id="transactions">
    <thead>
    <tbody>
    </tbody>
```

### 9. 속도 제한 W=10초 / N=2회

```
$ curl -X POST $B/admin/switches -d '<스위치 3개·임계값 5개 전부 명시>'   # 적용된 조건은 아래 응답 그대로
{"switches":{"rateLimit":true,"ipBlock":false,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":2,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":60}}

# 같은 출발지로 연속 4회. 직전 reset이 세션도 지웠으므로 차단을 통과한
# 요청은 인증 단계로 내려가 401이 된다. 차단된 요청만 429다.
  1회: 401
  2회: 401
  3회: 429 (Retry-After: 10)
  4회: 429 (Retry-After: 10)

# 창(10초)이 지난 뒤
  5회: 401
```

### 10. 출발지 차단 M=2회 누적 / T=5초

```
$ curl -X POST $B/admin/switches -d '<스위치 3개·임계값 5개 전부 명시>'   # 적용된 조건은 아래 응답 그대로
{"switches":{"rateLimit":true,"ipBlock":true,"sessionExpiry":false},"thresholds":{"windowSec":10,"maxRequests":2,"blockAfter":2,"blockDurationSec":5,"sessionTtlSec":60}}

# 같은 출발지로 연속 5회 - 2회 통과 -> 429(누적 1) -> 누적 2에서 차단 403
  1회: 401
  2회: 401
  3회: 429 (Retry-After: 10)
  4회: 403 (Retry-After: 5)
  5회: 403 (Retry-After: 5)

# 차단된 출발지에서도 관리 API는 살아 있다 (아니면 차단을 끌 방법이 없다)
  GET /admin/switches -> 200
  GET /health         -> 200

# T=5초가 지나면 자동 해제되고 누적 429도 함께 지워진다
  6회: 401
  7회: 401
```

### 11. 세션 만료 S=1초 -> 401 + X-Session-Expired

```
$ curl -X POST $B/admin/switches -d '<스위치 3개·임계값 5개 전부 명시>'   # 적용된 조건은 아래 응답 그대로
{"switches":{"rateLimit":false,"ipBlock":false,"sessionExpiry":true},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":1}}

# 발급 직후
  200  (X-Session-Expired 없음)

# S=1초 경과 후 - 재시도해도 같은 분류가 유지되는지 3회 확인
  1회: 401  X-Session-Expired: 1
  2회: 401  X-Session-Expired: 1
  3회: 401  X-Session-Expired: 1

# 쿠키 자에는 남아 있다. Max-Age를 S와 같게 뒀다면 curl이 여기서 쿠키를
# 스스로 버려서 서버가 만료 이유를 말할 기회가 없어진다.
  lab_session (만료 1790072896)
```

### 12. 최종 스위치 상태 (측정 조건으로 결과표에 함께 적는다)

```
$ curl $B/admin/switches
{"switches":{"rateLimit":false,"ipBlock":false,"sessionExpiry":true},"thresholds":{"windowSec":10,"maxRequests":5,"blockAfter":3,"blockDurationSec":30,"sessionTtlSec":1}}
```
