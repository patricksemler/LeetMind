# apps/api — Fastify HTTP + SSE API.
# Node/pnpm workspace-aware install; run via tsx for now (no compiled build step in dev images).
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /repo

# Install deps first for layer caching. Copy the whole workspace manifest set; pnpm needs every
# package.json to resolve the workspace graph even though we only run one app from this image.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile || pnpm install

WORKDIR /repo/apps/api

EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
