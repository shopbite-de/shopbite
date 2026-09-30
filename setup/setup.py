#!/usr/bin/env python3
"""Prepares a fresh Shopware installation for the ShopBite storefront.

Runs as the `setup` service of compose.yaml after Shopware is up:

1. creates the sales channel "ShopBite" (navigation, footer, payment,
   shipping, the storefront domain) with opening hours for every day
2. seeds the demo menu from menu.json (categories, products, variants, extras,
   images from images/<number>.webp), unless SEED_DEMO_MENU=0
3. writes /config/storefront.env (access key, country, menu category) for the
   storefront container, and storefront/.env for `pnpm dev` on port 3001

Everything is created only once: on later starts the script finds the sales
channel and the menu and only writes the storefront config, so changes made in
the Administration stay.
Standard library only, so it runs on the plain python image.
"""
import itertools
import json
import os
import secrets
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

SHOPWARE_URL = os.environ.get("SHOPWARE_URL", "http://shopware:8000").rstrip("/")
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "shopbite")
STOREFRONT_URL = os.environ.get("STOREFRONT_URL", "http://localhost:3000").rstrip("/")
SEED_DEMO_MENU = os.environ.get("SEED_DEMO_MENU", "1") not in ("0", "false", "no", "")
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.environ.get("STOREFRONT_CONFIG", "/config/storefront.env")
# .env for `pnpm dev` in the storefront folder of this repository (mounted at /storefront)
DEV_ENV_FILE = os.environ.get("STOREFRONT_DEV_ENV", "/storefront/.env")
DEV_URL = os.environ.get("STOREFRONT_DEV_URL", "http://localhost:3001").rstrip("/")

# storefront type, not headless: Shopware only generates SEO URLs (used by the storefront) for this type
STOREFRONT_TYPE_ID = "8a243080f92e4c719546314b577cf82b"
NAMESPACE = uuid.UUID("0b5f0c1e-7a4d-4c3b-9e8f-5d6a7b8c9d0e")


def hid(key):
    """Deterministic Shopware id, so every entity has a stable id across runs."""
    return uuid.uuid5(NAMESPACE, key).hex


SALES_CHANNEL_ID = hid("sales-channel")
NAV_ROOT_ID = hid("category:root")
MENU_ID = hid("category:speisekarte")
FOOTER_ROOT_ID = hid("category:footer")


