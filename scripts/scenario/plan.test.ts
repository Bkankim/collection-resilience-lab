import { describe, expect, it } from 'vitest';

import { childEnv, periodEnd, runVerdict } from './plan.js';

describe('작업 기간 끝', () => {
  it('초·분·시가 모두 올바른 범위다', () => {
    expect(periodEnd(0)).toBe('2026-09-01 00:00:00');
    expect(periodEnd(199)).toBe('2026-09-01 00:03:19');
    expect(periodEnd(3599)).toBe('2026-09-01 00:59:59');
    // 3600번째가 00:60:00이 되면 API가 400으로 거절해 실행이 멈췄다.
    expect(periodEnd(3600)).toBe('2026-09-01 01:00:00');
  });
});

describe('실행 판정', () => {
  it('다 돌았으면 두 파일을 쓰고 0으로 끝낸다', () => {
    expect(runVerdict({ aborted: false, timedOut: [] })).toEqual({ complete: true, files: ['events.jsonl', 'results.md'], exitCode: 0, reasons: [] });
  });

  it('시간 초과면 결과표를 쓰지 않고 원시 사건은 다른 이름으로 남기며 0이 아닌 코드로 끝낸다', () => {
    const v = runVerdict({ aborted: false, timedOut: ['ip-block'] });
    expect(v.complete).toBe(false);
    expect(v.files).toEqual(['events.aborted.jsonl']);
    expect(v.exitCode).not.toBe(0);
    expect(v.reasons.join(' ')).toContain('ip-block');
  });

  it('중단(워커가 죽음 등)도 같다. 커밋된 events.jsonl·results.md 이름은 쓰지 않는다', () => {
    const v = runVerdict({ aborted: true, timedOut: [] });
    expect(v.files).not.toContain('events.jsonl');
    expect(v.files).not.toContain('results.md');
    expect(v.exitCode).not.toBe(0);
  });
});

describe('워커 자식 환경', () => {
  it('물려받은 워커 설정과 자격증명 변수를 지우고 명시한 값만 더한다', () => {
    const env = childEnv(
      { PATH: '/bin', WORKER_LIMIT_MAX: '1', WORKER_PROXIES: 'x', QUEUE_NAME: 'q', COLLECTOR_DEMO01_PASSWORD: 'wrong', COLLECTOR_DEMO01_TOTP_SECRET: 'x' },
      { REDIS_URL: 'redis://r/15', WORKER_NAME: 'w1' },
    );
    expect(env).toEqual({ PATH: '/bin', REDIS_URL: 'redis://r/15', WORKER_NAME: 'w1' });
  });
});
