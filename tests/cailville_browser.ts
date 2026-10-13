// Drives the Cailville sites, the airline and the travel agency in headless Chromium,
// the way a person would: opens the map, then for each site sends its first sample
// query, approves each partner site the agent asks to contact, and waits for the run
// to finish. It then checks the site's execution trace, so a site only passes when its
// agents actually ran. Last, it checks what happens when the user cancels a link,
// links through the prompt, declines a contact, or has no key for a real router.
//
// It first builds the runtime from the TS package version runtime-build/package.json
// pins, running npm ci there if a different version is installed. Start Cailville
// first (see the README). The test starts the airline, the travel agency and the
// other examples itself.
//
//   npx playwright install chromium     # once
//   npm run test:cailville              # everything
//   npm run test:cailville -- 8091 8191 # just these ports
//   npm run test:cailville -- scenarios # just the cancel, link, decline and no-key checks
//   HEADED=1 npm run test:cailville -- 8091  # watch it in a visible browser
//   TEST_REAL_LLM=1 npm run test:cailville -- 8191  # use $OPENAI_API_KEY, not the mock
//
// Node runs this TypeScript directly, by stripping the types, so there's no build
// step. Screenshots go to .nsdeploy/cailville-browser-test/. Exits 1 if anything fails.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

interface Community {
  sites: { port: number }[];
}

interface Manifest {
  networks: { name: string; sample_queries?: string[] }[];
  llm_router?: { byok_router?: string };
}

interface NetworkConfig {
  tools: { name: string; instructions?: string; tools?: unknown[] }[];
}

interface TraceEvent {
  phase: string;
  kind: string;
  status?: string;
  origin?: string;
  peerOrigin?: string;
  network?: string;
  agent?: string;
  mock?: boolean;
  preview?: string;
  error?: string;
}

interface Example {
  hocon: string;
  port: number;
  args: string[];
  // Sites this one has to call, by port, so a link that doesn't work fails.
  peers: string[];
  // Started fresh on every run, since a link entered in the browser is saved on the site.
  fresh?: boolean;
}

// How the test answers the prompts on a page. A link prompt is a failure unless the
// page sets link, to a URL or to "cancel".
interface Answers {
  link?: string;
  consent: "always" | "decline";
}

interface Run {
  seconds: number;
  events: TraceEvent[];
  errors: string[];
  links: string[];
  approvals: number;
  declines: number;
  finished: boolean;
  routerRequests: number;
}

interface Result {
  name: string;
  summary: string;
  errors: string[];
}

const ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_BUILD: string = path.join(ROOT, "runtime-build");
const PACKAGE = "@cognizant-ai-lab/neuro-san-ts-package";
const OUT_DIR: string = path.join(ROOT, ".nsdeploy", "cailville-browser-test");
const MAP_FILE: string = path.join(ROOT, "cailville", "cailville.html");
const REAL_LLM = Boolean(process.env.TEST_REAL_LLM);
const SITE_TIMEOUT_MS = REAL_LLM ? 600000 : 180000;
const AIRLINE = "http://127.0.0.1:8192";

// The airline, the travel agency linked to it with --link the way the README does it,
// the travel agent system with its hosted MCP tools, and a travel agency that doesn't
// define the airline, so the browser asks for a link.
const EXAMPLES: Example[] = [
  { hocon: "examples/link_demo_airline.hocon", port: 8192, args: [], peers: [] },
  {
    hocon: "examples/link_demo_travel_agency.hocon", port: 8191,
    args: ["--link", `link_demo_airline=${AIRLINE}/link_demo_airline`], peers: ["8192"],
  },
  { hocon: "examples/travel_agent_system.hocon", port: 8120, args: [], peers: [] },
  { hocon: "tests/fixtures/open_link_travel_agency.hocon", port: 8193, args: [], peers: [], fresh: true },
];

// Installs what runtime-build/package.json and its lock pin if npm ls says the
// installed package doesn't match, then builds the runtime the sites serve from it.
// Returns the installed version.
function buildRuntime(): string {
  const installed = (): { ok: boolean; version: string } => {
    try {
      const out = execFileSync("npm", ["ls", PACKAGE, "--json"], { cwd: RUNTIME_BUILD, encoding: "utf8" });
      return { ok: true, version: JSON.parse(out).dependencies?.[PACKAGE]?.version || "" };
    } catch {
      return { ok: false, version: "" };
    }
  };
  if (!installed().ok) {
    console.log(`Installing ${PACKAGE} with npm ci. GitHub Packages needs NODE_AUTH_TOKEN.`);
    execFileSync("npm", ["ci"], { cwd: RUNTIME_BUILD, stdio: "inherit" });
  }
  execFileSync("npm", ["run", "build"], { cwd: RUNTIME_BUILD, stdio: "ignore" });
  return installed().version;
}

