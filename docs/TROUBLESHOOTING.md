# 트러블슈팅 기록

실제로 막혔던 것만 적는다. 증상 → 가설 → 증거 → 원인 → 수정 순서를 지킨다.

---

## 1. pnpm install이 exit 1을 내서 모든 스크립트가 죽었다

- **증상**: `pnpm install`이 `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.21.5, esbuild@0.28.2`로 종료 코드 1을 냈다. 그 뒤 `pnpm typecheck`, `pnpm test`가 전부 실패했다. pnpm은 실행 전에 의존성 상태를 검사하면서 install을 다시 돌리는데, 그 install이 1을 내니 스크립트가 시작조차 못 했다.

- **가설**
  1. esbuild 네이티브 바이너리가 설치되지 않아 vitest가 실제로 못 돈다.
  2. 빌드 승인 설정을 쓴 위치가 틀렸다.
  3. TTY가 없는 환경이라 pnpm이 대화형 승인을 못 받아 실패한다.

- **증거**
  - `ls node_modules/.pnpm | grep @esbuild` → `@esbuild+darwin-arm64@0.21.5`, `@esbuild+darwin-arm64@0.28.2` 존재. 플랫폼별 prebuilt가 이미 깔려 있다.
  - `./node_modules/.bin/vitest run` → 5 tests passed. `./node_modules/.bin/tsc --noEmit` → 통과. **기능은 멀쩡하다.** 가설 1 기각.
  - `CI=true pnpm install` → 동일 실패. 가설 3 기각.
  - `package.json`에 `pnpm.onlyBuiltDependencies`를 넣자 `[WARN] The "pnpm" field in package.json is no longer read by pnpm`.
  - `pnpm-workspace.yaml`로 옮겨도 동일 실패. 그런데 **실패한 install이 그 파일에 다음을 자동으로 써넣었다**:
    ```yaml
    allowBuilds:
      esbuild: set this to true or false
    ```

- **원인**: pnpm 11이 설정 스키마를 두 단계로 바꿨다. `package.json`의 `pnpm` 필드는 더 읽지 않고, 설정 홈은 `pnpm-workspace.yaml`로 옮겼으며, 빌드 승인 키도 `onlyBuiltDependencies` 배열에서 `allowBuilds` 맵으로 바뀌었다. 옛 키를 쓰면 조용히 무시되고 같은 에러만 반복된다. `--allow-build` CLI 옵션도 이 버전에는 없다(`Unknown option`).

- **수정**: `pnpm-workspace.yaml`에 `allowBuilds: { esbuild: true }`. install이 postinstall을 실행하고 종료 코드 0으로 끝나며, `pnpm typecheck`와 `pnpm test`가 래퍼를 통해 정상 동작한다.

- **남는 것**: 승인 대상을 늘릴 때마다 이 파일을 고쳐야 한다. CI 러너의 pnpm 버전이 10 이하로 내려가면 이 키를 못 읽으므로, `packageManager` 필드로 버전을 고정해 둔다.

---

## 2. 테스트는 통과하는데 실제 curl에서는 세션 만료 헤더가 안 왔다

- **증상**: `X-Session-Expired: 1`을 검증하는 통합 테스트가 통과했는데, 같은 시나리오를 실제 서버에 curl로 돌리니 헤더가 없는 맨 401이 왔다. 본문은 `{"error":"NO_SESSION"}`(22바이트)이었다. 수집하는 쪽에서 보면 **재인증하면 되는 상황**과 **처음부터 인증이 없는 상황**이 같은 응답이 된다.

- **가설**
  1. curl 쿠키 자가 `Max-Age`를 지켜서 쿠키를 아예 안 보낸다.
  2. 서버가 만료를 감지한 첫 요청에서 세션을 지워 버려, 그다음 요청은 "모르는 세션"이 된다.
  3. `POST /admin/switches`가 세션까지 날린다.

- **증거**
  - 가설 3 기각: `configure()`는 차단 카운터만 비운다. 게다가 재현 절차에서 스위치 설정은 로그인보다 **먼저** 했다.
  - 쿠키 자 파일을 직접 열어 보니 만료 시각이 박힌 채 줄은 그대로 남아 있었다. 즉 파일에는 있는데 curl이 **보내지 않는** 상태다.
  - 같은 쿠키 값을 `-H "Cookie: ..."`로 직접 실어 보내자 `401 + x-session-expired: 1`이 왔다. → **가설 1 확정.**
  - 그런데 같은 값으로 한 번 더 보내니 다시 `NO_SESSION`이 왔다. → **가설 2도 따로 참이다.** 두 결함이 겹쳐 있었다.
  - 테스트가 못 잡은 이유: `app.inject()`는 `Cookie` 헤더를 그대로 실어 보내므로 `Max-Age`를 해석하는 쪽이 아예 없다. 그리고 만료 검증을 요청 한 번으로만 했다.

- **원인**
  1. 쿠키 `Max-Age`를 세션 만료 임계값 `S`와 **같은 값**으로 내렸다. 규격을 지키는 클라이언트는 정확히 서버가 만료를 선언하려는 그 시점에 쿠키를 스스로 버린다. 서버는 이유를 말할 기회를 못 얻는다.
  2. 만료를 감지한 자리에서 세션 레코드를 `drop`했다. 워커는 재시도를 하므로 같은 쿠키로 두 번째 요청이 오는 일이 흔한데, 그때 원인이 하나인데 분류가 둘(`SESSION_EXPIRED` → `NO_SESSION`)이 된다.

- **수정**
  1. 쿠키 `Max-Age`를 `S`에서 떼어 고정 상수(1800초)로 바꿨다. 만료 판정의 권위자는 서버이고, 쿠키 수명은 서버 수명보다 길어야 서버가 말할 기회를 갖는다.
  2. 만료된 식별자를 지우지 않고 "만료였다"는 사실만 남겨, 몇 번을 물어도 같은 분류를 돌려준다. 로그인·승급에서 버리는 식별자는 여기 넣지 않는다. 그건 만료가 아니라 폐기라서 `NO_SESSION`이 맞다.
  3. 회귀 테스트 3개를 추가했다. 만료 후 3회 연속 같은 헤더가 오는지, `Max-Age`가 `S`에 연동되지 않는지, 폐기와 만료가 다르게 답하는지.

- **남는 것**: `app.inject()`로만 검증하면 소켓·쿠키 자·인코딩처럼 **경계에 있는 것**을 못 본다. 회차마다 실제 포트를 열어 curl 기록을 `docs/evidence/`에 남기기로 했다. 이 건은 그 기록(`d1-target-server.md` 11절)에서 나왔다.
