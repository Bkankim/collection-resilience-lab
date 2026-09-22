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
