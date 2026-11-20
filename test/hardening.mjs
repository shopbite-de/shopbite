// End-to-end checks of the hardening in the ShopBite plugin and the storefront, against the
// running quickstart stack (docker compose up -d):
//
//   plugin      dish line items are built by the server, the ordering window is enforced in
//               the cart, Admin API users bound to a branch see only that branch
//   storefront  security headers, generic errors of the address autocomplete, validated
//               listing parameters, one-time secrets leave the address bar
//   lead times  delivery and pickup with their own lead time (shipping methods "Lieferung" and
//               "Abholung" of setup/setup.py): config and settings routes, ordering window per
//               method, wording, earliest time and order comment in the checkout
//
//   docker compose -f compose.yaml -f test/compose.hardening.yaml up -d --no-deps storefront
//   cd test && npm ci && npx playwright install chromium
//   HARDENING_GEOAPIFY_KEY=hardening-dummy-key npm run hardening
//
// Without the overlay (no Geoapify key) the autocomplete check only verifies that nothing leaks.
//
// Every check prints ok, FAIL or skip; the script exits non-zero when one failed. The plugin
// checks run only when the installed plugin is newer than PLUGIN_WITHOUT (the last release
// without these changes), the storefront checks only when STOREFRONT_LAYER_VERSION (the
// @shopbite-de/storefront release of the image, CI passes it) is unset or newer than
// STOREFRONT_WITHOUT; the lead time checks likewise against PLUGIN_WITHOUT_LEAD_TIMES and
// STOREFRONT_WITHOUT_LEAD_TIMES. HARDENING_FORCE=1 runs everything, e.g. to see the checks fail on
// old images.
//
// Settings changed for a check (ordering pause, holiday, opening hours, a lead time, a staff
// user) are restored in finally blocks.
//
// Env: STOREFRONT_URL, SHOPWARE_URL, ADMIN_USER, ADMIN_PASSWORD, STOREFRONT_LAYER_VERSION,
// HARDENING_GEOAPIFY_KEY (the dummy key the stack was started with, see compose.hardening.yaml),
// HARDENING_FORCE, SMOKE_SCREENSHOTS=<dir> (screenshot of a failed browser check).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const STOREFRONT = process.env.STOREFRONT_URL ?? "http://localhost:3000";
const SHOPWARE = process.env.SHOPWARE_URL ?? "http://localhost:8000";
const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "shopbite";
const GEOAPIFY_KEY = process.env.HARDENING_GEOAPIFY_KEY ?? "";
const FORCE = process.env.HARDENING_FORCE === "1";
const SHOTS = process.env.SMOKE_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// Last releases without the changes under test; newer versions (and dev builds) contain them.
const PLUGIN_WITHOUT = "1.10.1";
const STOREFRONT_WITHOUT = "2.4.0";
// lead time per shipping method (shopbite#6)
const PLUGIN_WITHOUT_LEAD_TIMES = "1.11.0";
const STOREFRONT_WITHOUT_LEAD_TIMES = "2.5.0";

// Ids of the quickstart setup (setup/setup.py) and the plugin (StaffRoleInstaller)
const SHOPBITE_CHANNEL_NAME = "ShopBite";
const PERSONAL_ROLE_ID = "493f47fa65684ad8829c852f523fe45c";
const BRANCH_FIELD = "shopbite_sales_channel_ids";
const ORDERING_OPEN = "ShopBitePlugin.config.isCheckoutEnabled";
// shipping methods of setup/setup.py with fulfillment and lead time
const DELIVERY = { technicalName: "shopbite_delivery", name: "Lieferung", fulfillment: "delivery", minutes: 30, wording: "Wunschlieferzeit" };
const PICKUP = { technicalName: "shopbite_pickup", name: "Abholung", fulfillment: "pickup", minutes: 15, wording: "Wunschabholzeit" };
const DEFAULT_TIME_ZONE = "Europe/Berlin"; // the plugin's, when the sales channel has none

// Demo menu (setup/menu.json): a pizza with sizes, a main ingredient and an extra
const DISH = "Pizza Margherita";
const INGREDIENT = "Käse";
const EXTRA = "Extra Salami";

let failed = 0;
let browser;

async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    if (note?.skip) console.log(`skip ${name}: ${note.skip}`);
    else console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const json = (value) => JSON.stringify(value);

/** True when `version` is newer than `than` (x.y.z); versions that are no release count as newer. */
function newer(version, than) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "")?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(than);
  if (!a) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// --- Admin API --------------------------------------------------------------------------

