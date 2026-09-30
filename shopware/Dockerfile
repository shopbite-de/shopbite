# syntax=docker/dockerfile:1
#
# Shopware 6 + ShopBite plugin for the quickstart stack (compose.yaml).
#
# Built from the shopbite-de/shopware repository, which is passed in as the named
# build context "shopware". The only difference to the production image of that
# repository: files are stored on local volumes instead of an S3 bucket.
#
#   docker build --build-context shopware=https://github.com/shopbite-de/shopware.git#main \
#     -t ghcr.io/shopbite-de/shopbite-shopware shopware/

ARG PHP_VERSION=8.4

FROM ghcr.io/shopware/docker-base:${PHP_VERSION}-frankenphp AS base-image
FROM ghcr.io/shopware/shopware-cli:latest-php-${PHP_VERSION} AS build

COPY --from=shopware . /src
WORKDIR /src

# The named context has no .dockerignore: drop what the production build excludes
RUN rm -rf .git .github .idea .claude docs scripts docker compose*.yaml Makefile CLAUDE.md renovate.json \
      vendor var files node_modules public/bundles \
      install.lock .env.local .env.dev auth.json

# Local file storage instead of S3 (media, thumbnails, theme, sitemap, private files)
COPY filesystem.yaml config/packages/prod/filesystem.yaml

RUN --mount=type=cache,target=/root/.composer \
    --mount=type=cache,target=/root/.npm \
    /usr/local/bin/entrypoint.sh shopware-cli project ci /src \
 && mkdir -p public/media public/thumbnail public/theme public/sitemap files var

FROM base-image AS final

ENV SHOPWARE_DISABLE_UPDATE_CHECK=1

COPY --from=shopware --link docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build --chown=82 --link /src /var/www/html