// The MCP client's optional stream GET, which the facade doesn't offer.
function expected(error: string): boolean {
  return /405 GET .*\/(ext-)?mcp/.test(error) || error.includes("status of 405");
}

const ARGS = process.argv.slice(2);

function sitePorts(): string[] {
  const requested = ARGS.filter((arg) => arg !== "scenarios");
  if (ARGS.length) return requested;
  const community: Community = JSON.parse(readFileSync(path.join(ROOT, "cailville", "community.json"), "utf8"));
  const examples = EXAMPLES.filter((example) => !example.fresh).map((example) => String(example.port));
  return [...community.sites.map((site) => String(site.port)), ...examples];
}

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/agent-manifest.json`)).ok;
  } catch {
    return false;
  }
}

// Starts each example the run needs that isn't already running, including the sites
// a requested example calls, the same way the README does, and waits for it to serve
// its manifest.
const started: ChildProcess[] = [];
// Stop the examples this run started however it ends, including Ctrl-C.
process.on("exit", () => { for (const child of started) child.kill(); });
process.on("SIGINT", () => process.exit(130));

async function startExamples(requested: string[]): Promise<void> {
  const ports = [...requested];
  for (const example of EXAMPLES) if (requested.includes(String(example.port))) ports.push(...example.peers);
  const venv = [".venv", "venv"].map((dir) => path.join(ROOT, dir, "bin", "python")).find((p) => existsSync(p));
  const python = venv || "python3";
  for (const example of EXAMPLES.filter((e) => ports.includes(String(e.port)))) {
    const name = path.basename(example.hocon, ".hocon");
    if (await isUp(example.port)) {
      if (example.fresh) throw new Error(`Stop whatever is on :${example.port}, the test needs it for ${name}.`);
      continue;
    }
    const args = ["-m", "nsdeploy", example.hocon, "--port", String(example.port), ...example.args];
    if (example.fresh) {
      // The built site and its editable source both go under the test's own folder,
      // emptied first, so no link saved by an earlier run is left.
      const out = path.join(OUT_DIR, name);
      const source = path.join(OUT_DIR, `${name}-source`);
      for (const dir of [out, source]) rmSync(dir, { recursive: true, force: true });
      args.push("--out", out, "--site-dir", source);
    } else {
      args.push("--out", path.join(".nsdeploy", name));
    }
    started.push(spawn(python, args, { cwd: ROOT, stdio: "ignore" }));
    const deadline = Date.now() + 120000;
    while (!(await isUp(example.port))) {
      if (Date.now() > deadline) throw new Error(`${name} did not start on :${example.port}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function checkMap(browser: Browser): Promise<Result> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("file://" + MAP_FILE);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, "map.png") });
  await page.close();
  return { name: "map", summary: "", errors };
}

function readTrace(page: Page): Promise<TraceEvent[]> {
  return page.evaluate(() => (window as any).__nsweb.trace.export().events);
}

// Each second, answers whatever the agent is asking, until the run ends.
async function answerPrompts(page: Page, answers: Answers, run: Run): Promise<void> {
  const consent = page.getByRole("button", { name: answers.consent === "always" ? "Always allow" : "Decline" });
  const linkForm = page.locator(".ns-linker-form:has(button.ghost)");
  const deadline = Date.now() + SITE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (await linkForm.count()) {
      run.links.push(await page.locator(".ns-linker:has(button.ghost) .ns-linker-title").first().innerText());
      if (answers.link && answers.link !== "cancel") {
        await linkForm.first().locator("input").fill(answers.link);
        await linkForm.first().getByRole("button", { name: "Link" }).click().catch(() => {});
      } else {
        await linkForm.first().getByRole("button", { name: "Cancel" }).click().catch(() => {});
      }
      continue;
    }
    if (await consent.count()) {
      await consent.first().click().catch(() => {});
      if (answers.consent === "always") run.approvals += 1;
      else run.declines += 1;
      continue;
    }
    if ((await readTrace(page)).some((event) => event.kind === "run" && event.phase === "end")) {
      run.finished = true;
      return;
    }
  }
}