async function token(username, password, scopes = "write") {
  const response = await fetch(`${SHOPWARE}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: json({ grant_type: "password", client_id: "administration", scope: scopes, username, password }),
  });
  const body = await response.json();
  expect(response.ok, `login of ${username} failed: HTTP ${response.status} ${json(body)}`);
  return body.access_token;
}

function adminApi(bearer) {
  const request = async (method, path, body) => {
    const response = await fetch(`${SHOPWARE}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : json(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, ok: response.ok, data };
  };
  const must = async (method, path, body) => {
    const result = await request(method, path, body);
    expect(result.ok, `${method} ${path}: HTTP ${result.status} ${json(result.data).slice(0, 500)}`);
    return result.data;
  };
  return {
    request,
    must,
    search: async (entity, criteria) => (await must("POST", `/search/${entity}`, criteria)).data,
  };
}

const admin = adminApi(await token(ADMIN_USER, ADMIN_PASSWORD));

const [channel] = await admin.search("sales-channel", {
  filter: [{ type: "equals", field: "name", value: SHOPBITE_CHANNEL_NAME }],
  associations: { domains: {} },
});
expect(channel, `no sales channel "${SHOPBITE_CHANNEL_NAME}", did the setup service run?`);

const [plugin] = await admin.search("plugin", { filter: [{ type: "equals", field: "name", value: "ShopBitePlugin" }] });
const pluginVersion = plugin?.version ?? "missing";
const storefrontVersion = process.env.STOREFRONT_LAYER_VERSION || "";
const pluginHas = (without) => FORCE || newer(pluginVersion, without);
const storefrontHas = (without) => FORCE || !storefrontVersion || newer(storefrontVersion, without);
console.log(`ShopBite plugin ${pluginVersion}, storefront ${storefrontVersion || "unknown"}`);

/** Runs the check when plugin and storefront are newer than the given releases, else skips it. */
function gatedCheck(name, { plugin, storefront }, fn) {
  if (plugin && !pluginHas(plugin)) {
    return check(name, () => ({ skip: `plugin ${pluginVersion} is not newer than ${plugin}` }));
  }
  if (storefront && !storefrontHas(storefront)) {
    return check(name, () => ({ skip: `storefront ${storefrontVersion} is not newer than ${storefront}` }));
  }
  return check(name, fn);
}
const pluginCheck = (name, fn) => gatedCheck(name, { plugin: PLUGIN_WITHOUT }, fn);
const storefrontCheck = (name, fn) => gatedCheck(name, { storefront: STOREFRONT_WITHOUT }, fn);
const leadTimeCheck = (name, fn) => gatedCheck(name, { plugin: PLUGIN_WITHOUT_LEAD_TIMES }, fn);
const leadTimeStorefrontCheck = (name, fn) =>
  gatedCheck(name, { plugin: PLUGIN_WITHOUT_LEAD_TIMES, storefront: STOREFRONT_WITHOUT_LEAD_TIMES }, fn);

/** The dish of the demo menu: first size variant, its number, the extra and the label the server builds. */
async function demoDish() {
  const [parent] = await admin.search("product", {
    filter: [
      { type: "equals", field: "name", value: DISH },
      { type: "equals", field: "parentId", value: null },
    ],
  });
  expect(parent, `no product "${DISH}" (demo menu not seeded?)`);
  const [variant] = await admin.search("product", {
    filter: [{ type: "equals", field: "parentId", value: parent.id }],
    sort: [{ field: "productNumber" }],
    limit: 1,
  });
  const [extra] = await admin.search("product", { filter: [{ type: "equals", field: "name", value: EXTRA }] });
  expect(extra, `no product "${EXTRA}"`);
  const main = variant ?? parent;
  const name = main.translated?.name ?? main.name ?? parent.translated?.name ?? parent.name;
  return { main, extra, label: `${name} +${extra.translated?.name ?? extra.name} -${INGREDIENT}` };
}

// --- Store API --------------------------------------------------------------------------