class Api:
    def __init__(self):
        self.token = None

    def request(self, method, path, body=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(SHOPWARE_URL + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if raw is None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                content = resp.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as err:
            detail = err.read().decode(errors="replace")[:2000]
            raise RuntimeError(f"{method} {path} failed with HTTP {err.code}: {detail}") from None

    def login(self):
        # the shopware container is healthy before this runs, but retry for slow machines
        for attempt in range(30):
            try:
                result = self.request("POST", "/api/oauth/token", {
                    "grant_type": "password",
                    "client_id": "administration",
                    "scopes": "write",
                    "username": ADMIN_USER,
                    "password": ADMIN_PASSWORD,
                })
                self.token = result["access_token"]
                return
            except (RuntimeError, urllib.error.URLError, OSError) as err:
                if attempt == 29:
                    raise
                print(f"waiting for Shopware ({err})")
                time.sleep(5)

    def search(self, entity, criteria):
        return self.request("POST", f"/api/search/{entity}", criteria)["data"]

    def first(self, entity, field, value):
        rows = self.search(entity, {"limit": 1, "filter": [{"type": "equals", "field": field, "value": value}]})
        if not rows:
            raise RuntimeError(f"no {entity} with {field}={value} found")
        return rows[0]["id"]

    def sync(self, operations):
        self.request("POST", "/api/_action/sync", operations, headers={"fail-on-error": "true"})


def access_key():
    alphabet = string.ascii_uppercase + string.digits
    return "SWSC" + "".join(secrets.choice(alphabet) for _ in range(22))


def create_sales_channel(api, ctx):
    categories = [
        {"id": NAV_ROOT_ID, "name": "ShopBite", "type": "page", "active": True, "visible": True},
        {"id": MENU_ID, "parentId": NAV_ROOT_ID, "name": "Speisekarte", "type": "page", "active": True,
         "visible": True, "displayNestedProducts": True, "productAssignmentType": "product",
         "customFields": {"shopbite_category_icon": "i-lucide-utensils"}},
        {"id": hid("category:kontakt"), "parentId": NAV_ROOT_ID, "afterCategoryId": MENU_ID, "name": "Kontakt",
         "type": "link", "linkType": "external", "externalLink": "/kontakt", "active": True, "visible": True},
    ]
    api.sync([{"action": "upsert", "entity": "category", "payload": categories}])

    api.sync([{"action": "upsert", "entity": "sales_channel", "payload": [{
        "id": SALES_CHANNEL_ID,
        "typeId": STOREFRONT_TYPE_ID,
        "name": "ShopBite",
        "accessKey": access_key(),
        "active": True,
        "languageId": ctx["language"],
        "currencyId": ctx["currency"],
        "paymentMethodId": ctx["payment"],
        "shippingMethodId": ctx["shipping"],
        "countryId": ctx["country"],
        "customerGroupId": ctx["customer_group"],
        "navigationCategoryId": NAV_ROOT_ID,
        "languages": [{"id": ctx["language"]}],
        "currencies": [{"id": ctx["currency"]}],
        "paymentMethods": [{"id": ctx["payment"]}],
        "shippingMethods": [{"id": ctx["shipping"]}],
        "countries": [{"id": ctx["country"]}],
        # registration and password recovery links point to the storefront
        "domains": [{"id": hid("domain:" + url), "url": url, "languageId": ctx["language"],
                     "currencyId": ctx["currency"], "snippetSetId": ctx["snippet_set"]} for url in (STOREFRONT_URL, DEV_URL)],
    }]}])

    # names that fit a delivery shop (the defaults are "Nachnahme" and "Standard")
    api.sync([
        {"action": "upsert", "entity": "payment_method", "payload": [{"id": ctx["payment"], "name": "Barzahlung",
                                                                     "description": "Bar bei Lieferung oder Abholung"}]},
        {"action": "upsert", "entity": "shipping_method", "payload": [{"id": ctx["shipping"], "name": "Lieferung"}]},
    ])

    # shop e-mail: sender of all mails and recipient of the contact form (Settings > Basic information)
    api.request("POST", "/api/_action/system-config/batch", {"null": {
        "core.basicInformation.email": "info@example.com",
        "core.basicInformation.shopName": "ShopBite Demo",
    }})

    # open every day around the clock, so ordering works whenever you try it (Sunday is day 7)
    hours = [{"id": hid(f"business-hour:{day}"), "salesChannelId": SALES_CHANNEL_ID, "dayOfWeek": day,
              "openingTime": "00:00", "closingTime": "23:59"} for day in range(1, 8)]
    api.sync([{"action": "upsert", "entity": "shopbite_business_hour", "payload": hours}])
    print("created sales channel ShopBite")


def seed_menu(api, ctx):
    menu = load_menu()
    cat_id = {c["key"]: hid("category:" + c["key"]) for c in menu["categories"]}
    products = menu["products"]
    by_number = {p["number"]: p for p in products}
    pid = {p["number"]: hid("product:" + p["number"]) for p in products}

    categories, previous = [], None
    for c in menu["categories"]:
        row = {"id": cat_id[c["key"]], "parentId": MENU_ID, "name": c["name"], "type": "page", "active": True,
               "visible": True, "displayNestedProducts": True, "productAssignmentType": "product",
               "customFields": {"shopbite_category_icon": c["icon"]}}
        if previous:
            row["afterCategoryId"] = previous
        previous = row["id"]
        categories.append(row)

    # property groups: ingredients, diet badges and the variant options
    groups = {"Hauptzutaten": sorted({i for p in products for i in p.get("ingredients", [])}),
              "Vegetarisch": ["Ja"], "Vegan": ["Ja"]}
    for p in products:
        for group, options in p.get("variants", {}).items():
            names = groups.setdefault(group, [])
            names.extend(o["name"] for o in options if o["name"] not in names)
    option_id = {}
    property_groups = []
    for position, (group, options) in enumerate(groups.items()):
        property_groups.append({
            "id": hid("pg:" + group), "name": group, "displayType": "text", "sortingType": "position",
            "filterable": group in ("Vegetarisch", "Vegan"), "visibleOnProductDetailPage": True, "position": position,
            "options": [{"id": hid(f"po:{group}:{o}"), "name": o, "position": i} for i, o in enumerate(options)],
        })
        for o in options:
            option_id[(group, o)] = hid(f"po:{group}:{o}")

    def price(gross, rate):
        return [{"currencyId": ctx["currency"], "gross": round(gross, 2), "net": round(gross / (1 + rate / 100), 4), "linked": True}]

    images = {f[:-5]: os.path.join(HERE, "images", f) for f in os.listdir(os.path.join(HERE, "images")) if f.endswith(".webp")}
    media = [{"id": hid("media:" + nr), "mediaFolderId": ctx["media_folder"]} for nr in images if nr in by_number]

    rows, variants, cross_sellings = [], [], []
    extras = [p["number"] for p in products if "category" not in p]
    for p in products:
        nr, rate = p["number"], p["tax"]
        properties = [{"id": option_id[("Hauptzutaten", i)]} for i in p.get("ingredients", [])]
        if p.get("vegan"):
            properties.append({"id": option_id[("Vegan", "Ja")]})
        elif p.get("vegetarian"):
            properties.append({"id": option_id[("Vegetarisch", "Ja")]})
        is_extra = "category" not in p
        row = {
            "id": pid[nr], "productNumber": ("EXTRA-" if is_extra else "SB-") + nr, "name": p["name"],
            "description": p.get("description", ""), "stock": 999, "active": True,
            "taxId": ctx["tax"][rate], "price": price(p["price"], rate),
            "visibilities": [{"id": hid("visibility:" + nr), "salesChannelId": SALES_CHANNEL_ID, "visibility": 30}],
            "properties": properties,
            "customFields": {"shopbite_receipt_print_type": "label" if is_extra else "number",
                             "shopbite_delivery_time_factor": p.get("deliveryTimeFactor", 1)},
        }
        if not is_extra:
            row["categories"] = [{"id": cat_id[p["category"]]}]
        if nr in images:
            row["media"] = [{"id": hid("product-media:" + nr), "mediaId": hid("media:" + nr), "position": 0}]
            row["coverId"] = hid("product-media:" + nr)
        if p.get("variants"):
            spec = p["variants"]
            row["configuratorSettings"] = [{"id": hid(f"cs:{nr}:{g}:{o['name']}"), "optionId": option_id[(g, o["name"])]}
                                           for g, options in spec.items() for o in options]
            row["variantListingConfig"] = {"displayParent": True}
            for combo in itertools.product(*[[(g, o) for o in options] for g, options in spec.items()]):
                key = "|".join(o["name"] for _, o in combo)
                surcharge = sum(o["surcharge"] for _, o in combo)
                slug = "-".join(o["name"].split()[0].lower() for _, o in combo)
                child = {"id": hid(f"variant:{nr}:{key}"), "parentId": pid[nr], "productNumber": f"SB-{nr}-{slug}",
                         "stock": 999, "active": True, "options": [{"id": option_id[(g, o["name"])]} for g, o in combo]}
                if surcharge:
                    child["price"] = price(p["price"] + surcharge, rate)
                variants.append(child)
        if p.get("crossSelling") == "extras":
            cross_sellings.append({
                "id": hid(f"xs:{nr}:extras"), "productId": pid[nr], "name": "Extras", "type": "productList",
                "active": True, "position": 0, "sortBy": "name", "sortDirection": "ASC", "limit": 24,
                "assignedProducts": [{"id": hid(f"xsp:{nr}:{e}"), "productId": pid[e], "position": i} for i, e in enumerate(extras)],
            })
        rows.append(row)

    footer = [{"id": FOOTER_ROOT_ID, "name": "Footer", "type": "folder", "active": True, "visible": True}]
    columns = [
        # not "Speisekarte": the links would get the SEO paths of the menu sections (Speisekarte/Pizza/)
        ("Beliebt", [(c["name"], "category", c["key"]) for c in menu["categories"][:4]]),
        ("Service", [("Kontakt", "external", "/kontakt"), ("Zahlung und Versand", "external", "/zahlung-und-versand"),
                     ("Mein Konto", "external", "/konto"), ("Merkliste", "external", "/merkliste")]),
        ("Rechtliches", [("Impressum", "external", "/impressum"), ("Datenschutz", "external", "/datenschutz"),
                         ("AGB", "external", "/agb")]),
    ]
    previous_column = None
    for column, links in columns:
        column_id = hid("category:footer:" + column)
        row = {"id": column_id, "parentId": FOOTER_ROOT_ID, "name": column, "type": "folder", "active": True, "visible": True}
        if previous_column:
            row["afterCategoryId"] = previous_column
        previous_column = column_id
        footer.append(row)
        previous_link = None
        for name, kind, target in links:
            link = {"id": hid(f"category:footer:{column}:{name}"), "parentId": column_id, "name": name, "type": "link",
                    "active": True, "visible": True, "linkNewTab": False}
            if kind == "category":
                link.update(linkType="category", internalLink=cat_id[target])
            else:
                link.update(linkType="external", externalLink=target)
            if previous_link:
                link["afterCategoryId"] = previous_link
            previous_link = link["id"]
            footer.append(link)

    api.sync([
        {"action": "upsert", "entity": "category", "payload": categories},
        {"action": "upsert", "entity": "property_group", "payload": property_groups},
        {"action": "upsert", "entity": "media", "payload": media},
        {"action": "upsert", "entity": "product", "payload": rows},
        {"action": "upsert", "entity": "product", "payload": variants},
        {"action": "upsert", "entity": "product_cross_selling", "payload": cross_sellings},
        {"action": "upsert", "entity": "category", "payload": footer},
        {"action": "upsert", "entity": "sales_channel", "payload": [{"id": SALES_CHANNEL_ID, "footerCategoryId": FOOTER_ROOT_ID}]},
    ])

    for nr, path in images.items():
        if nr not in by_number:
            continue
        with open(path, "rb") as f:
            file_name = "shopbite-" + by_number[nr]["name"].lower().replace(" ", "-")
            api.request("POST", f"/api/_action/media/{hid('media:' + nr)}/upload?extension=webp&fileName={urllib.parse.quote(file_name)}",
                        raw=f.read(), headers={"Content-Type": "image/webp"})

    print(f"seeded {len(rows)} products, {len(variants)} variants, {len(categories)} menu sections, {len(media)} images")


def load_menu():
    with open(os.path.join(HERE, "menu.json"), encoding="utf-8") as f:
        return json.load(f)


def first_product_number():
    return load_menu()["products"][0]["number"]


def context(api):
    taxes = {round(t["taxRate"]): t["id"] for t in api.search("tax", {"limit": 50})}
    if 7 not in taxes:
        taxes[7] = hid("tax:7")
        api.sync([{"action": "upsert", "entity": "tax", "payload": [{"id": taxes[7], "name": "7 %", "taxRate": 7}]}])
    folders = api.search("media-default-folder", {"filter": [{"type": "equals", "field": "entity", "value": "product"}],
                                                  "associations": {"folder": {}}})
    return {
        "language": api.first("language", "locale.code", "de-DE"),
        "currency": api.first("currency", "isoCode", "EUR"),
        "snippet_set": api.first("snippet-set", "iso", "de-DE"),
        "country": api.first("country", "iso", "DE"),
        "customer_group": api.search("customer-group", {"limit": 1, "sort": [{"field": "createdAt"}]})[0]["id"],
        "payment": api.first("payment-method", "technicalName", "payment_cashpayment"),
        "shipping": api.first("shipping-method", "technicalName", "shipping_standard"),
        "tax": taxes,
        "media_folder": folders[0]["folder"]["id"],
    }


def main():
    api = Api()
    api.login()
    ctx = context(api)
    if not api.search("sales-channel", {"ids": [SALES_CHANNEL_ID]}):
        create_sales_channel(api, ctx)
    # the first product marks a finished seed, so an interrupted run is completed next time
    if SEED_DEMO_MENU and not api.search("product", {"ids": [hid("product:" + first_product_number())]}):
        seed_menu(api, ctx)
    channel = api.search("sales-channel", {"ids": [SALES_CHANNEL_ID]})[0]

    config = {
        "NUXT_PUBLIC_SHOPWARE_ACCESS_TOKEN": channel["accessKey"],
        "NUXT_PUBLIC_SITE_COUNTRY_ID": channel["countryId"],
        "NUXT_PUBLIC_SHOP_BITE_MENU_CATEGORY_ID": MENU_ID,
    }
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        f.write("".join(f"{k}={v}\n" for k, v in config.items()))
    if os.path.isdir(os.path.dirname(DEV_ENV_FILE)):
        dev = {**config,
               "NUXT_PUBLIC_SHOPWARE_ENDPOINT": "http://localhost:8000/store-api",
               "NUXT_PUBLIC_STORE_URL": DEV_URL,
               "NUXT_PUBLIC_SHOPWARE_DEV_STORE_FRONT_URL": DEV_URL}
        with open(DEV_ENV_FILE, "w") as f:
            f.write("# written by the setup service of compose.yaml, used by `pnpm dev`\n")
            f.write("".join(f"{k}={v}\n" for k, v in dev.items()))
        os.chmod(DEV_ENV_FILE, 0o666)
    print(f"storefront config written, open {STOREFRONT_URL}")


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - one readable line in `docker compose logs setup`
        print(f"setup failed: {err}", file=sys.stderr)
        sys.exit(1)
