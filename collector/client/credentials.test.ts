import { describe, expect, it } from 'vitest';

import { assertTotpSecret, envKey, lookupCredentials } from './credentials.js';

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
        [envKey('bank-user', 'TOTP_SECRET')]: 'A4DQOBYHA4DQOBYHA4DQOBYHA4',
      }),
    ).toEqual({ loginId: 'bank-user', password: 'x', totpSecret: 'A4DQOBYHA4DQOBYHA4DQOBYHA4' });
  });

  it('환경변수 이름은 대문자와 밑줄로 만든다', () => {
    expect(envKey('bank-user.1', 'TOTP_SECRET')).toBe('COLLECTOR_BANK_USER_1_TOTP_SECRET');
  });

  it('빈 값이나 공백만 있는 환경변수는 설정하지 않은 것으로 본다', () => {
    // 빈 문자열로 덮으면 작업 다섯 건 만에 계정이 잠긴다.
    for (const value of ['', '   ']) {
      const env = { [envKey('demo01', 'PASSWORD')]: value, [envKey('demo01', 'TOTP_SECRET')]: value };
      expect(lookupCredentials('demo01', env)).toMatchObject({
        password: 'demo-pass-01',
        totpSecret: 'LDL3EJLY2NS3RYE6K77KL6PRFKQ4ZK3M',
      });
    }
    expect(
      lookupCredentials('bank-user', { [envKey('bank-user', 'PASSWORD')]: '', [envKey('bank-user', 'TOTP_SECRET')]: 'A4DQOBYHA4DQOBYHA4DQOBYHA4' }),
    ).toBeUndefined();
  });

  it('TOTP 공유키 형식이 틀리면 설정 오류로 던지고, 메시지에 공유키를 싣지 않는다', () => {
    const secret = 'SHORTSECRET';
    const lookup = () => lookupCredentials('demo01', { [envKey('demo01', 'TOTP_SECRET')]: secret });
    expect(lookup).toThrow(RangeError);
    expect(lookup).toThrow(/demo01의 TOTP 공유키 형식이 틀렸다/);
    try {
      lookup();
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('otplib이 받는 형식은 통과시킨다: 16바이트 이상, 소문자, 패딩 유무', () => {
    // 16바이트를 base32로 쓰면 26자, 패딩까지 32자다. 15바이트는 otplib이 거부한다.
    for (const secret of ['A4DQOBYHA4DQOBYHA4DQOBYHA4', 'A4DQOBYHA4DQOBYHA4DQOBYHA4======', 'a4dqobyha4dqobyha4dqobyha4']) {
      expect(() => assertTotpSecret('x', secret), secret).not.toThrow();
    }
    expect(() => assertTotpSecret('x', 'A4DQOBYHA4DQOBYHA4DQOBYH')).toThrow(/16 bytes/);
  });
});
