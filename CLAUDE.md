# CLAUDE.md

Quickstart repository: `docker compose up -d` runs the whole ShopBite stack locally (Shopware + plugin, demo menu, storefront, Mailpit). It is the entry point linked from `/docs/intro` on shopbite.de, so keep it working with zero configuration.

## Pieces

- `compose.yaml`: database, valkey, `init` (Shopware Deployment Helper), `shopware` (:8000, also publishes :3000), `worker`, `scheduler`, `setup`, `storefront`, `mailpit` (:8025).
- `storefront` uses `network_mode: service:shopware`, so `http://localhost:8000` is Shopware in the browser and during SSR. The storefront's server routes read the public endpoint only, which is why this trick is needed; ports are therefore fixed.
- `setup/setup.py` (stdlib Python, `python:3.13-alpine`): creates the sales channel "ShopBite" (storefront type, because Shopware generates no SEO URLs for headless channels), opening hours 00:00 to 23:59, seeds `setup/menu.json` + `setup/images/<number>.webp`, and writes `/config/storefront.env` (access key, country id, menu category id) that the storefront entrypoint sources. IDs are uuid5 values, so runs are idempotent; it seeds only once so Admin edits survive restarts. Sync calls index synchronously so SEO URLs exist before the storefront starts.
- Footer column must not be named "Speisekarte": its link categories would take the SEO paths `Speisekarte/<Section>/` of the real menu sections.
- `storefront/`: the user's storefront, a Nuxt project extending `@shopbite-de/storefront` (content, colours, logo, address). The prebuilt image `shopbite-storefront` is built from this folder, and `docker compose up -d --build storefront` builds local changes (`pull_policy: missing` + `build`). `pnpm dev` runs on :3001 with `storefront/.env`, which the setup service writes (the sales channel has domains :3000 and :3001). No lockfile committed, so the weekly image build takes the newest layer 1.x. Keep its texts neutral (Musterstadt placeholders), never La Fattoria data.
- `shopware/Dockerfile`: builds `shopbite-de/shopware` (named build context `shopware`) with `shopware/filesystem.yaml` replacing the S3 config, so files live on local volumes.
- `.github/workflows/images.yaml`: builds `ghcr.io/shopbite-de/shopbite-shopware` (shopware main) and `ghcr.io/shopbite-de/shopbite-storefront` (`storefront/` folder) for amd64 + arm64 on push, weekly and on demand. Tags `latest` and `YYYYMMDD`.
- `compose.build.yaml`: builds the Shopware image from the Git repository instead of pulling.

## Verify a change

```bash
docker compose down -v && docker compose up -d && docker compose logs -f setup
```

Then order a pizza as a guest on http://localhost:3000 and check the mail on http://localhost:8025.
