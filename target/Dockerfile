# 수집 대상 서버(#14). 출발지를 실제로 가르려면 대상 서버가 프록시와 같은 compose 네트워크에 있어야 한다
# (docs/evidence/d3-origin.md 2절 H1). 빌드 문맥은 리포 루트다(docker-compose.yml).
FROM node:24-alpine
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY target ./target
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "target/server.ts"]
