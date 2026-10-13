// Drives the Cailville sites and the link demo examples in headless Chromium, the way
// a person would: opens the map, then for each site sends its first sample query,
// approves each partner site the agent asks to contact, and waits for the run to
// finish. It then checks the site's execution trace, so a site only passes when its
// agents actually ran.
//
// Start Cailville first (see the README). The test starts the examples itself.
//
//   npx playwright install chromium     # once
//   npm run test:cailville              # Cailville and the examples
//   npm run test:cailville -- 8091 8191 # just these ports
//   HEADED=1 npm run test:cailville -- 8091  # watch it in a visible browser
//   TEST_REAL_LLM=1 npm run test:cailville -- 8191  # use $OPENAI_API_KEY, not the mock
//
// Node runs this TypeScript directly, by stripping the types, so there's no build
// step. Screenshots go to .nsdeploy/cailville-browser-test/. Exits 1 if any site
// fails a check.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

interface Community {
  sites: { port: number }[];
}

interface Manifest {
  networks: { name: string; sample_queries?: string[] }[];
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
}

interface Example {
  hocon: string;
  port: number;
  args: string[];
  // Sites this one has to call, by port, so a link that doesn't work fails.
  peers: string[];
}

interface Prompts {
  approvals: number;
  links: string[];
  finished: boolean;
}

interface SiteResult {
  site: string;
  seconds?: number;
  agents?: number;
  partners?: number;
  mcp?: number;
  approvals?: number;
  errors: string[];
}

const ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR: string = path.join(ROOT, ".nsdeploy", "cailville-browser-test");
const MAP_FILE: string = path.join(ROOT, "cailville", "cailville.html");
const REAL_LLM = Boolean(process.env.TEST_REAL_LLM);
const SITE_TIMEOUT_MS = REAL_LLM ? 600000 : 180000;

// The link demo pair, linked with --link the way the README does it, and the travel
// agent system with its hosted MCP tools.
const EXAMPLES: Example[] = [
  { hocon: "link_demo_airline.hocon", port: 8192, args: [], peers: [] },
  {
    hocon: "link_demo_travel_agency.hocon", port: 8191,
    args: ["--link", "link_demo_airline=http://127.0.0.1:8192/link_demo_airline"], peers: ["8192"],
  },
  { hocon: "travel_agent_system.hocon", port: 8120, args: [], peers: [] },
];

// The MCP client's optional stream GET, which the facade doesn't offer.
function expected(error: string): boolean {
  return /405 GET .*\/(ext-)?mcp/.test(error) || error.includes("status of 405");
}

function sitePorts(): string[] {
  const requested = process.argv.slice(2);
  if (requested.length) return requested;
  const community: Community = JSON.parse(readFileSync(path.join(ROOT, "cailville", "community.json"), "utf8"));
  return [...community.sites.map((site) => String(site.port)), ...EXAMPLES.map((example) => String(example.port))];
}

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/agent-manifest.json`)).ok;
  } catch {
    return false;
  }
}

// Starts each requested example that isn't already running, the same way the
// README does, and waits for it to serve its manifest.
async function startExamples(ports: string[]): Promise<ChildProcess[]> {
  const venv = [".venv", "venv"].map((dir) => path.join(ROOT, dir, "bin", "python")).find((p) => existsSync(p));
  const python = venv || "python3";
  const started: ChildProcess[] = [];
  for (const example of EXAMPLES.filter((e) => ports.includes(String(e.port)))) {
    if (await isUp(example.port)) continue;
    const name = path.basename(example.hocon, ".hocon");
    const args = ["-m", "nsdeploy", path.join("examples", example.hocon), "--port", String(example.port),
                  "--out", path.join(".nsdeploy", name), ...example.args];
    started.push(spawn(python, args, { cwd: ROOT, stdio: "ignore" }));
    const deadline = Date.now() + 120000;
    while (!(await isUp(example.port))) {
      if (Date.now() > deadline) throw new Error(`${name} did not start on :${example.port}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return started;
}

async function checkMap(browser: Browser): Promise<SiteResult> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto("file://" + MAP_FILE);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT_DIR, "map.png") });
  await page.close();
  return { site: "map", errors };
}

function readTrace(page: Page): Promise<TraceEvent[]> {
  return page.evaluate(() => (window as any).__nsweb.trace.export().events);
}

// Each second, answers whatever the agent is asking, until the run ends. Every site
// here defines or links all of its agents, so a link prompt is a failure. The test
// cancels it to let the run finish.
async function answerPrompts(page: Page): Promise<Prompts> {
  const allow = page.getByRole("button", { name: "Always allow" });
  const cancelLink = page.locator(".ns-linker-form").getByRole("button", { name: "Cancel" });
  const prompts: Prompts = { approvals: 0, links: [], finished: false };
  const deadline = Date.now() + SITE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (await cancelLink.count()) {
      prompts.links.push(await page.locator(".ns-linker:has(button.ghost) .ns-linker-title").first().innerText());
      await cancelLink.first().click().catch(() => {});
      continue;
    }
    if (await allow.count()) {
      await allow.first().click().catch(() => {});
      prompts.approvals += 1;
      continue;
    }
    if ((await readTrace(page)).some((event) => event.kind === "run" && event.phase === "end")) {
      prompts.finished = true;
      return prompts;
    }
  }
  return prompts;
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

