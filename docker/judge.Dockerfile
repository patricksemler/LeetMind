# apps/judge — judge coordinator + sandbox workers.
# Needs the docker CLI because it shells out to `docker run` to launch sibling sandbox containers
# against the host daemon (via the mounted /var/run/docker.sock — see docker-compose.yml).
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate \
    && apk add --no-cache docker-cli

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile || pnpm install

WORKDIR /repo/apps/judge

CMD ["pnpm", "exec", "tsx", "src/index.ts"]
