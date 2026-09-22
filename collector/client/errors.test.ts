import { describe, expect, it } from 'vitest';
import { CONSUMES_ATTEMPT, FAILURE_KINDS, FIRST_REMEDY } from './errors.js';

describe('실패 분류와 대응 테이블', () => {
  it('모든 실패 종류에 대응이 하나 이상 있다', () => {
    for (const kind of FAILURE_KINDS) {
      expect(FIRST_REMEDY[kind].length).toBeGreaterThan(0);
    }
  });

  it('자격증명 실패에는 재인증을 걸지 않는다', () => {
    // 비밀번호 오류가 누적되면 계정이 잠긴다. 여기서 재인증을 돌리면
    // 워커가 고객 계정을 잠그게 된다. 이 테스트가 그 실수를 막는다.
    expect(FIRST_REMEDY.AUTH_FAILED).not.toContain('REAUTH');
    expect(FIRST_REMEDY.AUTH_FAILED).toContain('DEAD_LETTER');
  });

  it('세션 만료와 자격증명 실패의 대응이 서로 다르다', () => {
    // 둘을 한 종류로 합치면 위 보호가 무너진다.
    expect(FIRST_REMEDY.SESSION_EXPIRED).not.toEqual(FIRST_REMEDY.AUTH_FAILED);
  });

  it('속도 제한은 워커 개별 대기가 아니라 큐 전체를 멈춘다', () => {
    // 워커마다 각자 자면 워커 수만큼 한도를 넘는다.
    expect(FIRST_REMEDY.RATE_LIMITED).toContain('PAUSE_QUEUE');
    expect(FIRST_REMEDY.RATE_LIMITED).not.toContain('ROTATE_EGRESS');
  });

  it('출발지를 바꾸면 세션도 다시 만든다', () => {
    expect(FIRST_REMEDY.IP_BLOCKED).toEqual(['ROTATE_EGRESS', 'REAUTH']);
  });

  it('일시 장애는 버리지 않고 다시 시도한다', () => {
    // 5xx·타임아웃은 수집에서 가장 흔한 실패다. 이게 DLQ로 가면
    // 가장 흔한 실패에 가장 무거운 처분을 내리는 셈이 된다.
    expect(FIRST_REMEDY.TRANSIENT).toContain('RETRY_BACKOFF');
    expect(FIRST_REMEDY.TRANSIENT).not.toContain('DEAD_LETTER');
  });

  it('분류하지 못한 실패는 원본을 남기고 사람에게 넘긴다', () => {
    expect(FIRST_REMEDY.UNKNOWN).toEqual(['CAPTURE_RAW', 'DEAD_LETTER']);
  });

  it('환경이 막은 실패는 작업의 시도 횟수를 깎지 않는다', () => {
    // 큐를 세 번 멈춘 것만으로 멀쩡한 작업이 DLQ에 가면 안 된다.
    expect(CONSUMES_ATTEMPT.RATE_LIMITED).toBe(false);
    expect(CONSUMES_ATTEMPT.IP_BLOCKED).toBe(false);
    expect(CONSUMES_ATTEMPT.SESSION_EXPIRED).toBe(false);
  });

  it('작업 자체의 문제는 시도 횟수를 깎는다', () => {
    expect(CONSUMES_ATTEMPT.TRANSIENT).toBe(true);
    expect(CONSUMES_ATTEMPT.PARSE_FAILED).toBe(true);
    expect(CONSUMES_ATTEMPT.UNKNOWN).toBe(true);
  });
});