function checkTrace(events: TraceEvent[], origin: string, network: string, config: NetworkConfig,
                    peers: string[]): string[] {
  const problems: string[] = [];
  for (const event of events) {
    if (event.phase === "end" && event.status !== "ok") {
      problems.push(`${event.kind} ${event.agent || event.network || ""} ended ${event.status}`);
    }
  }
  const modelCalls = events.filter((event) => event.kind === "model_call" && event.phase === "end");
  if (REAL_LLM && modelCalls.some((event) => event.mock)) problems.push("a model call used the mock LLM");
  if (!REAL_LLM) {
    const ran = new Set(events.filter((event) => event.kind === "agent" && event.origin === origin
                                               && event.network === network).map((event) => event.agent));
    const skipped = reachableAgents(config).filter((name) => !ran.has(name));
    if (skipped.length) problems.push(`agents that never ran: ${skipped.join(", ")}`);
  }
  const called = new Set(events.filter((event) => event.kind === "remote_call" && event.phase === "end"
                                                  && event.status === "ok")
                               .map((event) => event.peerOrigin?.split(":")[1]));
  for (const peer of peers) if (!called.has(peer)) problems.push(`never called the site on :${peer}`);
  return problems;
}

async function checkSite(browser: Browser, port: string): Promise<SiteResult> {
  const base = `http://127.0.0.1:${port}`;
  const manifest: Manifest = await (await fetch(`${base}/agent-manifest.json`)).json();
  const network = manifest.networks[0];
  const config: NetworkConfig = await (await fetch(`${base}/${network.name}.network.json`)).json();
  const query = (network.sample_queries || [])[0] || "What can you help me with?";
  const peers = EXAMPLES.find((example) => String(example.port) === port)?.peers || [];

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  if (REAL_LLM) {
    const key = process.env.OPENAI_API_KEY || "";
    await page.addInitScript((value) => sessionStorage.setItem("nsweb-byok-key", value), key);
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    // A visible browser also asks for /favicon.ico, which the sites don't have.
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) {
      errors.push("console: " + message.text());
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const started = Date.now();
  let prompts: Prompts = { approvals: 0, links: [], finished: false };
  let events: TraceEvent[] = [];
  try {
    const model = process.env.TEST_MODEL ? `?model=${encodeURIComponent(process.env.TEST_MODEL)}` : "";
    await page.goto(base + "/" + model);
    await page.waitForSelector("#ns-input", { timeout: 30000 });
    await page.fill("#ns-input", query);
    await page.click("#ns-send");
    prompts = await answerPrompts(page);
    events = await readTrace(page);
  } catch (error) {
    errors.push(String(error).split("\n")[0]);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${network.name}.png`) });
  await page.close();

  const problems = errors.filter((error) => !expected(error));
  if (!prompts.finished) problems.push(`the run didn't finish within ${SITE_TIMEOUT_MS / 1000}s`);
  for (const link of prompts.links) problems.push(`asked to ${link}, but every agent here is defined or linked`);
  problems.push(...checkTrace(events, `127.0.0.1:${port}`, network.name, config, peers));
  const starts = (kind: string) => events.filter((event) => event.kind === kind && event.phase === "start");
  return {
    site: `${network.name} :${port}`,
    seconds: Math.round((Date.now() - started) / 1000),
    agents: starts("agent").length,
    partners: new Set(starts("remote_call").map((event) => event.peerOrigin)).size,
    mcp: starts("mcp_call").length,
    approvals: prompts.approvals,
    errors: problems,
  };
}

if (REAL_LLM && !process.env.OPENAI_API_KEY) {
  console.log("TEST_REAL_LLM needs OPENAI_API_KEY.");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });
const ports = sitePorts();
const examples = await startExamples(ports);
// HEADED=1 opens a visible browser and slows each step down enough to follow.
const headed = Boolean(process.env.HEADED);
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 250 : 0 });
const results: SiteResult[] = [await checkMap(browser)];
for (const port of ports) {
  const result = await checkSite(browser, port);
  results.push(result);
  const status = result.errors.length ? "FAIL" : "ok  ";
  console.log(`${status} ${result.site.padEnd(32)} ${String(result.seconds).padStart(4)}s ` +
              `agents=${result.agents} partners=${result.partners} mcp=${result.mcp} approvals=${result.approvals}`);
  for (const error of result.errors) console.log(`     ${error.slice(0, 200)}`);
}
await browser.close();
for (const child of examples) child.kill();

if (results[0].errors.length) console.log(`FAIL map: ${results[0].errors.join("; ")}`);
const failed = results.filter((result) => result.errors.length).length;
console.log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} passed.`);
process.exit(failed ? 1 : 0);
