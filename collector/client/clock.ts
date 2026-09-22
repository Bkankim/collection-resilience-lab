/**
 * 수집 클라이언트가 시각을 읽는 통로.
 *
 * 대상 서버의 `target/clock.ts`와 같은 모양이지만 import하지 않는다. 수집기는 대상
 * 서버를 모르는 외부 클라이언트여야 측정이 정직하다. 쿠키 만료와 TOTP 코드가 전부
 * 시각에 달려 있어서, 주입할 수 있어야 테스트가 시계를 밀어 만료를 재현한다.
 */

/** 현재 시각을 epoch 밀리초로 돌려준다. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
