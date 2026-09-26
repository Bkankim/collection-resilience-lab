/**
 * 러너(`scripts/scenario.ts`)의 판정 로직. 러너 전체는 Redis·컨테이너·프로세스가 있어야 돌아서 테스트하기 어렵다.
 * 결과를 믿을 수 있는지를 가르는 판단(종료 코드, 어떤 파일을 쓰나, 작업 기간, 자식 환경)만 여기 떼어 단위 테스트한다.
 */

/** 작업마다 다른 기간 끝(초 단위). 기간 시작은 같아 원장 137행 전부가 들어간다. 작업 ID는 기간으로 갈린다. */
export function periodEnd(i: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `2026-09-01 ${pad(Math.floor(i / 3600))}:${pad(Math.floor(i / 60) % 60)}:${pad(i % 60)}`;
}

export type RunVerdict = {
  /** 모든 시나리오가 시간 안에 끝났다. 이때만 결과로 커밋할 수 있다. */
  complete: boolean;
  /** 결과 디렉터리에 쓸 파일. */
  files: string[];
  exitCode: number;
  reasons: string[];
};

/**
 * 실행 판정. 다 돌지 않은 측정(중단, 시간 초과)은 결과표를 쓰지 않고, 원시 사건은 `events.aborted.jsonl`에 남기고,
 * 0이 아닌 코드로 끝낸다. 커밋된 `events.jsonl`·`results.md` 쌍을 덮으면 같은 날 다시 돌려 실패한 실행이
 * 앞의 결과를 망가뜨린다(final-review Q2). 중단에는 워커가 도중에 죽은 경우가 들어간다(워커 2개 조건이 깨진다).
 */
export function runVerdict(input: { aborted: boolean; timedOut: readonly string[] }): RunVerdict {
  const reasons = [...(input.aborted ? ['중단'] : []), ...input.timedOut.map((key) => `시간 초과: ${key}`)];
  if (reasons.length === 0) return { complete: true, files: ['events.jsonl', 'results.md'], exitCode: 0, reasons };
  return { complete: false, files: ['events.aborted.jsonl'], exitCode: 1, reasons };
}

/**
 * 자식 프로세스 환경. 셸에서 물려받은 워커 설정(`WORKER_*`, `QUEUE_NAME`)과 자격증명(`COLLECTOR_*`)을 지우고
 * 러너가 명시한 값만 더한다. 물려받은 값이 측정 조건을 조용히 바꾸지 않게 한다. 예: 셸의 틀린
 * `COLLECTOR_DEMO01_PASSWORD`면 로그인이 전부 실패한다. 자격증명은 넘기지 않으므로 워커는 리포의 데모 값
 * (`collector/client/credentials.ts`)을 쓴다. 이 값은 어떤 로그에도 싣지 않는다.
 */
export function childEnv(parent: Record<string, string | undefined>, explicit: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (key.startsWith('WORKER_') || key === 'QUEUE_NAME' || key.startsWith('COLLECTOR_')) continue;
    env[key] = value;
  }
  return { ...env, ...explicit };
}
