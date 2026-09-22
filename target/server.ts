/**
 * 대상 서버 진입점. 조립은 `app.ts`가 하고 여기서는 듣기만 한다.
 *
 * 나눠 둔 이유는 테스트다. 테스트는 포트를 열지 않고 `app.inject()`로 요청을
 * 넣는다. 진입점과 조립이 한 파일이면 테스트가 매번 실제 포트를 잡아야 하고,
 * CI에서 병렬로 돌 때 포트가 겹친다.
 */

import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const app = buildApp({ logger: true });

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
