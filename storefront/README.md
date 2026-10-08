# Your storefront

This folder is your shop's storefront. It extends the [ShopBite storefront](https://github.com/shopbite-de/storefront) as a Nuxt layer, so you only keep what you change:

| What | Where |
| --- | --- |
| Start page texts, buttons, sections | `content/index.yml` |
| Imprint, privacy policy, terms, payment and delivery | `content/*.md` |
| Style preset and colours | `shopBite` in `nuxt.config.ts` |
| Logo | `public/light/Logo.png` (light presets), `public/dark/Logo.png` (`grill`) |
| Shop name, address, phone | `nuxt.config.ts` |
| Components | a file with the same name in `app/components/` replaces the layer's |

## Edit with live reload

You need [Node.js 24](https://nodejs.org) and [pnpm](https://pnpm.io/installation). Start the stack first (`docker compose up -d` in the parent folder). Its setup service writes `.env` here with the access key of your local Shopware.

```bash
pnpm install
pnpm dev        # http://localhost:3001
```

Every saved change shows up in the browser right away.

## Put your changes into the stack

```bash
docker compose up -d --build storefront   # in the parent folder
```

http://localhost:3000 then serves your version.

## Going live

This folder is a regular Nuxt project: copy it into its own repository, point `NUXT_PUBLIC_SHOPWARE_ENDPOINT` and `NUXT_PUBLIC_SHOPWARE_ACCESS_TOKEN` at your Shopware and deploy it with the `Dockerfile`. See the [storefront docs](https://shopbite.de/docs/storefront/first-steps).
