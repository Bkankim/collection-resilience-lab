/**
 * 측정 지표(#15). 이슈 본문의 정의를 그대로 쓰고, 모호한 곳은 측정 전에 여기서 정했다.
 *
 * - 성공률 = 완료(completed) 작업 수 / 투입 작업 수.
 * - 회복 시간 = 첫 실패 응답 시각부터, 그 뒤 **끝난 순서로** 작업 10건이 연달아 완료된 시각까지.
 *   "첫 실패"는 작업이 실패로 끝난 것이 아니라 워커가 받은 첫 실패 응답이다(중계가 본 첫 비 2xx 응답).
 *   이 설계는 속도 제한·차단에서 작업을 버리지 않으므로 작업 단위 실패는 거의 0이기 때문이다.
 *   연속을 끊는 것은 DLQ로 간 작업(`dead-letter`)이다. 실패 응답이 하나도 없으면 "해당 없음"이다.
 * - 처리량 = 완료 작업 수 / 전체 소요 시간(초). 소요 시간은 첫 작업을 넣기 직전부터 마지막 작업이 끝난 사건까지다.
 */

export const RECOVERY_STREAK = 10;

/** 작업이 끝난 사건. 워커 로그의 `completed`·`dead-letter`에서 온다. */
export type Terminal = { at: number; jobId: string; ok: boolean };

export type Recovery =
  | { kind: 'none' }
  | { kind: 'recovered'; firstFailureAt: number; recoveredAt: number; ms: number }
  | { kind: 'not-recovered'; firstFailureAt: number };

/**
 * 회복 시간. `failureTimes`는 실패 응답 시각들, `terminals`는 작업이 끝난 사건들이다(순서는 상관없다).
 * 같은 시각의 사건은 첫 실패와 같은 ms에 끝난 작업도 "그 뒤"로 센다. ms 단위 로그라 앞뒤를 가를 수 없고,
 * 빼면 회복이 1건 늦어진다.
 */
export function recoveryOf(failureTimes: readonly number[], terminals: readonly Terminal[], streak: number = RECOVERY_STREAK): Recovery {
  if (failureTimes.length === 0) return { kind: 'none' };
  const firstFailureAt = Math.min(...failureTimes);
  const after = terminals.filter((t) => t.at >= firstFailureAt).sort((a, b) => a.at - b.at);
  let run = 0;
  for (const t of after) {
    run = t.ok ? run + 1 : 0;
    if (run === streak) return { kind: 'recovered', firstFailureAt, recoveredAt: t.at, ms: t.at - firstFailureAt };
  }
  return { kind: 'not-recovered', firstFailureAt };
}

/**
 * 실패 응답 구간(첫 실패 응답부터 마지막 실패 응답까지). 회복 시간을 해석할 때 옆에 둔다.
 *
 * 이 설계에서는 작업이 실패로 끝나지 않으므로, 회복 시간은 사실상 "첫 실패 응답 뒤 작업 10건이 끝나는 데 걸린 시간"이고
 * 10/처리량(`secondsForStreak`)과 거의 같다. 실패가 멈춘 시점은 재지 않는다. 실패가 언제까지 이어졌는지는 이 구간이 보인다.
 */
export function failureWindow(failureTimes: readonly number[]): { first: number; last: number; ms: number } | null {
  if (failureTimes.length === 0) return null;
  const first = Math.min(...failureTimes);
  const last = Math.max(...failureTimes);
  return { first, last, ms: last - first };
}

/** 처리량으로 계산한, 작업 `streak`건을 끝내는 데 걸리는 시간(초). 처리량이 0이면 null. */
export function secondsForStreak(throughput: number, streak: number = RECOVERY_STREAK): number | null {
  return throughput <= 0 ? null : streak / throughput;
}

export function throughputOf(completed: number, startedAt: number, endedAt: number): number {
  const seconds = (endedAt - startedAt) / 1000;
  return seconds <= 0 ? 0 : completed / seconds;
}

export function formatRecovery(recovery: Recovery): string {
  switch (recovery.kind) {
    case 'none':
      return '해당 없음(실패 응답 0)';
    case 'not-recovered':
      return `회복 안 됨(연속 ${RECOVERY_STREAK}건 완료 없음)`;
    case 'recovered':
      return `${(recovery.ms / 1000).toFixed(2)}초`;
  }
}

/** 마크다운 표. 칸 안의 `|`는 이스케이프한다. */
export function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|');
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
