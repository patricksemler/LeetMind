# apps/web — React + Vite + Monaco + Tailwind.
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --frozen-lockfile || pnpm install

WORKDIR /repo/apps/web

EXPOSE 5173

CMD ["pnpm", "exec", "vite", "--host", "0.0.0.0", "--port", "5173"]
