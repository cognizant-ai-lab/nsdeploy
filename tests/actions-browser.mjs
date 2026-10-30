// Build/start examples/actions_demo first. Uses deterministic model responses,
// real runtime loops, actual DOM submission, two origins, popup and HTTP POST.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.NSDEPLOY_PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.NSDEPLOY_CHROME ? { executablePath: process.env.NSDEPLOY_CHROME } : {}) });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const requests = [];
  context.on("request", request => { if (request.method() === "POST" && request.url().includes("/api/reservations")) requests.push(JSON.parse(request.postData())); });
  async function prepare(url) {
    await page.goto(url);
    await page.waitForFunction(() => window.__nsweb?.engine?.top?.network);
    await page.evaluate(() => {
      const engine = window.__nsweb.engine;
      const model = async ({ messages, tools }) => {
        const system = messages[0].content;
        const catalog = JSON.parse(system.split("CRUSE browser actions (proposals only; these are NOT tool calls):\n")[1].split("\n")[0]);
        const child = messages.filter(m => m.role === "tool");
        if (tools?.length && !child.length) return { content: "", toolCalls: [{ id: "venue-call", type: "function", function: { name: tools[0].function.name, arguments: '{"request":"Plan a restaurant visit"}' } }] };
        const components = [];
        if (catalog[0]?.name === "reserve_table") components.push({ id: "reservation", kind: "form", title: "Restaurant visit", schema: catalog[0].inputSchema, submit: { actions: [{ action: catalog[0].ref, inputs: { date: "date", partySize: "partySize" } }] } });
        else {
          const remote = JSON.parse(child[0].content).presentation.components[0];
          remote.schema.properties.seat = catalog[0].inputSchema.properties.seat;
          remote.schema.required.push("seat");
          remote.submit.actions.unshift({ action: catalog[0].ref, inputs: { seat: "seat" } });
          components.push(remote);
        }
        return { content: 'Demonstration only. Review your request.\n```cruse-ui\n' + JSON.stringify({ version: 1, components }) + '\n```', toolCalls: [] };
      };
      engine.top.llm.chat = model;
      const original = engine.resolveRemote.bind(engine);
      engine.resolveRemote = async (...args) => { const session = await original(...args); session.llm.chat = model; return session; };
      engine.onConsent = async () => "allow";
    });
    await page.locator(".ns-input").fill("Plan my restaurant visit");
    await page.locator(".ns-send").click();
    await page.locator(".ns-w-form").waitFor();
    await page.locator('input[type="date"]').fill("2026-12-15");
    await page.locator('input[type="number"]').fill("3");
  }
  await prepare("http://127.0.0.1:8122/");
  await page.locator('.ns-w-form button[type="submit"]').click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(requests.length, 0, "cancellation must not submit");
  await page.locator('.ns-w-form button[type="submit"]').click();
  await page.getByRole("button", { name: "Confirm actions", exact: true }).click();
  await page.getByText(/#reserve_table: succeeded/).waitFor();
  assert.equal(requests.length, 1);

  await prepare("http://127.0.0.1:8121/");
  assert.equal(await page.locator(".ns-w-form").count(), 1, "one consolidated form");
  await page.locator(".ns-w-form select").selectOption("outside");
  await page.locator('.ns-w-form button[type="submit"]').click();
  await page.getByRole("button", { name: "Confirm actions", exact: true }).click();
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open action site" }).click();
  const popup = await popupPromise;
  await popup.getByRole("button", { name: "Confirm actions", exact: true }).click();
  await page.getByText(/#reserve_table: succeeded/).waitFor();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { date: "2026-12-15", partySize: 3 }, "local-only seat must not leak to remote action");
  assert.equal(await page.evaluate(() => localStorage.getItem("nsdeploy-demo-seat")), "outside");
  assert.equal(await page.locator('.ns-w-form button[type="submit"]').isDisabled(), true);
  const rejection = await page.evaluate(async () => {
    const { ActionBridgeClient } = await import("./runtime/action-transport.js");
    const client = new ActionBridgeClient("http://127.0.0.1:8122/action-bridge.html");
    try {
      await client.connect();
      const catalog = await client.request("catalog");
      if (catalog.length !== 1) throw new Error("Expected one exposed remote action");
      try { await client.request("execute", { name: "reserve_table", args: { date: "2026-12-15", partySize: 2 }, requestId: "forged-confirmation" }); }
      catch (error) { return error.message; }
    } finally { client.dispose(); }
  });
  assert.match(rejection, /confirmation window/);
  assert.equal(requests.length, 2, "a caller cannot bypass first-party confirmation");
  // A second combined submission exercises refusal at the owning origin after
  // the local operation has already completed.
  await prepare("http://127.0.0.1:8121/");
  await page.locator(".ns-w-form select").selectOption("inside");
  await page.locator('.ns-w-form button[type="submit"]').click();
  await page.getByRole("button", { name: "Confirm actions", exact: true }).click();
  const deniedPopupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open action site" }).click();
  const deniedPopup = await deniedPopupPromise;
  await deniedPopup.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText(/User declined; action not started/).waitFor();
  assert.equal(requests.length, 2, "remote refusal must not send a POST");
  assert.equal(await page.evaluate(() => localStorage.getItem("nsdeploy-demo-seat")), "inside");
  assert.deepEqual(errors, []);
  console.log("PASS: same-site POST, cancellation, remote fetch-and-run, unified local/remote form, first-party confirmation, field isolation, receipt and disabled resubmission.");
} finally { await browser.close(); }
