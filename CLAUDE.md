# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Quickstart repository: `docker compose up -d` runs the whole ShopBite stack locally (Shopware + plugin, demo menu, storefront, Mailpit). It is the entry point linked from `/docs/intro` on shopbite.de, so keep it working with zero configuration.

## Development hub

Sessions for any ShopBite work start here. The other `shopbite-de` repos are cloned next to this one (see the README table); work in them is delegated to an agent in that repo with the `delegate` skill (Herdr), verified end to end with this stack and reviewed by a fresh agent with the `self-review` skill.

## Pieces

- `compose.yaml`: database, valkey, `init` (Shopware Deployment Helper), `shopware` (:8000, also publishes :3000), `worker`, `scheduler`, `setup`, `storefront`, `mailpit` (:8025).
- `storefront` uses `network_mode: service:shopware`, so `http://localhost:8000` is Shopware in the browser and during SSR. The storefront's server routes read the public endpoint only, which is why this trick is needed; ports are therefore fixed.
- `setup/setup.py` (stdlib Python, `python:3.14-alpine`): creates the sales channel "ShopBite" (storefront type, because Shopware generates no SEO URLs for headless channels), opening hours 00:00 to 23:59, seeds `setup/menu.json` + `setup/images/<number>.webp`, and writes `/config/storefront.env` (access key, country id, menu category id) that the storefront entrypoint sources. IDs are uuid5 values, so runs are idempotent; it seeds only once so Admin edits survive restarts. Sync calls index synchronously so SEO URLs exist before the storefront starts.
- Footer column must not be named "Speisekarte": its link categories would take the SEO paths `Speisekarte/<Section>/` of the real menu sections.
- `storefront/`: the user's storefront, a Nuxt project extending `@shopbite-de/storefront` (content, colours, logo, address). The prebuilt image `shopbite-storefront` is built from this folder, and `docker compose up -d --build storefront` builds local changes (`pull_policy: missing` + `build`). `pnpm dev` runs on :3001 with `storefront/.env`, which the setup service writes (the sales channel has domains :3000 and :3001). No lockfile committed: local builds take the newest layer 2.x, CI passes the exact resolved release as build arg `STOREFRONT_VERSION`. The contact form is on (`shopBite.feature.contactForm`); setup sets `core.basicInformation.email` to info@example.com so contact and order mails have a sender and recipient. Keep its texts neutral (Musterstadt placeholders), never real restaurant data.
- `shopware/Dockerfile`: builds `shopbite-de/shopware` (named build context `shopware`) with `shopware/filesystem.yaml` replacing the S3 config, so files live on local volumes.
- `.github/workflows/images.yaml`: builds `ghcr.io/shopbite-de/shopbite-shopware` (shopware main) and `ghcr.io/shopbite-de/shopbite-storefront` (`storefront/` folder) for amd64 + arm64 on push, weekly and on demand. Images are pushed as `candidate`, the smoke test runs the whole stack with them, and only then `latest` + `YYYYMMDD` move. A change that breaks the smoke test therefore blocks the release.
- `test/smoke.mjs`: Playwright end-to-end test against the running stack (start page, menu section, pizza with an extra, guest checkout, contact form, both mails in Mailpit). It matches German UI texts and SEO paths (`/Speisekarte/Pizza/`, `/bestellung/kasse`), so update it together with storefront text or menu changes. Env: `STOREFRONT_URL`, `MAILPIT_URL`, `SMOKE_SCREENSHOTS=<dir>`.
- `compose.build.yaml`: builds the Shopware image from the Git repository instead of pulling.

## Verify a change

```bash
docker compose down -v && docker compose up -d && docker compose logs -f setup
```

Then order a pizza as a guest on http://localhost:3000 and check the mail on http://localhost:8025, or run the smoke test against the running stack:

```bash
cd test && npm ci && npx playwright install chromium && npm run smoke
```

Test locally built images with `SHOPWARE_IMAGE` / `STOREFRONT_IMAGE` (see `.env.example`, also `ADMIN_PASSWORD`, `SEED_DEMO_MENU`).