// Opens a site, sends a query, answers the prompts and returns what happened.
async function runPage(browser: Browser, port: string, answers: Answers, label = "", search = ""): Promise<Run> {
  const base = `http://127.0.0.1:${port}`;
  const manifest: Manifest = await (await fetch(`${base}/agent-manifest.json`)).json();
  const network = manifest.networks[0];
  const query = (network.sample_queries || [])[0] || "What can you help me with?";

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (REAL_LLM) {
    await page.addInitScript((value) => sessionStorage.setItem("nsweb-byok-key", value), process.env.OPENAI_API_KEY || "");
  }
  const run: Run = {
    seconds: 0, events: [], errors: [], links: [], approvals: 0, declines: 0, finished: false, routerRequests: 0,
  };
  page.on("pageerror", (error) => run.errors.push(String(error)));
  page.on("console", (message) => {
    // A visible browser also asks for /favicon.ico, which the sites don't have.
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) {
      run.errors.push("console: " + message.text());
    }
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/byok/")) run.routerRequests += 1;
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      run.errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const started = Date.now();
  try {
    const params = new URLSearchParams(search);
    if (process.env.TEST_MODEL) params.set("model", process.env.TEST_MODEL);
    await page.goto(`${base}/${params.size ? "?" + params : ""}`);
    await page.waitForSelector("#ns-input", { timeout: 30000 });
    await page.fill("#ns-input", query);
    await page.click("#ns-send");
    await answerPrompts(page, answers, run);
    run.events = await readTrace(page);
  } catch (error) {
    run.errors.push(String(error).split("\n")[0]);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${network.name}${label ? "-" + label : ""}.png`) });
  await page.close();
  run.seconds = Math.round((Date.now() - started) / 1000);
  run.errors = run.errors.filter((error) => !expected(error));
  return run;
}

// The agents the front man can reach in this network. The mock LLM calls every tool,
// so on the mock each of these has to run. The front man is the agent no other agent
// calls.
function reachableAgents(config: NetworkConfig): string[] {
  const byName = new Map(config.tools.map((tool) => [tool.name, tool]));
  const called = new Set(config.tools.flatMap((tool) => tool.tools || []));
  const seen = new Set<string>();
  const queue = config.tools.filter((tool) => tool.instructions && !called.has(tool.name)).map((tool) => tool.name);
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name) || !byName.get(name)?.instructions) continue;
    seen.add(name);
    for (const ref of byName.get(name)?.tools || []) if (typeof ref === "string") queue.push(ref);
  }
  return [...seen];
}

const ended = (run: Run, kind: string) => run.events.filter((event) => event.kind === kind && event.phase === "end");
const calledPorts = (run: Run) => new Set(ended(run, "remote_call").filter((event) => event.status === "ok")
                                                                 .map((event) => event.peerOrigin?.split(":")[1]));
const toolResults = (run: Run) => run.events.filter((event) => event.kind === "tool_result").map((event) => event.preview || "");

// Problems shared by every check: errors on the page, an unfinished run, and a trace
// step that ended in an error.
function basicProblems(run: Run): string[] {
  const problems = [...run.errors];
  if (!run.finished) problems.push(`the run didn't finish within ${SITE_TIMEOUT_MS / 1000}s`);
  for (const event of run.events) {
    if (event.phase === "end" && event.status !== "ok") {
      problems.push(`${event.kind} ${event.agent || event.network || ""} ended ${event.status}`);
    }
  }
  return problems;
}

async function checkSite(browser: Browser, port: string): Promise<Result> {
  const base = `http://127.0.0.1:${port}`;
  const manifest: Manifest = await (await fetch(`${base}/agent-manifest.json`)).json();
  const network = manifest.networks[0];
  const config: NetworkConfig = await (await fetch(`${base}/${network.name}.network.json`)).json();
  const peers = EXAMPLES.find((example) => String(example.port) === port)?.peers || [];
  const run = await runPage(browser, port, { consent: "always" });

  const problems = basicProblems(run);
  // Every agent on these sites is defined or linked, so none should ask for a link.
  for (const link of run.links) problems.push(`asked to ${link}, but every agent here is defined or linked`);
  if (REAL_LLM && ended(run, "model_call").some((event) => event.mock)) problems.push("a model call used the mock LLM");
  if (!REAL_LLM) {
    const ran = new Set(run.events.filter((event) => event.kind === "agent" && event.origin === `127.0.0.1:${port}`
                                                     && event.network === network.name).map((event) => event.agent));
    const skipped = reachableAgents(config).filter((name) => !ran.has(name));
    if (skipped.length) problems.push(`agents that never ran: ${skipped.join(", ")}`);
  }
  for (const peer of peers) if (!calledPorts(run).has(peer)) problems.push(`never called the site on :${peer}`);

  const starts = (kind: string) => run.events.filter((event) => event.kind === kind && event.phase === "start");
  const partners = new Set(starts("remote_call").map((event) => event.peerOrigin)).size;
  return {
    name: `${network.name} :${port}`,
    summary: `${String(run.seconds).padStart(4)}s agents=${starts("agent").length} partners=${partners} ` +
             `mcp=${starts("mcp_call").length} approvals=${run.approvals}`,
    errors: problems,
  };
}

// What should happen when the user doesn't go along with the agent. These run on the
// mock only, after the sites, and the two link checks need the open link travel agency
// fresh, in this order, since linking it saves the link on the site.
async function checkScenarios(browser: Browser): Promise<Result[]> {
  const results: Result[] = [];
  const add = (name: string, run: Run, problems: string[]) =>
    results.push({ name, summary: `${String(run.seconds).padStart(4)}s`, errors: problems });

  let run = await runPage(browser, "8193", { link: "cancel", consent: "always" }, "cancel");
  let problems = basicProblems(run);
  if (run.links.length !== 1) problems.push(`expected one link prompt, got ${run.links.length}`);
  if (!toolResults(run).some((text) => text.includes("did not link 'link_demo_airline'"))) {
    problems.push("the agent wasn't told the airline wasn't linked");
  }
  if (calledPorts(run).size) problems.push("called a partner after the link was cancelled");
  add("cancel a link", run, problems);

  run = await runPage(browser, "8193", { link: AIRLINE, consent: "always" }, "link");
  problems = basicProblems(run);
  if (run.links.length !== 1) problems.push(`expected one link prompt, got ${run.links.length}`);
  if (!calledPorts(run).has("8192")) problems.push("never called the airline after linking it");
  add("link through the prompt", run, problems);

  run = await runPage(browser, "8191", { consent: "decline" }, "decline");
  problems = basicProblems(run);
  if (!run.declines) problems.push("never asked to contact the airline");
  if (calledPorts(run).size) problems.push("called the airline after the contact was declined");
  if (!toolResults(run).some((text) => text.includes("declined to contact"))) {
    problems.push("the agent wasn't told the contact was declined");
  }
  add("decline a contact", run, problems);

  // A real router with no key: nothing may reach the router, and the run ends with an
  // error that tells the user to add a key.
  const byok = (await (await fetch(`${AIRLINE}/agent-manifest.json`)).json() as Manifest).llm_router?.byok_router || "";
  run = await runPage(browser, "8192", { consent: "always" }, "no-key", `router=${encodeURIComponent(byok)}`);
  problems = run.errors.filter((error) => !error.startsWith("console:"));
  if (!run.finished) problems.push("the run didn't end");
  if (run.routerRequests) problems.push(`sent ${run.routerRequests} requests to the router without a key`);
  const runEnd = ended(run, "run")[0];
  if (runEnd?.status !== "error" || !String(runEnd.error || "").includes("needs your API key")) {
    problems.push(`expected the run to end asking for a key, got ${runEnd?.status} ${runEnd?.error || ""}`.trim());
  }
  add("no key for a real router", run, problems);
  return results;
}

if (REAL_LLM && !process.env.OPENAI_API_KEY) {
  console.log("TEST_REAL_LLM needs OPENAI_API_KEY.");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });
console.log(`Testing ${PACKAGE} ${buildRuntime()}, as runtime-build pins it.`);
const ports = sitePorts();
const scenarios = (!ARGS.length || ARGS.includes("scenarios")) && !REAL_LLM;
await startExamples(scenarios ? [...ports, "8191", "8192", "8193"] : ports);
// HEADED=1 opens a visible browser and slows each step down enough to follow.
const headed = Boolean(process.env.HEADED);
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 250 : 0 });
const results: Result[] = [await checkMap(browser)];
const report = (result: Result) => {
  results.push(result);
  console.log(`${result.errors.length ? "FAIL" : "ok  "} ${result.name.padEnd(36)} ${result.summary}`);
  for (const error of result.errors) console.log(`     ${error.slice(0, 200)}`);
};
for (const port of ports) report(await checkSite(browser, port));
if (scenarios) for (const result of await checkScenarios(browser)) report(result);
await browser.close();

if (results[0].errors.length) console.log(`FAIL map: ${results[0].errors.join("; ")}`);
const failed = results.filter((result) => result.errors.length).length;
console.log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} passed.`);
process.exit(failed ? 1 : 0);
