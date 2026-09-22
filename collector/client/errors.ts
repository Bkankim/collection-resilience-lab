/**
 * 수집 실패를 어떻게 나눌지, 나눈 뒤 무엇을 할지.
 *
 * 이 파일이 이 프로젝트의 중심 결정이다. 실패를 뭉뚱그리면 재시도밖에 못 하지만,
 * 종류를 나누면 종류마다 다른 대응을 걸 수 있다.
 */

/** 수집이 실패한 이유. 대응이 달라지는 단위로만 나눈다. */
export type FailureKind =
  /** 요청 속도가 상대 서버 기준을 넘었다. 잠시 멈추면 풀린다. */
  | 'RATE_LIMITED'
  /** 출발지 IP가 막혔다. 같은 IP로는 기다려도 풀리지 않는다. */
  | 'IP_BLOCKED'
  /** 인증은 있었으나 세션이 더는 유효하지 않다. */
  | 'SESSION_EXPIRED'
  /** 응답은 받았으나 기대한 구조가 아니다. */
  | 'PARSE_FAILED'
  /** 위 어디에도 넣을 수 없다. 분류를 못 했다는 사실 자체를 남긴다. */
  | 'UNKNOWN';

/** 실패했을 때 무엇을 할 것인가. */
export type Remedy =
  /** 큐 전체를 잠시 멈춘다. 워커별로 각자 자는 것과 다르다. */
  | 'PAUSE_QUEUE'
  /** 다른 출발지로 바꾼다. */
  | 'ROTATE_EGRESS'
  /** 다시 인증한다. */
  | 'REAUTH'
  /** 다른 파서로 다시 읽는다. */
  | 'REPARSE'
  /** 사람이 볼 곳으로 보낸다. */
  | 'DEAD_LETTER';

/**
 * 실패 종류별 1차 대응.
 *
 * IP_BLOCKED가 ROTATE_EGRESS + REAUTH인 이유: 출발지를 바꾸면 세션이 함께 죽는
 * 설계를 가정한다. 상대 서버가 세션을 발급 IP에 묶는 경우가 있기 때문이다.
 */
export const FIRST_REMEDY: Record<FailureKind, readonly Remedy[]> = {
  RATE_LIMITED: ['PAUSE_QUEUE'],
  IP_BLOCKED: ['ROTATE_EGRESS', 'REAUTH'],
  SESSION_EXPIRED: ['REAUTH'],
  PARSE_FAILED: ['REPARSE'],
  UNKNOWN: ['DEAD_LETTER'],
} as const;

export const FAILURE_KINDS = Object.keys(FIRST_REMEDY) as readonly FailureKind[];
