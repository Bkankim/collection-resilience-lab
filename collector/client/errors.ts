/**
 * 수집 실패를 어떻게 나눌지, 나눈 뒤 무엇을 할지.
 *
 * 이 파일이 이 프로젝트의 중심 결정이다. 실패를 뭉뚱그리면 재시도밖에 못 하지만,
 * 종류를 나누면 종류마다 다른 대응을 걸 수 있다.
 *
 * 나누는 기준은 "대응이 달라지는가" 하나다. 원인이 달라도 대응이 같으면 합친다.
 */

/** 수집이 실패한 이유. */
export type FailureKind =
  /** 요청 속도가 상대 서버 기준을 넘었다. 잠시 멈추면 풀린다. */
  | 'RATE_LIMITED'
  /** 출발지가 막혔다. 같은 출발지로는 기다려도 풀리지 않는다. */
  | 'IP_BLOCKED'
  /** 인증은 통과했었으나 세션이 더는 유효하지 않다. 다시 인증하면 된다. */
  | 'SESSION_EXPIRED'
  /**
   * 자격증명 자체가 거부됐다. 비밀번호 불일치, 계정 잠김 등.
   *
   * SESSION_EXPIRED와 반드시 분리한다. 국내 금융기관은 비밀번호 오류가
   * 누적되면 계정을 잠근다. 이걸 세션 만료로 잘못 읽고 재인증을 돌리면
   * 워커가 고객 계정을 잠그게 된다. 대응은 즉시 중단뿐이다.
   */
  | 'AUTH_FAILED'
  /** 5xx, 타임아웃, 연결 리셋처럼 잠시 뒤 다시 하면 되는 실패. */
  | 'TRANSIENT'
  /** 응답은 받았으나 기대한 구조가 아니다. 코드를 고쳐야 풀린다. */
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
  /** 같은 조건으로 잠시 뒤 다시 시도한다. */
  | 'RETRY_BACKOFF'
  /** 원본 응답을 남긴다. 사람이 보고 코드를 고쳐야 하는 경우. */
  | 'CAPTURE_RAW'
  /** 사람이 볼 곳으로 보낸다. */
  | 'DEAD_LETTER';

/**
 * 실패 종류별 대응. 배열은 **순서대로 전부** 수행한다. 첫 성공에서 멈추지 않는다.
 *
 * IP_BLOCKED가 ROTATE_EGRESS 다음에 REAUTH를 하는 이유: 출발지를 바꾸면 세션이
 * 함께 죽는 설계를 가정한다. 상대 서버가 세션을 발급 출발지에 묶는 경우가 있다.
 *
 * PARSE_FAILED에 다른 파서로 재시도를 넣지 않았다. 응답 구조가 바뀌면 코드를
 * 고쳐야 하지 자동으로 풀리지 않는다. 원본을 남기고 넘기는 편이 정직하다.
 */
export const FIRST_REMEDY = {
  RATE_LIMITED: ['PAUSE_QUEUE'],
  IP_BLOCKED: ['ROTATE_EGRESS', 'REAUTH'],
  SESSION_EXPIRED: ['REAUTH'],
  AUTH_FAILED: ['DEAD_LETTER'],
  TRANSIENT: ['RETRY_BACKOFF'],
  PARSE_FAILED: ['CAPTURE_RAW', 'DEAD_LETTER'],
  UNKNOWN: ['CAPTURE_RAW', 'DEAD_LETTER'],
} as const satisfies Record<FailureKind, readonly Remedy[]>;

/**
 * 이 실패가 작업의 시도 횟수를 깎는가.
 *
 * 속도 제한과 출발지 차단은 작업이 잘못된 게 아니라 환경이 막은 것이다.
 * 이걸 시도 횟수로 세면, 큐를 세 번 멈춘 것만으로 멀쩡한 작업이 DLQ로 간다.
 */
export const CONSUMES_ATTEMPT = {
  RATE_LIMITED: false,
  IP_BLOCKED: false,
  SESSION_EXPIRED: false,
  AUTH_FAILED: true,
  TRANSIENT: true,
  PARSE_FAILED: true,
  UNKNOWN: true,
} as const satisfies Record<FailureKind, boolean>;

export const FAILURE_KINDS = [
  'RATE_LIMITED',
  'IP_BLOCKED',
  'SESSION_EXPIRED',
  'AUTH_FAILED',
  'TRANSIENT',
  'PARSE_FAILED',
  'UNKNOWN',
] as const satisfies readonly FailureKind[];
