// Self-contained, two-origin native form integration test. No adapter or LLM key.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.NSDEPLOY_PLAYWRIGHT_MODULE || "playwright");
const runtime = new URL("../nsdeploy/runtime/", import.meta.url);
const records = [], servers = [];
let localOrigin, remoteOrigin, token = 0, change = false, recordId = "target-1";
async function server(remote) {
  const s = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = new URL(req.url, "http://localhost");
    const send = (type, data) => { res.setHeader("Content-Type", type); res.end(data); };
    if (url.pathname.startsWith("/runtime/") && !url.pathname.includes("..")) {
      try { return send("text/javascript", await readFile(fileURLToPath(new URL(url.pathname.slice(9), runtime)))); }
      catch { res.statusCode = 404; return res.end(); }
    }
    if (url.pathname === "/agent-manifest.json") return send("application/json", JSON.stringify({ networks: [{ name: remote ? "remote" : "local" }],
      actions: { version: 1, bridge: "./action-bridge.html", pages: ["/forms"], callerOrigins: remote ? [localOrigin] : [] } }));
    if (url.pathname === "/action-bridge.html") return send("text/html", '<script type="module" src="/runtime/action-bridge.js"></script>');
    if (url.pathname === "/forms") {
      const csrf = `test-csrf-${++token}`;
      res.setHeader("Set-Cookie", `csrf=${csrf}; Path=/; SameSite=Lax`);
      return send("text/html", `<form id="request" aria-label="${remote ? "Remote order" : "Local reservation"}" method="post" action="${change ? "/changed" : "/submit"}">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="record" value="${recordId}">
        <label>Guests<input name="guests" type="number" required min="1" max="8" step="1"></label>
        <label>Code<input name="code" pattern="[A-Z]{3}" required></label>
        <label><input type="checkbox" name="agree" required>Agree</label>
        <select name="seat"><option>inside</option><option>outside</option></select>
        <input type="checkbox" name="sides" value="salad"><input type="checkbox" name="sides" value="rice">
        <button name="operation" value="reserve">Submit</button></form>
        <form action="/search" data-nsdeploy-effect="read"><input name="q" required><button>Search</button></form>
        <form action="/login" method="post"><input name="password" type="password"></form>
        <form><input name="dynamic"><button>JS only</button></form>
        <form action="https://third-party.invalid/write"><input name="bad"></form>`);
    }
    if (url.pathname === "/empty") return send("text/html", "<p>No forms here</p>");
    if (url.pathname === "/existing-actions.js") return send("text/javascript", `export function registerActions(actions) {
      actions.register({ name: 'existing_js', description: 'Existing site function', inputSchema: {type:'object',properties:{}},
        effect:'read', execute: async () => ({source:'existing-module'}) });
    }`);
    if (url.pathname === "/submit" && req.method === "POST") {
      let body = ""; for await (const c of req) body += c;
      const data = new URLSearchParams(body);
      if (!req.headers.cookie?.includes(`csrf=${data.get("csrf")}`)) { res.statusCode = 403; return res.end(); }
      records.push({ remote, data: [...data] });
      return send("application/json", JSON.stringify({ id: `record-${records.length}`, accepted: true, csrf: data.get("csrf") }));
    }
    if (url.pathname === "/search") return send("text/html", `<h1>Available table: 19:00</h1><form><input type="hidden" value="private"></form>`);
    send("text/html", '<main id="app"></main>');
  });
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve)); servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
let browser;
try {
  localOrigin = await server(false); remoteOrigin = await server(true);
  browser = await chromium.launch({ headless: true, ...(process.env.NSDEPLOY_CHROME ? { executablePath: process.env.NSDEPLOY_CHROME } : {}) });
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(localOrigin);
  const info = await page.evaluate(async remote => {
    const { ActionRegistry } = await import("/runtime/actions.js");
    const { loadActionModule, registerRemoteActions, reviewActions } = await import("/runtime/action-transport.js");
    const { renderPresentation } = await import("/runtime/ui.js");
    const { Engine } = await import("/runtime/engine.js");
    const registry = new ActionRegistry();
    await loadActionModule(registry, { base: location.origin, network: "local" }, await (await fetch("/agent-manifest.json")).json());
    await registerRemoteActions(registry, { base: remote, network: "remote" }, await (await fetch(remote + "/agent-manifest.json")).json());
    const entries = [...registry.entries.values()];
    const writes = entries.filter(e => e.effect === "write");
    const schema = writes[0].inputSchema;
    const component = { id: "combined", kind: "form", schema, submit: { actions: writes.map(e => ({ action: e.ref, inputs: Object.fromEntries(Object.keys(schema.properties).map(k => [k, k])) })) } };
    const engine = new Engine({ originUrl: location.origin });
    engine.actions = registry; engine.onActionConfirm = reviewActions;
    engine.rememberActionPresentation({ turnId: "form-test", presentation: { version: 1, components: [component] } });
    window.fixture = { engine, registry, writes, entries, component };
    renderPresentation(document.querySelector("#app"), { version: 1, components: [component] }, async (_text, interaction) => {
      window.receipts = await engine.submitActions(interaction); return !!window.receipts;
    }, "form-test");
    return { catalog: entries.map(({ name, inputSchema }) => ({ name, inputSchema })), issues: registry.discoveryIssues };
  }, remoteOrigin);
  assert.equal(info.catalog.length, 4);
  assert.ok(!JSON.stringify(info.catalog).includes("test-csrf"));
  assert.ok(!JSON.stringify(info.catalog).includes('"csrf"'));
  assert.equal(info.issues.length, 3);
  await page.locator('input[type="number"]').fill("3");
  await page.locator('input[type="text"]').fill("ABC");
  await page.locator('input[type="checkbox"]').first().check();
  await page.locator("select").selectOption("outside");
  await page.locator('input[type="checkbox"]').nth(1).check();
  await page.locator('button[type="submit"]').click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(records.length, 0);
  await page.locator('button[type="submit"]').click();
  await page.getByRole("button", { name: "Confirm actions", exact: true }).click();
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open action site" }).click();
  const popup = await popupPromise;
  await popup.getByRole("button", { name: "Confirm actions", exact: true }).click();
  await page.waitForFunction(() => window.receipts?.length === 2);
  const receipts = await page.evaluate(() => window.receipts);
  assert.deepEqual(receipts.map(r => r.status), ["succeeded", "succeeded"]);
  assert.equal(records.length, 2);
  for (const r of records) {
    const d = new URLSearchParams(r.data);
    assert.equal(d.get("guests"), "3"); assert.equal(d.get("operation"), "reserve");
    assert.equal(d.get("agree"), "on"); assert.deepEqual(d.getAll("sides"), ["salad"]);
    assert.equal(d.get("seat"), "outside");
  }
  assert.ok(!JSON.stringify(receipts).includes("test-csrf"));
  assert.equal(receipts[0].result.businessOutcome, "unverified");
  assert.equal(await page.locator('button[type="submit"]').isDisabled(), true);
  const invalid = await page.evaluate(async () => {
    try { await fixture.writes[0].execute({ guests: 2.5, code: "ABC", agree: true }, {}); }
    catch (e) { return e.message; }
  });
  assert.match(invalid, /validation rejected/); assert.equal(records.length, 2);
  const read = await page.evaluate(async () => {
    const e = fixture.entries.find(e => e.effect === "read" && e.base === location.origin);
    return e.execute({ q: "tables" }, {});
  });
  assert.match(read.evidence.text, /19:00/); assert.ok(!read.evidence.text.includes("private"));
  recordId = "target-2";
  const targetChange = await page.evaluate(async () => {
    try { await fixture.writes[0].execute({ guests: 2, code: "ABC", agree: true }, {}); }
    catch (e) { return e.message; }
  });
  assert.match(targetChange, /Form changed/); assert.equal(records.length, 2);
  recordId = "target-1";
  change = true;
  const changed = await page.evaluate(async () => {
    try { await fixture.writes[0].execute({ guests: 2, code: "ABC", agree: true }, {}); }
    catch (e) { return e.message; }
  });
  assert.match(changed, /Form changed/); assert.equal(records.length, 2);
  const empty = await page.evaluate(async () => {
    const { registerFormActions } = await import("/runtime/form-actions.js");
    const issues = [];
    const count = await registerFormActions({ register: () => { throw new Error("unexpected"); } }, { pages: ["/empty"], report: i => issues.push(i) });
    return { count, issues };
  });
  assert.equal(empty.count, 0); assert.match(empty.issues[0].reason, /No native forms/);
  const js = await page.evaluate(async () => {
    const { loadActionModule } = await import("/runtime/action-transport.js");
    await loadActionModule(fixture.registry, { base: location.origin, network: "js" }, { actions: { version: 1, modules: ["/existing-actions.js"] } });
    const entry = [...fixture.registry.entries.values()].find(e => e.name === "existing_js");
    return entry.execute({}, {});
  });
  assert.equal(js.source, "existing-module");
  console.log("PASS: automatic native forms; unified local/remote CRUSE; both confirmations; fresh CSRF/cookies; real HTTP records; receipts; cancellation; validation; form changes; sensitive exclusions; GET reads; missing integration diagnostics.");
} finally {
  await browser?.close();
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
}
