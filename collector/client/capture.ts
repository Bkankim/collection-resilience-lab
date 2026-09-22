/**
 * 원본 응답을 사람이 볼 곳(DLQ, 실패 로그)에 남기기 전에 비밀을 가린다.
 *
 * UNKNOWN·PARSE_FAILED는 원본을 남기는 것이 대응이다(`FIRST_REMEDY`의 CAPTURE_RAW).
 * 그런데 원본 헤더에는 막 발급된 세션 식별자(`set-cookie`)가 실릴 수 있다. 인증 2xx
 * 본문이 예상과 달라 UNKNOWN이 되는 경우가 그렇다. 그대로 저장하면 살아 있는 세션
 * 토큰이 DLQ에 남고, DLQ는 사람이 들여다보라고 만든 곳이다.
 *
 * **계약: 저장 직전 한 곳에서 부른다.** 실패를 만드는 자리마다 가리면 새 자리를 만들
 * 때 빠뜨린다. 저장하는 자리는 워커(#13) 하나뿐이므로 거기서 부르는 것이 빠뜨리지
 * 않는 방법이다. 워커가 아직 없어서, 지금은 세션 층이 원본을 밖으로 돌려주는 경계
 * (`session.ts`의 공개 메서드)에서 부른다. 여러 번 불러도 결과가 같으므로 워커가 다시
 * 불러도 된다.
 *
 * 가리는 것은 헤더 값뿐이다. 본문은 그대로 둔다. 구조가 바뀐 응답을 사람이 고치려면
 * 본문이 있어야 하고, 대상 서버의 본문에는 식별자가 실리지 않는다. 본문에 비밀이 실리는
 * 대상을 붙이면 여기를 다시 봐야 한다.
 */

import type { ClassifyInput, Failure, Headers } from './classify.js';

export const REDACTED = '[REDACTED]';

/** 값을 가릴 헤더. 이름은 소문자로 비교한다. */
const SECRET_HEADERS = new Set(['set-cookie', 'cookie', 'authorization']);

export function redactForCapture(raw: ClassifyInput): ClassifyInput {
  if ('network' in raw) return raw;
  const headers: Headers = {};
  for (const [key, value] of Object.entries(raw.headers)) {
    const name = key.toLowerCase();
    headers[key] = SECRET_HEADERS.has(name) && value !== undefined ? redactValue(name, value) : value;
  }
  return { ...raw, headers };
}

/** 실패 객체에 원본이 있으면 가린 원본으로 바꾼다. 원본이 없는 종류는 그대로 돌려준다. */
export function redactFailure<T extends Failure>(failure: T): T {
  if (!('raw' in failure)) return failure;
  return { ...failure, raw: redactForCapture(failure.raw) };
}

function redactValue(name: string, value: string | string[]): string | string[] {
  if (Array.isArray(value)) return value.map((v) => redactOne(name, v));
  return redactOne(name, value);
}

/**
 * 진단에 쓸 모양은 남긴다. 쿠키는 이름과 속성(`Path`, `Max-Age`)을, 인증 헤더는
 * 방식(`Bearer`)을 남긴다. 세션이 왜 끊겼는지 볼 때 "어떤 쿠키가 몇 초짜리로
 * 왔는가"는 필요하고, 값은 필요 없다.
 */
function redactOne(name: string, value: string): string {
  if (name === 'set-cookie') {
    const [pair = '', ...attrs] = value.split(';');
    return [redactPair(pair), ...attrs].join(';');
  }
  if (name === 'cookie') return value.split(';').map(redactPair).join(';');
  const space = value.indexOf(' ');
  return space === -1 ? REDACTED : `${value.slice(0, space)} ${REDACTED}`;
}

function redactPair(pair: string): string {
  const eq = pair.indexOf('=');
  return eq === -1 ? REDACTED : `${pair.slice(0, eq)}=${REDACTED}`;
}