/** A fresh Store API session of the ShopBite sales channel. */
function storeSession() {
  let contextToken = randomUUID().replaceAll("-", "");
  const request = async (method, path, body) => {
    const response = await fetch(`${SHOPWARE}/store-api${path}`, {
      method,
      headers: {
        "sw-access-key": channel.accessKey,
        "sw-context-token": contextToken,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : json(body),
    });
    contextToken = response.headers.get("sw-context-token") ?? contextToken;
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, ok: response.ok, data };
  };
  const must = async (method, path, body) => {
    const result = await request(method, path, body);
    expect(result.ok, `${method} /store-api${path}: HTTP ${result.status} ${json(result.data).slice(0, 500)}`);
    return result.data;
  };
  return {
    request,
    must,
    async registerGuest(email) {
      const salutations = await must("POST", "/salutation", {});
      const salutation =
        salutations.elements.find((s) => s.salutationKey === "not_specified") ?? salutations.elements[0];
      const storefrontUrl = channel.domains.find((d) => d.url === STOREFRONT)?.url ?? channel.domains[0]?.url;
      await must("POST", "/account/register", {
        guest: true,
        salutationId: salutation?.id,
        firstName: "Max",
        lastName: "Muster",
        email,
        acceptedDataProtection: true,
        storefrontUrl,
        billingAddress: {
          street: "Musterstraße 1",
          zipcode: "12345",
          city: "Musterstadt",
          countryId: channel.countryId,
          phoneNumber: "0123456789",
        },
      });
    },
  };
}

/** A guest session with one simple dish in the cart, ready to order. */
async function guestCart() {
  const [product] = await admin.search("product", {
    filter: [
      { type: "equals", field: "childCount", value: 0 },
      { type: "equals", field: "parentId", value: null },
      { type: "equals", field: "active", value: true },
      { type: "equals", field: "visibilities.salesChannelId", value: channel.id },
    ],
    limit: 1,
  });
  expect(product, "no product without variants in the ShopBite sales channel");
  const store = storeSession();
  await store.registerGuest(`hardening-${Date.now()}@example.com`);
  await store.must("POST", "/checkout/cart/line-item", {
    items: [{ id: product.id, referencedId: product.id, type: "product", quantity: 1 }],
  });
  return store;
}

/** Errors of the current cart, by key. */
async function cartErrors(store) {
  const cart = await store.must("GET", "/checkout/cart");
  return Object.values(cart.errors ?? {}).map((e) => e.messageKey ?? e.key ?? e.id);
}

/** Placing the order fails, and the cart names `key` as the reason. */
async function expectOrderBlocked(store, key) {
  const errors = await cartErrors(store);
  expect(errors.includes(key), `cart errors ${json(errors)} do not contain ${key}`);
  const order = await store.request("POST", "/checkout/order", {});
  expect(!order.ok, `order was placed (HTTP ${order.status}, ${order.data?.orderNumber ?? ""})`);
}

// --- Browser -------------------------------------------------------------------------------

/** Fills the guest form of the one-page checkout, saves it and waits for the order button. */
async function saveGuestDetails(page, email) {
  for (const [label, value] of [
    ["Vorname", "Max"],
    ["Nachname", "Muster"],
    ["E-Mail", email],
    ["Straße und Hausnummer", "Musterstraße 1"],
    ["PLZ", "12345"],
    ["Ort", "Musterstadt"],
    ["Telefon", "0123456789"],
  ]) {
    await page.getByLabel(label, { exact: true }).first().fill(value);
  }
  await page.getByText("Ich habe die Datenschutzerklärung").click();
  await page.getByRole("button", { name: "Angaben speichern", exact: true }).click();
  await page.getByRole("button", { name: "Zahlungspflichtig bestellen", exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Zahlungspflichtig bestellen" && !b.disabled,
    ),
  );
}

/** Waits until the element's attribute has the value. */
async function expectAttribute(locator, attribute, value) {
  await locator.page().waitForFunction(
    ([element, a, v]) => element?.getAttribute(a) === v,
    [await locator.elementHandle(), attribute, value],
    { timeout: 10_000 },
  ).catch(async () => {
    throw new Error(`${attribute} of ${locator} is ${json(await locator.getAttribute(attribute))}, expected ${json(value)}`);
  });
}

// --- Plugin: dish line items -------------------------------------------------------------

