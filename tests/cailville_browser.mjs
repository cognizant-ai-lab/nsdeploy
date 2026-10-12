// Drives the running Cailville sites in headless Chromium, the way a person would:
// opens the map, then for each site sends its first sample query, approves each
// partner site the agent asks to contact, keeps the local demo fallback whenever it
// offers to link a demo-mode agent, and waits for the answer to settle.
//
// Start Cailville first (see the README), then:
//
//   npx playwright install chromium     # once
//   npm run test:cailville              # every site in cailville/community.json
//   npm run test:cailville -- 8091 8105 # just these ports
//   HEADED=1 npm run test:cailville -- 8091  # watch it in a visible browser
//
// Screenshots go to .nsdeploy/cailville-browser-test/. Exits 1 if any site shows a
// page error, a failed request, or no answer.

import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".nsdeploy", "cailville-browser-test");
const MAP_FILE = path.join(ROOT, "cailville", "cailville.html");
const SITE_TIMEOUT_MS = 180000;
// How long the chat has to stay unchanged, with nothing left to approve, to count
// as answered.
const SETTLED_SECONDS = 5;

// The MCP client's optional stream GET, which the facade doesn't offer.
function expected(error) {
  return /405 GET .*\/(ext-)?mcp/.test(error) || error.includes("status of 405");
}

function sitePorts() {
  const requested = process.argv.slice(2);
  if (requested.length) return requested;
  const community = JSON.parse(readFileSync(path.join(ROOT, "cailville", "community.json"), "utf8"));
  return community.sites.map((site) => String(site.port));
}

async function checkMap(browser) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("file://" + MAP_FILE);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, "map.png") });
  await page.close();
  return { site: "map", errors };
}

async function waitForAnswer(page, before) {
  const allow = page.getByRole("button", { name: "Always allow" });
  const keepFallback = page.locator(".ns-linker-form").getByRole("button", { name: "Cancel" });
  const counts = { approvals: 0, declinedLinks: 0 };
  const deadline = Date.now() + SITE_TIMEOUT_MS;
  let last = "";
  let settledFor = 0;

  // Each second, answer whatever the agent is asking, otherwise check whether the
  // chat has stopped changing.
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (await keepFallback.count()) {
      await keepFallback.first().click().catch(() => {});
      counts.declinedLinks += 1;
      settledFor = 0;
      continue;
    }
    if (await allow.count()) {
      await allow.first().click().catch(() => {});
      counts.approvals += 1;
      settledFor = 0;
      continue;
    }
    const now = await page.locator("#ns-msgs").innerText();
    settledFor = now === last ? settledFor + 1 : 0;
    last = now;
    if (now.length > before.length && settledFor >= SETTLED_SECONDS) {
      return { ...counts, answer: now.slice(before.length).trim() };
    }
  }
  return { ...counts, answer: null };
}

async function checkSite(browser, port) {
  const base = `http://127.0.0.1:${port}`;
  const manifest = await (await fetch(`${base}/agent-manifest.json`)).json();
  const network = manifest.networks[0];
  const query = (network.sample_queries || [])[0] || "What can you help me with?";

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  const partners = new Set();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.port && url.port !== String(port) && url.pathname.endsWith("/agent-manifest.json")) {
      partners.add(url.port);
    }
  });

  const started = Date.now();
  let result = { approvals: 0, declinedLinks: 0, answer: null };
  try {
    await page.goto(base + "/");
    await page.waitForSelector("#ns-input", { timeout: 30000 });
    const before = await page.locator("#ns-msgs").innerText();
    await page.fill("#ns-input", query);
    await page.click("#ns-send");
    result = await waitForAnswer(page, before);
  } catch (error) {
    errors.push(String(error).split("\n")[0]);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${network.name}.png`) });
  await page.close();

  const problems = errors.filter((error) => !expected(error));
  if (result.answer === null) problems.push(`no answer within ${SITE_TIMEOUT_MS / 1000}s`);
  return {
    site: `${network.name} :${port}`,
    seconds: Math.round((Date.now() - started) / 1000),
    partners: [...partners],
    approvals: result.approvals,
    declinedLinks: result.declinedLinks,
    errors: problems,
  };
}

mkdirSync(OUT_DIR, { recursive: true });
// HEADED=1 opens a visible browser and slows each step down enough to follow.
const headed = Boolean(process.env.HEADED);
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 250 : 0 });
const results = [await checkMap(browser)];
for (const port of sitePorts()) {
  const result = await checkSite(browser, port);
  results.push(result);
  const status = result.errors.length ? "FAIL" : "ok  ";
  console.log(`${status} ${result.site.padEnd(32)} ${String(result.seconds).padStart(4)}s ` +
              `partners=${result.partners.length} approvals=${result.approvals} ` +
              `kept-demo-fallback=${result.declinedLinks}`);
  for (const error of result.errors) console.log(`     ${error.slice(0, 200)}`);
}
await browser.close();

if (results[0].errors.length) console.log(`FAIL map: ${results[0].errors.join("; ")}`);
const failed = results.filter((result) => result.errors.length).length;
console.log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} passed.`);
process.exit(failed ? 1 : 0);
