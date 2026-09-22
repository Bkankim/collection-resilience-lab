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
 */

export type Credentials = {
  loginId: string;
  password: string;
  /** base32. otplib 13은 20바이트(base32 32자) 미만을 거부한다. */
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
 * 자격증명을 찾는다. 없으면 undefined.
 *
 * 환경변수는 필드별로 덮어쓴다. 둘 중 하나만 있고 데모 기본값도 없는 ID는 찾지 못한
 * 것으로 본다. 반쪽 자격증명으로 로그인하면 비밀번호 오류가 쌓여 계정이 잠길 수 있다.
 */
export function lookupCredentials(
  loginId: string,
  env: Record<string, string | undefined> = process.env,
): Credentials | undefined {
  const demo = DEMO_CREDENTIALS.find((c) => c.loginId === loginId);
  const password = env[envKey(loginId, 'PASSWORD')] ?? demo?.password;
  const totpSecret = env[envKey(loginId, 'TOTP_SECRET')] ?? demo?.totpSecret;
  if (password === undefined || totpSecret === undefined) return undefined;
  return { loginId, password, totpSecret };
}