await pluginCheck("dish from the storefront: server label and removed ingredient in the order", async () => {
  const dish = await demoDish();
  const email = `hardening-ui-${Date.now()}@example.com`;
  browser ??= await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(`${STOREFRONT}/Speisekarte/Pizza/`, { waitUntil: "networkidle" });
    await page.getByText(DISH).first().click();
    await page.getByRole("button", { name: INGREDIENT, exact: true }).click();
    await page.getByText(EXTRA).click();
    await page.getByRole("button", { name: /In den Warenkorb/ }).click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${STOREFRONT}/bestellung/kasse`, { waitUntil: "networkidle" });
    await page.getByText(dish.label).first().waitFor();

    // quantity changed in the cart: an update of the existing dish line item
    await page.getByRole("button", { name: `${dish.label}, eine mehr` }).first().click();
    await page.getByRole("group", { name: `Menge ${dish.label}` }).first().getByText("2", { exact: true }).waitFor();
    await page.waitForLoadState("networkidle");

    await saveGuestDetails(page, email);
    await page.getByRole("button", { name: "Zahlungspflichtig bestellen", exact: true }).click();
    await page.waitForURL(/\/erfolg/);
  } catch (error) {
    await page.screenshot({ path: `${SHOTS ?? "."}/hardening-failed.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }

  const [order] = await admin.search("order", {
    filter: [{ type: "equals", field: "orderCustomer.email", value: email }],
    associations: { lineItems: {} },
  });
  expect(order, `no order of ${email}`);
  const item = order.lineItems.find((i) => i.type === "container");
  expect(item, `no dish line item in order ${order.orderNumber}: ${json(order.lineItems.map((i) => i.label))}`);
  expect(item.label === dish.label, `label ${json(item.label)}, expected ${json(dish.label)}`);
  expect(item.quantity === 2, `quantity ${item.quantity}, expected 2`);
  expect(json(item.payload?.without) === json([INGREDIENT]), `payload.without ${json(item.payload?.without)}`);
  // the size the customer kept (the default one): the dish's product child
  const main = order.lineItems.find(
    (i) => i.parentId === item.id && i.type === "product" && i.referencedId !== dish.extra.id,
  );
  const [product] = main ? await admin.search("product", { ids: [main.referencedId] }) : [];
  expect(product, `no product child in the dish: ${json(order.lineItems.map((i) => [i.label, i.parentId]))}`);
  expect(
    item.payload?.productNumber === product.productNumber,
    `payload.productNumber ${json(item.payload?.productNumber)}, expected ${product.productNumber}`,
  );
});

await pluginCheck("forged dish label and product number are replaced by the server", async () => {
  const dish = await demoDish();
  const store = storeSession();
  await store.registerGuest(`hardening-forged-${Date.now()}@example.com`);
  const id = randomUUID().replaceAll("-", "");
  await store.must("POST", "/checkout/cart/line-item", {
    items: [
      {
        id,
        type: "container",
        quantity: 1,
        label: `Gratis-Pizza -${INGREDIENT}`,
        payload: { productNumber: "FORGED-1", without: [INGREDIENT, "Blattgold"], price: 0 },
        children: [
          { id: dish.main.id, referencedId: dish.main.id, type: "product", quantity: 1 },
          { id: dish.extra.id, referencedId: dish.extra.id, type: "product", quantity: 5 },
        ],
      },
    ],
  });

  const order = await store.must("POST", "/checkout/order", {});
  const [stored] = await admin.search("order", {
    ids: [order.id],
    associations: { lineItems: {} },
  });
  const item = stored.lineItems.find((i) => i.type === "container");
  expect(item, `no dish line item in order ${stored.orderNumber}`);
  expect(item.label === dish.label, `label ${json(item.label)}, expected ${json(dish.label)}`);
  expect(
    item.payload?.productNumber === dish.main.productNumber,
    `payload.productNumber ${json(item.payload?.productNumber)}, expected ${dish.main.productNumber}`,
  );
  expect(json(item.payload?.without) === json([INGREDIENT]), `payload.without ${json(item.payload?.without)}`);
  expect(!("price" in (item.payload ?? {})), `payload keeps the request's keys: ${json(item.payload)}`);
  const extra = stored.lineItems.find((i) => i.parentId === item.id && i.referencedId === dish.extra.id);
  expect(extra?.quantity === 1, `extra quantity ${extra?.quantity}, expected 1 (once per dish)`);
});

// --- Plugin: ordering window -------------------------------------------------------------

await pluginCheck("ordering paused for the sales channel blocks the order", async () => {
  const store = await guestCart();
  const config = await admin.must(
    "GET",
    `/_action/system-config?domain=ShopBitePlugin.config&salesChannelId=${channel.id}`,
  );
  const original = config?.[ORDERING_OPEN] ?? null;
  try {
    await admin.must("POST", "/_action/system-config/batch", { [channel.id]: { [ORDERING_OPEN]: false } });
    await expectOrderBlocked(store, "shopbite-ordering-paused");
  } finally {
    await admin.must("POST", "/_action/system-config/batch", { [channel.id]: { [ORDERING_OPEN]: original } });
  }
});

