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
