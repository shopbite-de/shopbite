// End-to-end smoke test of the running quickstart stack (docker compose up -d):
// start page, a dish in every menu section, pizza with an extra, guest checkout with delivery, contact form, both mails in Mailpit.
//
//   cd test && npm ci && npx playwright install chromium && npm run smoke
//
// Exits non-zero on the first failed step. SMOKE_SCREENSHOTS=<dir> keeps a screenshot per step.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const STOREFRONT = process.env.STOREFRONT_URL ?? "http://localhost:3000";
const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
const SHOTS = process.env.SMOKE_SCREENSHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.setDefaultTimeout(30_000);

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: `${SHOTS ?? "."}/failed.png`, fullPage: true }).catch(() => {});
    if (consoleErrors.length) console.error("browser console errors:\n" + consoleErrors.join("\n"));
    await browser.close();
    process.exit(1);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name.replace(/\W+/g, "-")}.png`, fullPage: true });
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// id of a seeded entity, like hid() in setup/setup.py (uuid5 in the setup namespace)
function hid(key) {
  const namespace = Buffer.from("0b5f0c1e7a4d4c3b9e8f5d6a7b8c9d0e", "hex");
  const bytes = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(key)])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString("hex");
}

await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });

await step("start page", async () => {
  const response = await page.goto(STOREFRONT, { waitUntil: "networkidle" });
  expect(response?.ok(), `HTTP ${response?.status()}`);
  await page.getByRole("link", { name: /Pizza/ }).first().waitFor();
});

await step("menu section", async () => {
  await page.getByRole("link", { name: /Pizza/ }).first().click();
  await page.waitForURL(/\/Speisekarte\/Pizza\//);
  await page.getByText("Pizza Margherita").first().waitFor();
});

await step("every menu section lists dishes", async () => {
  const menu = JSON.parse(readFileSync(new URL("../setup/menu.json", import.meta.url), "utf8"));
  const empty = [];
  for (const section of menu.categories) {
    const response = await fetch(`${STOREFRONT}/api/listing/${hid("category:" + section.key)}`);
    expect(response.ok, `listing of ${section.name}: HTTP ${response.status}`);
    if (!((listing) => listing.dishes ?? listing.elements)(await response.json())?.length) empty.push(section.name);
  }
  expect(!empty.length, `no dishes in ${empty.join(", ")}`);
});

await step("pizza with an extra into the cart", async () => {
  await page.getByText("Pizza Margherita").first().click();
  await page.getByText("Extra Salami").click();
  // the cart write must be answered before the page is left: a new visitor gets the session
  // cookie with that answer (newer storefronts give no session for a page view)
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && /\/api\/cart\/lines|\/checkout\/cart\/line-item/.test(response.url()),
    ),
    page.getByRole("button", { name: /In den Warenkorb/ }).click(),
  ]);
  // storefront 2.x: one-page checkout with the cart next to the form
  await page.goto(`${STOREFRONT}/bestellung/kasse`, { waitUntil: "networkidle" });
  await page.getByText(/Pizza Margherita \+Extra Salami/).first().waitFor();
});

await step("guest checkout", async () => {
  // delivery is preselected: the time field says "Wunschlieferzeit" (storefront 2.5.0 and older:
  // "Wunschzeit für Lieferung oder Abholung, frühestens") and holds the earliest time
  await page.getByLabel(/^Wunsch(lieferzeit|zeit für Lieferung)/).first().waitFor();
  await page.waitForFunction(() => /^\d{2}:\d{2}$/.test(document.getElementById("delivery-time")?.value ?? ""));
  for (const [label, value] of [
    ["Vorname", "Max"],
    ["Nachname", "Muster"],
    ["E-Mail", "smoke@example.com"],
    ["Straße und Hausnummer", "Musterstraße 1"],
    ["PLZ", "12345"],
    ["Ort", "Musterstadt"],
    ["Telefon", "0123456789"],
  ]) {
    await page.getByLabel(label, { exact: true }).first().fill(value);
  }
  await page.getByText("Ich habe die Datenschutzerklärung").click();
  await page.getByRole("button", { name: "Angaben speichern", exact: true }).click();
  const order = page.getByRole("button", { name: "Zahlungspflichtig bestellen", exact: true });
  await order.waitFor();
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Zahlungspflichtig bestellen" && !b.disabled),
  );
  await order.click();
  await page.waitForURL(/\/erfolg/);
});

await step("contact form", async () => {
  await page.goto(`${STOREFRONT}/kontakt`, { waitUntil: "networkidle" });
  for (const [label, value] of [
    ["Vorname", "Max"],
    ["Nachname", "Muster"],
    ["E-Mail", "smoke@example.com"],
    // Shopware requires it by default (core.basicInformation.phoneNumberFieldRequired)
    ["Telefon", "0123456789"],
    ["Betreff", "Smoke-Test"],
    ["Nachricht", "Automatischer Test der Kontaktseite."],
  ]) {
    await page.getByLabel(label).first().fill(value);
  }
  const salutation = page.getByLabel(/Anrede/).first();
  if (await salutation.count()) {
    await salutation.click();
    await page.getByRole("option").first().click();
  }
  await page.getByRole("button", { name: /senden/i }).click();
  await page.getByText(/erfolgreich versendet|Nachricht ist bei uns angekommen/).first().waitFor();
});

await step("mails in Mailpit", async () => {
  // mails leave through the message queue, give the worker a moment
  let subjects = [];
  for (let i = 0; i < 30; i++) {
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    subjects = messages.map((m) => m.Subject);
    if (subjects.some((s) => /Bestellbestätigung/.test(s)) && subjects.some((s) => /Kontaktanfrage/.test(s))) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`expected order confirmation and contact mail, got: ${subjects.join(", ") || "none"}`);
});

await browser.close();
console.log("smoke test passed");
