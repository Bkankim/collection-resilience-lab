/**
 * 수집 요청 API 진입점. 조립은 `app.ts`가 하고 여기서는 연결을 만들고 듣기만 한다.
 * 나눈 이유는 `target/server.ts`와 같다. 테스트가 포트를 잡지 않고 `inject()`로 넣는다.
 *
 * 기본 포트 8090은 대상 서버(8080)와 겹치지 않게 골랐다. 둘을 한 머신에서 함께 띄운다.
 */

import { Queue } from 'bullmq';

import { COLLECTION_QUEUE, createRedis } from '../queue.js';
import type { CollectionJobData } from '../queue.js';
import { buildApi } from './app.js';

const port = Number(process.env.PORT ?? 8090);
const host = process.env.HOST ?? '0.0.0.0';

const redis = createRedis('producer');
const queue = new Queue<CollectionJobData>(COLLECTION_QUEUE, { connection: redis });
const app = buildApi({ queue, redis, logger: true });

// 종료 신호에서 연결을 닫는다. 닫지 않으면 ioredis가 이벤트 루프를 붙잡아 프로세스가
// 남고, 포트는 풀렸는데 Redis 연결은 남은 상태가 된다.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await queue.close();
      redis.disconnect();
      process.exit(0);
    })();
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
