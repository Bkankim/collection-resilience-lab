import { describe, expect, it } from 'vitest';
import { FAILURE_KINDS, FIRST_REMEDY, type FailureKind } from './errors.js';

describe('실패 분류와 대응 테이블', () => {
  it('모든 실패 종류에 1차 대응이 하나 이상 있다', () => {
    for (const kind of FAILURE_KINDS) {
      expect(FIRST_REMEDY[kind]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('분류하지 못한 실패는 조용히 재시도하지 않고 사람에게 넘긴다', () => {
    expect(FIRST_REMEDY.UNKNOWN).toContain('DEAD_LETTER');
  });

  it('속도 제한은 워커 개별 대기가 아니라 큐 전체를 멈춘다', () => {
    // 워커마다 각자 자면 3대가 각자 한도까지 때리므로 상대 기준을 못 지킨다.
    expect(FIRST_REMEDY.RATE_LIMITED).toContain('PAUSE_QUEUE');
    expect(FIRST_REMEDY.RATE_LIMITED).not.toContain('ROTATE_EGRESS');
  });

  it('IP 차단은 출발지를 바꾸고 다시 인증한다', () => {
    const remedy: readonly string[] = FIRST_REMEDY.IP_BLOCKED;
    expect(remedy).toEqual(['ROTATE_EGRESS', 'REAUTH']);
  });

  it('종류 목록과 테이블 키가 어긋나지 않는다', () => {
    const fromTable = Object.keys(FIRST_REMEDY).sort();
    const fromList = [...FAILURE_KINDS].sort() as FailureKind[];
    expect(fromList).toEqual(fromTable);
  });
});