await pluginCheck("holiday today blocks the order", async () => {
  const store = await guestCart();
  const id = randomUUID().replaceAll("-", "");
  try {
    // a few hours around now: today in any time zone of the shop
    await admin.must("POST", "/shopbite-holiday", {
      id,
      salesChannelId: channel.id,
      start: new Date(Date.now() - 3_600_000).toISOString(),
      end: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await expectOrderBlocked(store, "shopbite-ordering-holiday");
  } finally {
    await admin.request("DELETE", `/shopbite-holiday/${id}`);
  }
});

/** Runs `fn` with every day of the ShopBite channel open from 00:00 to `closingTime`, then restores the hours. */
async function withClosingTime(closingTime, fn) {
  const original = await admin.search("shopbite-business-hour", {
    filter: [{ type: "equals", field: "salesChannelId", value: channel.id }],
  });
  const fields = ({ id, salesChannelId, dayOfWeek, openingTime, closingTime }) => ({
    id,
    salesChannelId,
    dayOfWeek,
    openingTime,
    closingTime,
  });
  try {
    const changed = original.map((hour) => ({ ...fields(hour), openingTime: "00:00", closingTime }));
    await admin.must("POST", "/_action/sync", [
      { action: "upsert", entity: "shopbite_business_hour", payload: changed },
    ]);
    return await fn();
  } finally {
    await admin.must("POST", "/_action/sync", [
      { action: "upsert", entity: "shopbite_business_hour", payload: original.map(fields) },
    ]);
  }
}

await pluginCheck("opening hours that ended block the order", async () => {
  const store = await guestCart();
  // every day 00:00 to 00:01: over for today whenever this runs (the quickstart has 00:00 to 23:59)
  await withClosingTime("00:01", () => expectOrderBlocked(store, "shopbite-ordering-closed"));
});

// --- Plugin: branch binding --------------------------------------------------------------

await pluginCheck("staff bound to another branch cannot read the ShopBite branch", async () => {
  const ownOrders = await admin.must("POST", "/search/order", {
    filter: [{ type: "equals", field: "salesChannelId", value: channel.id }],
    limit: 1,
    "total-count-mode": 1,
  });
  if (ownOrders.total === 0) {
    const store = await guestCart();
    await store.must("POST", "/checkout/order", {});
  }

  const [other] = await admin.search("sales-channel", {
    filter: [{ type: "not", queries: [{ type: "equals", field: "id", value: channel.id }] }],
    limit: 1,
  });
  expect(other, "no second sales channel to bind the user to");

  const verified = adminApi(await token(ADMIN_USER, ADMIN_PASSWORD, "write user-verified"));
  const me = await verified.must("GET", "/_info/me");
  const userId = randomUUID().replaceAll("-", "");
  const username = `hardening-staff-${Date.now()}`;
  const password = `Hardening-${randomUUID()}`;
  try {
    await verified.must("POST", "/user", {
      id: userId,
      username,
      password,
      firstName: "Erika",
      lastName: "Muster",
      email: `${username}@example.com`,
      localeId: me.data?.localeId ?? me.localeId,
      admin: false,
      active: true,
      aclRoles: [{ id: PERSONAL_ROLE_ID }],
      customFields: { [BRANCH_FIELD]: [other.id] },
    });
    const staff = adminApi(await token(username, password));
    const problems = [];

    const orders = await staff.must("POST", "/search/order", {
      filter: [{ type: "equals", field: "salesChannelId", value: channel.id }],
      "total-count-mode": 1,
    });
    if (orders.total !== 0 || orders.data.length !== 0) problems.push(`order search returned ${orders.total} ShopBite orders`);

    const settings = await staff.request("GET", `/_action/shopbite/settings/${channel.id}`);
    if (settings.status !== 403) problems.push(`settings of the ShopBite channel: HTTP ${settings.status}, expected 403`);

    const all = await staff.must("GET", "/_action/shopbite/settings");
    if (channel.id in (all.channels ?? {})) problems.push("settings list contains the ShopBite channel");

    const association = await staff.request("POST", "/search/sales-channel", {
      ids: [channel.id],
      associations: { orders: {} },
    });
    if (association.status !== 403) {
      problems.push(
        `sales_channel.orders: HTTP ${association.status}, expected 403 ` +
          `(${association.data?.data?.[0]?.orders?.length ?? 0} orders returned)`,
      );
    }
    expect(problems.length === 0, problems.join("; "));
  } finally {
    const cleanup = adminApi(await token(ADMIN_USER, ADMIN_PASSWORD, "write user-verified"));
    await cleanup.request("DELETE", `/user/${userId}`);
  }
});

// --- Storefront ----------------------------------------------------------------------------

await storefrontCheck("security headers on HTML pages", async () => {
  const response = await fetch(STOREFRONT);
  expect(response.ok, `HTTP ${response.status}`);
  const header = (name) => response.headers.get(name) ?? "";
  expect(header("content-type").includes("text/html"), `content-type ${header("content-type")}`);
  expect(header("x-content-type-options") === "nosniff", `x-content-type-options ${json(header("x-content-type-options"))}`);
  expect(
    /^(deny|sameorigin)$/i.test(header("x-frame-options")) || /frame-ancestors/.test(header("content-security-policy")),
    `neither x-frame-options nor frame-ancestors (${json(header("x-frame-options"))}, ${json(header("content-security-policy"))})`,
  );
  expect(header("referrer-policy") !== "", "no referrer-policy");
  const cacheControl = header("cache-control");
  expect(/private/.test(cacheControl) && /no-store/.test(cacheControl), `cache-control ${json(cacheControl)}`);
  expect(!response.headers.has("x-powered-by"), `x-powered-by ${json(header("x-powered-by"))}`);
});

await storefrontCheck("address autocomplete answers invalid requests generically", async () => {
  const invalid = [
    "text=Musterstra%C3%9Fe&lang=deutsch",
    "text=Musterstra%C3%9Fe&limit=999",
    `text=${"a".repeat(300)}`,
    "text=Musterstra%C3%9Fe&filter=rect:0,0,1,1&lang=../../",
  ];
  let skipped = false;
  for (const query of invalid) {
    const response = await fetch(`${STOREFRONT}/api/address/autocomplete?${query}`);
    const body = await response.text();
    // Nuxt's error body names the request's own URL; no other URL (the upstream one) may appear
    const own = `${STOREFRONT}/api/address/autocomplete?${query}`;
    const other = (body.match(/https?:\/\/[^"\s\\]+/gi) ?? []).filter((url) => url !== own);
    expect(other.length === 0, `${query}: response contains ${other.join(", ")}`);
    expect(!/geoapify|apikey/i.test(body), `${query}: response mentions the upstream service: ${body.slice(0, 300)}`);
    if (GEOAPIFY_KEY) {
      expect(!body.includes(GEOAPIFY_KEY), `${query}: response contains the key`);
      expect(response.status === 400, `${query}: HTTP ${response.status}, expected 400: ${body.slice(0, 300)}`);
    } else {
      // without a key the route answers every request with no suggestions
      expect(response.ok && json(JSON.parse(body)) === json({ features: [] }), `${query}: ${response.status} ${body}`);
      skipped = true;
    }
  }
  if (skipped) return { skip: "no Geoapify key configured, only checked that nothing leaks (start the storefront with test/compose.hardening.yaml)" };
});

await storefrontCheck("listing route rejects an unknown sorting", async () => {
  const [section] = await admin.search("category", { filter: [{ type: "equals", field: "name", value: "Pizza" }] });
  expect(section, "no menu section Pizza");
  const valid = await fetch(`${STOREFRONT}/api/listing/${section.id}?order=name-asc`);
  expect(valid.ok, `order=name-asc: HTTP ${valid.status}`);
  const response = await fetch(`${STOREFRONT}/api/listing/${section.id}?order=hardening-${Date.now()}`);
  expect(response.status === 400, `unknown order: HTTP ${response.status}, expected 400`);
});

await storefrontCheck("one-time hash leaves the address bar (password reset, registration)", async () => {
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  const hash = randomUUID().replaceAll("-", "");
  try {
    for (const path of [`/account/recover/password?hash=${hash}`, `/registrierung/bestaetigen?em=${hash}&hash=${hash}`]) {
      await page.goto(`${STOREFRONT}${path}`, { waitUntil: "networkidle" });
      await page.waitForFunction((h) => !location.href.includes(h), hash, { timeout: 10_000 }).catch(() => {});
      expect(!page.url().includes(hash), `${path.split("?")[0]} keeps the hash: ${page.url()}`);
    }
  } finally {
    await page.close();
  }
});

// --- Lead time per shipping method ---------------------------------------------------------

/** A shipping method of setup/setup.py (DELIVERY or PICKUP) with its delivery time, as the Admin API returns it. */
async function shippingMethod(spec) {
  const [method] = await admin.search("shipping-method", {
    filter: [{ type: "equals", field: "technicalName", value: spec.technicalName }],
    associations: { deliveryTime: {} },
  });
  expect(method, `no shipping method ${spec.technicalName} (did setup/setup.py create it?)`);
  return method;
}

/** "HH:MM" of `date` in `timeZone`, and whether that is still the same day as now. */
function wallClock(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const format = (d) => Object.fromEntries(formatter.formatToParts(d).map((p) => [p.type, p.value]));
  const then = format(date);
  const today = format(new Date());
  return { time: `${then.hour}:${then.minute}`, sameDay: then.day === today.day };
}

await leadTimeCheck("config route lists delivery and pickup with their lead times", async () => {
  const delivery = await shippingMethod(DELIVERY);
  const pickup = await shippingMethod(PICKUP);
  const config = await storeSession().must("GET", "/shopbite/config");
  expect(!("deliveryTime" in config), `deliveryTime is still in the config: ${json(config)}`);
  expect(Array.isArray(config.shippingMethods), `no shippingMethods in ${json(config)}`);
  for (const [method, spec] of [
    [delivery, DELIVERY],
    [pickup, PICKUP],
  ]) {
    const entry = config.shippingMethods.find((m) => m.id === method.id);
    expect(
      entry?.fulfillment === spec.fulfillment && entry?.leadTimeMinutes === spec.minutes,
      `${spec.name}: ${json(entry)}, expected ${spec.fulfillment} with ${spec.minutes} minutes`,
    );
    // the lead time is the method's Shopware delivery time
    const { unit, min, max } = method.deliveryTime ?? {};
    expect(
      unit === "minute" && min === spec.minutes && max === spec.minutes,
      `${spec.name}: delivery time ${json({ unit, min, max })}, expected ${spec.minutes} minutes`,
    );
  }
});

await leadTimeCheck("settings route changes the lead time of one shipping method", async () => {
  const pickup = await shippingMethod(PICKUP);
  const before = await admin.must("GET", `/_action/shopbite/settings/${channel.id}`);
  expect(!("deliveryMinutes" in before), `deliveryMinutes is still in the settings: ${json(before)}`);
  const original = before.shippingMethods?.find((m) => m.id === pickup.id);
  expect(original?.fulfillment === "pickup", `settings: ${json(before.shippingMethods)}`);
  const changed = original.leadTimeMinutes + 5;
  const minuteTimes = async () =>
    (await admin.search("delivery-time", { filter: [{ type: "equals", field: "unit", value: "minute" }] })).map((t) => t.id);
  const existingTimes = await minuteTimes();
  try {
    const after = await admin.must("PATCH", `/_action/shopbite/settings/${channel.id}`, {
      leadTimes: { [pickup.id]: changed },
    });
    const entry = after.shippingMethods?.find((m) => m.id === pickup.id);
    expect(entry?.leadTimeMinutes === changed && entry.leadTimeMinutesSet === true, `after PATCH: ${json(entry)}`);
    const delivery = after.shippingMethods?.find((m) => m.fulfillment === "delivery");
    expect(delivery?.leadTimeMinutes === DELIVERY.minutes, `the delivery method changed too: ${json(delivery)}`);
    const config = await storeSession().must("GET", "/shopbite/config");
    const listed = config.shippingMethods?.find((m) => m.id === pickup.id);
    expect(listed?.leadTimeMinutes === changed, `config route after PATCH: ${json(listed)}`);
    const stored = await shippingMethod(PICKUP);
    const { unit, min, max } = stored.deliveryTime ?? {};
    expect(
      unit === "minute" && min === changed && max === changed,
      `delivery time after PATCH ${json({ unit, min, max })}, expected ${changed} minutes`,
    );
    expect(
      stored.customFields?.shopbite_fulfillment === "pickup",
      `fulfillment lost after PATCH: ${json(stored.customFields)}`,
    );
    const unknown = await admin.request("PATCH", `/_action/shopbite/settings/${channel.id}`, {
      leadTimes: { [randomUUID().replaceAll("-", "")]: 20 },
    });
    expect(unknown.status === 400, `lead time of a method outside the channel: HTTP ${unknown.status}, expected 400`);
  } finally {
    // the method's own delivery time again, and the delivery times the PATCH created are removed
    await admin.must("PATCH", `/shipping-method/${pickup.id}`, { deliveryTimeId: pickup.deliveryTimeId });
    for (const id of (await minuteTimes()).filter((id) => !existingTimes.includes(id))) {
      await admin.request("DELETE", `/delivery-time/${id}`);
    }
  }
});

await leadTimeCheck("ordering window uses the lead time of the selected shipping method", async () => {
  const delivery = await shippingMethod(DELIVERY);
  const pickup = await shippingMethod(PICKUP);
  // closing in 20 minutes: enough for a pickup (15), too late for a delivery (30)
  const closing = wallClock(new Date(Date.now() + 20 * 60_000), channel.businessTimeZone || DEFAULT_TIME_ZONE);
  if (!closing.sameDay) return { skip: "less than 20 minutes to midnight in the shop's time zone" };

  const deliveryStore = await guestCart();
  const pickupStore = await guestCart();
  await pickupStore.must("PATCH", "/context", { shippingMethodId: pickup.id });
  await withClosingTime(closing.time, async () => {
    await deliveryStore.must("PATCH", "/context", { shippingMethodId: delivery.id });
    await expectOrderBlocked(deliveryStore, "shopbite-ordering-closed");

    const errors = await cartErrors(pickupStore);
    expect(!errors.includes("shopbite-ordering-closed"), `pickup cart errors ${json(errors)}`);
    const order = await pickupStore.request("POST", "/checkout/order", {});
    expect(order.ok, `pickup order refused with closing at ${closing.time}: HTTP ${order.status} ${json(order.data).slice(0, 300)}`);
  });
});

await leadTimeStorefrontCheck("checkout: wording and earliest time follow the shipping method, pickup comment", async () => {
  const email = `hardening-pickup-${Date.now()}@example.com`;
  browser ??= await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30_000);
  try {
    // the quickstart closes at 23:59 (browser time): no delivery time is left after 23:29
    const lateNight = await page.evaluate(() => {
      const d = new Date(Date.now() + 31 * 60_000);
      return d.getDate() !== new Date().getDate() || d.getHours() * 60 + d.getMinutes() > 23 * 60 + 59;
    });
    if (lateNight) return { skip: "less than 30 minutes to the quickstart's closing time 23:59" };

    await page.goto(`${STOREFRONT}/Speisekarte/Pizza/`, { waitUntil: "networkidle" });
    await page.getByText(DISH).first().click();
    await page.getByRole("button", { name: /In den Warenkorb/ }).click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${STOREFRONT}/bestellung/kasse`, { waitUntil: "networkidle" });

    const methods = page.getByRole("radiogroup", { name: "Versandarten" });
    const choose = async (spec) => {
      const radio = methods.getByRole("radio", { name: new RegExp(`^${spec.name}`) });
      await radio.click();
      await expectAttribute(radio, "aria-checked", "true");
      const field = page.getByLabel(spec.wording, { exact: true });
      await field.waitFor();
      await page.getByText(new RegExp(`ca\\. ${spec.minutes} Minuten`)).first().waitFor();
      // the earliest time is now plus the method's lead time (browser time, seconds cut off)
      await page.waitForFunction(
        ({ minutes }) => {
          const input = document.getElementById("delivery-time");
          if (!input?.min) return false;
          const [h, m] = input.min.split(":").map(Number);
          const now = new Date();
          const diff = (h * 60 + m - (now.getHours() * 60 + now.getMinutes()) + 1440) % 1440;
          return diff >= minutes - 2 && diff <= minutes;
        },
        { minutes: spec.minutes },
        { timeout: 10_000 },
      ).catch(async () => {
        const min = await page.locator("#delivery-time").getAttribute("min");
        throw new Error(`${spec.name}: earliest time ${min}, expected now plus ${spec.minutes} minutes`);
      });
    };
    await choose(PICKUP);
    await choose(DELIVERY);
    await choose(PICKUP);

    await saveGuestDetails(page, email);
    await expectAttribute(methods.getByRole("radio", { name: /^Abholung/ }), "aria-checked", "true");
    await page.getByRole("button", { name: "Zahlungspflichtig bestellen", exact: true }).click();
    await page.waitForURL(/\/erfolg/);
  } catch (error) {
    await page.screenshot({ path: `${SHOTS ?? "."}/hardening-failed.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }

  const pickup = await shippingMethod(PICKUP);
  const [order] = await admin.search("order", {
    filter: [{ type: "equals", field: "orderCustomer.email", value: email }],
    associations: { deliveries: {} },
  });
  expect(order, `no order of ${email}`);
  expect(
    /^Wunschabholzeit: \d{2}:\d{2}$/.test(order.customerComment ?? ""),
    `comment ${json(order.customerComment)}, expected "Wunschabholzeit: HH:MM"`,
  );
  expect(
    order.deliveries?.[0]?.shippingMethodId === pickup.id,
    `shipping method ${order.deliveries?.[0]?.shippingMethodId}, expected ${pickup.id} (Abholung)`,
  );
});

await browser?.close();
if (failed) {
  console.error(`hardening test: ${failed} check(s) failed`);
  process.exit(1);
}
console.log("hardening test passed");
