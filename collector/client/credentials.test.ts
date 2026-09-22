import { describe, expect, it } from 'vitest';

import { envKey, lookupCredentials } from './credentials.js';

describe('자격증명 조회', () => {
  it('환경변수가 없으면 공개 데모 값을 쓴다', () => {
    expect(lookupCredentials('demo01', {})).toMatchObject({ loginId: 'demo01', password: 'demo-pass-01' });
  });

  it('환경변수가 필드별로 덮어쓴다', () => {
    const env = { [envKey('demo01', 'PASSWORD')]: 'from-env' };
    expect(lookupCredentials('demo01', env)).toMatchObject({
      password: 'from-env',
      totpSecret: 'LDL3EJLY2NS3RYE6K77KL6PRFKQ4ZK3M',
    });
  });

  it('데모 기본값이 없는 ID는 두 필드가 다 있어야 찾는다', () => {
    // 반쪽 자격증명으로 로그인하면 비밀번호 오류가 쌓여 계정이 잠길 수 있다.
    expect(lookupCredentials('bank-user', { [envKey('bank-user', 'PASSWORD')]: 'x' })).toBeUndefined();
    expect(
      lookupCredentials('bank-user', {
        [envKey('bank-user', 'PASSWORD')]: 'x',
        [envKey('bank-user', 'TOTP_SECRET')]: 'y',
      }),
    ).toEqual({ loginId: 'bank-user', password: 'x', totpSecret: 'y' });
  });

  it('환경변수 이름은 대문자와 밑줄로 만든다', () => {
    expect(envKey('bank-user.1', 'TOTP_SECRET')).toBe('COLLECTOR_BANK_USER_1_TOTP_SECRET');
  });
});
