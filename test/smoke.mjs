// End-to-end smoke test of the running quickstart stack (docker compose up -d):
// start page, pizza with an extra, guest checkout, contact form, both mails in Mailpit.
//
//   cd test && npm ci && npx playwright install chromium && npm run smoke
//
// Exits non-zero on the first failed step. SMOKE_SCREENSHOTS=<dir> keeps a screenshot per step.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

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

await step("pizza with an extra into the cart", async () => {
  await page.getByText("Pizza Margherita").first().click();
  await page.getByText("Extra Salami").click();
  await page.getByRole("button", { name: /In den Warenkorb/ }).click();
  // storefront 2.x: one-page checkout with the cart next to the form
  await page.goto(`${STOREFRONT}/bestellung/kasse`, { waitUntil: "networkidle" });
  await page.getByText(/Pizza Margherita \+Extra Salami/).first().waitFor();
});

await step("guest checkout", async () => {
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
