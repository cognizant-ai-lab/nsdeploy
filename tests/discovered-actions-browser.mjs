// Actual static bundles, two agent origins, one external API/form origin.
// No LLM or handwritten adapters; every successful receipt has a server record.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const exec = promisify(execFile);
const { chromium } = await import(process.env.NSDEPLOY_PLAYWRIGHT_MODULE || "playwright");
const root = await mkdtemp(path.join(tmpdir(), "nsdeploy-discovery-")), servers = [], records = [];
let service, local, remote, browser, changed = false, cors = true;
const form = () => `<form action="/echo" method="post"><input name="custemail" type="email"><input name="size" type="radio" value="small"><input name="size" type="radio" value="large"><input name="topping" type="checkbox" value="cheese"><input name="topping" type="checkbox" value="onion"><input name="delivery" type="time" min="11:00" max="21:00" step="900"><textarea name="comments" ${changed ? 'required' : ''}></textarea><button>Submit</button></form>`;
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const send = (res, data, type = "application/json") => { res.setHeader("Content-Type", type); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
async function staticSite(name, req, res) {
  const target = new URL(req.url, "http://localhost").pathname;
  if (/agent-manifest\.json$|\.network\.json$/.test(target)) res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if (target.includes("..")) throw new Error();
    const filename = path.join(root, name, target === "/" ? "index.html" : target);
    const text = await readFile(filename);
    const type = /\.m?js$/.test(target) ? "text/javascript" : target.endsWith(".json") ? "application/json" : "text/html";
    res.setHeader("Content-Type", type); res.end(text);
  } catch { res.statusCode = 404; res.end(); }
}
try {
  service = await serve(async (req, res) => {
    if (cors) res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "0");
    if (req.method === "OPTIONS") return res.end();
    if (req.url === "/forms/post") return send(res, form(), "text/html");
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      records.push({ path: req.url, body, headers: req.headers });
      if (req.url === "/echo") return send(res, { form: Object.fromEntries(new URLSearchParams(body)), echoed: true });
      return send(res, { id: `test-${records.length}`, ...JSON.parse(body), createdAt: new Date().toISOString() });
    }
    const record = records.find((r, i) => req.url === `/objects/test-${i + 1}`);
    if (!record) res.statusCode = 404;
    send(res, record ? JSON.parse(record.body) : { error: "not found" });
  });
  local = await serve((req, res) => staticSite("local", req, res));
  remote = await serve((req, res) => staticSite("remote", req, res));
  const spec = JSON.parse(await readFile(new URL("../examples/actions/restful-api.openapi.json", import.meta.url), "utf8"));
  spec.servers[0].url = service;
  await writeFile(path.join(root, "spec.json"), JSON.stringify(spec));
  await writeFile(path.join(root, "local.hocon"), '{tools:[{name:front,instructions:"Use browser actions."}]}');
  await writeFile(path.join(root, "remote.hocon"), '{tools:[{name:front,instructions:"Use browser actions."}]}');
  const python = process.env.NSDEPLOY_PYTHON || ".venv/bin/python";
  for (const name of ["local", "remote"]) {
    const args = ["-m", "nsdeploy", path.join(root, `${name}.hocon`), "--static-bundle", "--mock-llm", "--out", path.join(root, name),
      "--site-url", name === "local" ? local : remote, "--action-site", service + "/forms/post", "--action-include-all", "--action-max-pages", "1"];
    if (name === "local") args.push("--action-spec", path.join(root, "spec.json"));
    else args.push("--action-caller-origin", local);
    await exec(python, args);
  }
  assert.equal(records.length, 0, "Discovery must not execute any business operation");
  browser = await chromium.launch({ headless: true, ...(process.env.NSDEPLOY_CHROME ? { executablePath: process.env.NSDEPLOY_CHROME } : {}) });
  const context = await browser.newContext();
  // Plain HTTP lacks randomUUID/subtle in browsers. Keep getRandomValues, which
  // remains available, and exercise both runtime fallbacks end to end.
  await context.addInitScript(() => {
    try { Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true }); } catch {}
    try { Object.defineProperty(Crypto.prototype, "subtle", { get: () => undefined, configurable: true }); } catch {}
  });
  const page = await context.newPage();
  await page.goto(remote);
  const isolated = await page.evaluate(async () => {
    const { ActionRegistry } = await import("/runtime/actions.js");
    const { loadActionModule } = await import("/runtime/action-transport.js");
    const registry = new ActionRegistry(), scope = { base: location.origin, network: "remote" };
    await loadActionModule(registry, scope, await (await fetch("/agent-manifest.json")).json());
    const entry = [...registry.entries.values()][0];
    window.remoteEntry = entry;
    return registry.execute([{entry, args: {custemail:"", size:"small", topping:["cheese"], delivery:"20:00", comments:"isolation test"}}], async () => true, "isolated");
  });
  assert.equal(isolated[0].result.data.form.size, "small");
  assert.equal(records.length, 1);
  const invalid = await page.evaluate(async () => {
    try { await remoteEntry.execute({size:"small", delivery:"22:00"}, {}); } catch (e) { return e.message; }
  });
  assert.match(invalid, /constraints/); assert.equal(records.length, 1);
  const malformed = await page.evaluate(async () => {
    try { await remoteEntry.execute({size:"small", delivery:"not a time"}, {}); } catch (e) { return e.message; }
  });
  assert.match(malformed, /Invalid native form value/); assert.equal(records.length, 1);
  changed = true;
  const stale = await page.evaluate(async () => {
    try { await remoteEntry.execute({size:"small", delivery:"20:00"}, {}); } catch (e) { return e.message; }
  });
  assert.match(stale, /Source form changed/); assert.equal(records.length, 1); changed = false;
  await page.goto(local);
  const combined = await page.evaluate(async remote => {
    const { ActionRegistry, actionContext } = await import("/runtime/actions.js");
    const { loadActionModule, registerRemoteActions, reviewActions } = await import("/runtime/action-transport.js");
    const { Engine } = await import("/runtime/engine.js");
    const { renderPresentation } = await import("/runtime/ui.js");
    const registry = new ActionRegistry(), scope = {base:location.origin, network:"local"};
    await loadActionModule(registry, scope, await (await fetch("/agent-manifest.json")).json());
    await registerRemoteActions(registry, {base:remote, network:"remote"}, await (await fetch(remote + "/agent-manifest.json")).json());
    const entries = [...registry.entries.values()];
    const create = entries.find(e => e.name.startsWith("post_objects"));
    const order = entries.find(e => e.base === remote);
    const component = {kind:"form", id:"both", title:"Review both requests", schema:{type:"object", properties:{note:{type:"string"}}, required:["note"]},
      submit:{actions:[{action:create.ref, arguments:{name:"nsdeploy integration test", data:JSON.stringify({date:"2026-11-14", time:"19:00", party_size:4})}},
        {action:order.ref, arguments:{size:"large", topping:["cheese","onion"], delivery:"20:00"}, inputs:{comments:"note"}}]}};
    const engine = new Engine({originUrl:location.origin}); engine.actions = registry; engine.onActionConfirm = reviewActions;
    engine.rememberActionPresentation({turnId:"combined-test", presentation:{version:1,components:[component]}});
    const mount = document.createElement("main"); document.body.replaceChildren(mount);
    renderPresentation(mount, {version:1,components:[component]}, async (_text, interaction) => {window.receipts = await engine.submitActions(interaction);return !!window.receipts;}, "combined-test");
    window.fixture = {registry, entries, engine, create, order};
    return {count:entries.length, context:actionContext(registry.catalog(scope))};
  }, remote);
  assert.equal(combined.count, 5); assert.match(combined.context, /post_objects/);
  await page.locator('input[type="text"]').fill("combined test only");
  await page.locator('button[type="submit"]').click();
  assert.equal(records.length, 1, "No writes before review");
  assert.ok((await page.locator("dialog").textContent()).includes(service), "Review identifies the external destination");
  await page.getByRole("button", { name: "Confirm actions", exact: true }).click();
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("button", {name:"Open action site", exact:true}).click();
  const popup = await popupPromise;
  await popup.getByRole("button", {name:"Confirm actions", exact:true}).waitFor();
  assert.ok((await popup.locator("dialog").textContent()).includes(service));
  await popup.getByRole("button", {name:"Confirm actions", exact:true}).click();
  await page.waitForFunction(() => Array.isArray(window.receipts));
  const receipts = await page.evaluate(() => receipts);
  assert.equal(receipts.length, 2); assert.ok(receipts.every(r => r.status === "succeeded"));
  assert.equal(records.length, 3);
  assert.equal(receipts[0].result.data.id, "test-2");
  assert.equal(receipts[1].result.data.form.comments, "combined test only");
  assert.equal(records[1].headers.origin, local); assert.equal(records[2].headers.origin, remote);
  assert.equal(records[1].headers.cookie, undefined); assert.equal(records[2].headers.cookie, undefined);
  const readback = await page.evaluate(async () => {
    const get = fixture.entries.find(e => e.name.startsWith("get_objects"));
    const ok = await get.execute({id:"test-2"}, {}), missing = await get.execute({id:"missing"}, {});
    let traversal; try { await get.execute({id:"../wrong"}, {}); } catch (e) { traversal = e.message; }
    return {ok, missing, traversal};
  });
  assert.equal(readback.ok.data.data.party_size, 4);
  assert.equal(readback.missing.httpOk, false); assert.equal(readback.missing.httpStatus, 404);
  assert.match(readback.traversal, /Unsafe API path/);
  const unapproved = await context.newPage();
  await unapproved.goto(remote);
  const denied = await unapproved.evaluate(async local => {
    const {ActionRegistry} = await import("/runtime/actions.js");
    const {registerRemoteActions} = await import("/runtime/action-transport.js");
    const registry = new ActionRegistry();
    await registerRemoteActions(registry, {base:local, network:"local"}, await (await fetch(local + "/agent-manifest.json")).json());
    return {size:registry.entries.size, issues:registry.discoveryIssues};
  }, local);
  assert.equal(denied.size, 0); assert.ok(denied.issues.length);
  await unapproved.close();
  cors = false;
  const blocked = await page.evaluate(async () => fixture.registry.execute([{entry:fixture.create,args:{name:"blocked",data:"{}"}}], async () => true, "blocked"));
  assert.equal(blocked[0].status, "unknown"); assert.equal(records.length, 3, "Failed preflight must prevent writes");
  console.log("PASS: discovery performs no writes; static catalogs; isolated external form; combined local API + remote form via bridge; real receipts/readback; constraints/drift/CORS/path guards.");
} finally {
  await browser?.close();
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  await rm(root, {recursive:true, force:true});
}
