# Builds your storefront, used by compose.custom.yaml
FROM node:24-alpine AS build

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./
RUN pnpm install

COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/.output /app/.output
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
