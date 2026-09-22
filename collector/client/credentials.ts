/**
 * 로그인 ID로 자격증명(비밀번호, TOTP 공유키)을 찾는다.
 *
 * 이 파일이 있는 이유는 **큐 페이로드에 비밀을 싣지 않기 위해서**다. 작업에는 로그인
 * ID만 싣고, 워커가 실행되는 자리에서 여기로 찾는다. 페이로드에 비밀번호를 넣으면
 * 큐 저장소(Redis)와 DLQ, 실패 로그에 비밀이 그대로 남는다. DLQ는 사람이 들여다보라고
 * 만든 곳이라 특히 그렇다.
 *
 * 기본값은 대상 서버(`target/accounts.ts`)와 같은 공개 데모 값이다. 실제 계정이 아니고
 * 리포에 공개되어 있다. 환경변수로 덮어쓸 수 있게 한 것은 데모 값이 아닌 대상을 붙일
 * 때 코드를 고치지 않기 위해서다.
 *
 * 여기서 막는 것은 **틀린 설정으로 요청을 보내는 것**까지다. 올바른 설정인데 비밀번호가
 * 바뀐 경우처럼 AUTH_FAILED를 받은 뒤 같은 로그인 ID로 더 시도하지 않게 막는 차단기는
 * 작업 여러 개를 가로질러 봐야 하므로 워커(#13) 몫이다. 이 파일은 작업 하나만 본다.
 */

import { generateSync } from 'otplib';

export type Credentials = {
  loginId: string;
  password: string;
  /** base32. otplib 13은 디코딩한 길이가 16바이트(128비트) 미만이면 거부한다. */
  totpSecret: string;
};

const DEMO_CREDENTIALS: readonly Credentials[] = [
  { loginId: 'demo01', password: 'demo-pass-01', totpSecret: 'LDL3EJLY2NS3RYE6K77KL6PRFKQ4ZK3M' },
  { loginId: 'demo02', password: 'demo-pass-02', totpSecret: 'AOK4WNWZSOGBDBZ7KFEWQVURPJB5PWZC' },
];

/**
 * 환경변수 이름. 로그인 ID를 대문자로 바꾸고 영숫자가 아닌 글자는 `_`로 바꾼다.
 * 예: `demo01` → `COLLECTOR_DEMO01_PASSWORD`, `COLLECTOR_DEMO01_TOTP_SECRET`.
 */
export function envKey(loginId: string, field: 'PASSWORD' | 'TOTP_SECRET'): string {
  return `COLLECTOR_${loginId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${field}`;
}

/**
 * 자격증명을 찾는다. 없으면 undefined, 형식이 틀리면 던진다.
 *
 * 환경변수는 필드별로 덮어쓴다. 둘 중 하나만 있고 데모 기본값도 없는 ID는 찾지 못한
 * 것으로 본다. 반쪽 자격증명으로 로그인하면 비밀번호 오류가 쌓여 계정이 잠길 수 있다.
 *
 * **빈 값(공백만 있는 값 포함)은 설정하지 않은 것으로 본다.** `COLLECTOR_DEMO01_PASSWORD=`
 * 한 줄이 비밀번호를 빈 문자열로 덮으면, 작업 다섯 건 만에 계정이 잠기고 그 뒤로는
 * 올바른 비밀번호도 거절된다. 배포 설정에서 값만 비운 줄은 흔하다.
 */
export function lookupCredentials(
  loginId: string,
  env: Record<string, string | undefined> = process.env,
): Credentials | undefined {
  const demo = DEMO_CREDENTIALS.find((c) => c.loginId === loginId);
  const password = nonBlank(env[envKey(loginId, 'PASSWORD')]) ?? demo?.password;
  const totpSecret = nonBlank(env[envKey(loginId, 'TOTP_SECRET')]) ?? demo?.totpSecret;
  if (password === undefined || totpSecret === undefined) return undefined;
  assertTotpSecret(loginId, totpSecret);
  return { loginId, password, totpSecret };
}

/**
 * TOTP 공유키를 요청을 보내기 **전에** 검증한다. 틀리면 설정 오류로 던진다.
 *
 * 검증을 안 하면 1차 인증(비밀번호)을 보낸 뒤에야 코드 생성이 예외로 터진다. 비밀번호는
 * 이미 나갔고 실패는 분류기를 거치지 않는다.
 *
 * base32 규칙을 여기서 다시 구현하지 않고 otplib로 코드를 한 번 만들어 본다. otplib은
 * 알파벳·길이 말고도 끝 비트가 0이 아닌 패딩까지 거부하므로(`Non-zero padding`), 정규식을
 * 따로 두면 통과시킨 값을 로그인 때 otplib이 거부하는 틈이 생긴다. 같은 함수로 검증해야
 * 검증과 사용이 어긋나지 않는다.
 */
export function assertTotpSecret(loginId: string, totpSecret: string): void {
  try {
    generateSync({ secret: totpSecret, epoch: 0 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 공유키 자체는 메시지에 싣지 않는다. 설정 오류 로그에 비밀이 남는다.
    throw new RangeError(`${loginId}의 TOTP 공유키 형식이 틀렸다: ${reason}`);
  }
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
