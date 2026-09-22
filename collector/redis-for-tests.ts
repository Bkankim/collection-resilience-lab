/**
 * Redis가 필요한 테스트가 쓸 주소. 없으면 undefined를 돌려 그 테스트를 건너뛰게 한다.
 *
 * 로컬에서는 Redis 없이도 `pnpm test`가 돌아야 한다. 대상 서버·클라이언트 테스트는 Redis와
 * 상관이 없다. 그런데 CI에서 같은 규칙으로 건너뛰면, 워크플로의 Redis 설정이 빠졌을 때
 * 큐 테스트가 전부 조용히 사라지고 초록불이 뜬다. 그래서 `CI`가 있으면 건너뛰지 않고 던진다.
 */
export function redisUrlForTests(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.REDIS_URL;
  if (url !== undefined && url.trim() !== '') return url;
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') {
    throw new Error('CI인데 REDIS_URL이 없다. 워크플로의 services.redis와 env.REDIS_URL을 확인할 것');
  }
  return undefined;
}
