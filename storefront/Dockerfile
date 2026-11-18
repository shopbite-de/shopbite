# Builds your storefront: docker compose up -d --build storefront, and the published image (CI)
FROM node:26-alpine AS build

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
WORKDIR /app
# Node 26 ships no corepack; keep in sync with packageManager in package.json
RUN npm install -g pnpm@10.34.9

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
# CI pins the exact storefront release it tests (.github/workflows/images.yaml); locally the newest 2.x
ARG STOREFRONT_VERSION=
RUN if [ -n "$STOREFRONT_VERSION" ]; then pnpm add "@shopbite-de/storefront@$STOREFRONT_VERSION"; else pnpm install; fi

COPY . .
RUN pnpm build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/.output /app/.output
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
