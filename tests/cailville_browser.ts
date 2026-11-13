// Drives the Cailville sites, the airline and the travel agency in headless Chromium,
// the way a person would: opens the map, then for each site sends its first sample
// query, approves each partner site the agent asks to contact, and waits for the run
// to finish. It then checks the site's execution trace, so a site only passes when its
// agents actually ran. Then it checks MCP on its own: that an agent's MCP tool call
// goes out and comes back, and that declining keeps anything from reaching an outside
// MCP server, while the site's own still work. It checks a turn while it runs: that
// the chat shows what the agents are doing, and that guidance the user sends steers
// it. Last, it checks what happens when the user cancels a link, links through the
// prompt, declines a contact, or has no key for a real router.
//
// It first builds the runtime from the TS package version runtime-build/package.json
// pins, running npm ci there if a different version is installed. Start Cailville
// first (see the README). The test starts the airline, the travel agency and the
// other examples itself.
//
//   npx playwright install chromium     # once
//   npm run test:cailville              # everything
//   npm run test:cailville -- 8091 8191 # just these ports
//   npm run test:cailville -- mcp       # just the MCP checks
//   npm run test:cailville -- live      # just the running-turn checks
//   npm run test:cailville -- scenarios # just the cancel, link, decline and no-key checks
//   HEADED=1 npm run test:cailville -- 8091  # watch it in a visible browser
//   TEST_REAL_LLM=1 npm run test:cailville -- 8191  # use $OPENAI_API_KEY and gpt-4o, not the mock
//
// Node runs this TypeScript directly, by stripping the types, so there's no build
// step. Screenshots go to .nsdeploy/cailville-browser-test/. Exits 1 if anything fails.

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium, type Browser, type Page } from "playwright";

interface Community {
  sites: { port: number }[];
}

interface Manifest {
  networks: { name: string; sample_queries?: string[] }[];
  llm_router?: { base_url?: string; byok_router?: string };
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
  url?: string;
  tool?: string;
  streamChunk?: string;
  state?: string;
  network?: string;
  agent?: string;
  mock?: boolean;
  preview?: string;
  error?: string;
  responsePreview?: string;
  reason?: string;
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
  // Guidance to send while the front man's first model call is still running.
  steer?: string;
  // The most agents one query may run. The site's limit is 24, as on main, but the mock
  // calls every tool, so on the mock the test lifts it to check every agent runs.
  agentLimit?: number;
  // Set a real router with no key for this tab, as a visitor who hasn't entered one.
  noKey?: boolean;
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
  mcpRequests: number;
  // To an MCP server outside the site: on another origin, or through the site's
  // /ext-mcp proxy to one.
  outsideMcpRequests: number;
  // Each text the chat's status line showed while the turn ran, and whether the line
  // was still there once the answer was.
  statusTexts: string[];
  statusLeft: boolean;
  // With answers.steer: whether it was sent during the model call, the steering
  // messages the chat shows, and the router requests that carried it.
  steered: boolean;
  steeringMessages: number;
  steeredRequests: number;
  // With answers.noKey: whether the chat asked for an API key after Send.
  keyPrompt: boolean;
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
// A real LLM run is on OpenAI for now, with gpt-4o to keep the cost down unless
// TEST_MODEL picks another. Other providers can get their own default here.
const MODEL = REAL_LLM ? process.env.TEST_MODEL || "gpt-4o" : process.env.TEST_MODEL;
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
  const requested = ARGS.filter((arg) => arg !== "scenarios" && arg !== "mcp" && arg !== "live");
  if (ARGS.length) return requested;
  // The local community.json once a site is added, as the launcher reads it, else the base.
  const active = path.join(ROOT, "cailville", "community.json");
  const file = existsSync(active) ? active : path.join(ROOT, "cailville", "community.base.json");
  const community: Community = JSON.parse(readFileSync(file, "utf8"));
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
// SIGINT, as Ctrl-C would, so each site also stops the MCP hosts it started.
process.on("exit", () => { for (const child of started) child.kill("SIGINT"); });
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
    // nsdeploy only runs on its mock LLM with --mock-llm. A real LLM run uses the BYOK router.
    if (!REAL_LLM) args.push("--mock-llm");
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
async function runPage(browser: Browser, port: string, answers: Answers, label = ""): Promise<Run> {
  const base = `http://127.0.0.1:${port}`;
  const manifest: Manifest = await (await fetch(`${base}/agent-manifest.json`)).json();
  const network = manifest.networks[0];
  const query = (network.sample_queries || [])[0] || "What can you help me with?";

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // The page reads key, router and model from the setup applied in this tab, never the URL.
  if (REAL_LLM || MODEL || answers.noKey) {
    const setup = {
      key: answers.noKey ? "" : REAL_LLM ? process.env.OPENAI_API_KEY || "" : "",
      router: answers.noKey ? manifest.llm_router?.byok_router || "" : "",
      model: MODEL || "",
    };
    await page.addInitScript((value) => {
      sessionStorage.setItem("nsweb-byok-tab-key", value.key);
      sessionStorage.setItem("nsweb-byok-router", value.router);
      sessionStorage.setItem("nsweb-byok-model", value.model);
    }, setup);
  }
  const agentLimit = answers.agentLimit ?? (REAL_LLM ? undefined : 1000);
  if (agentLimit != null) await page.addInitScript((value) => { (window as any).__nsdeployMaxAgentCalls = value; }, agentLimit);
  const run: Run = {
    seconds: 0, events: [], errors: [], links: [], approvals: 0, declines: 0, finished: false, routerRequests: 0, mcpRequests: 0,
    outsideMcpRequests: 0, statusTexts: [], statusLeft: false, steered: false, steeringMessages: 0, steeredRequests: 0,
    keyPrompt: false,
  };
  // Every text the status line shows, however briefly.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as any).__statusTexts = seen;
    new MutationObserver(() => {
      const text = document.querySelector(".ns-turn-status-text")?.textContent || "";
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  // With answers.steer, the router holds the first model call until the guidance is
  // sent, so it arrives while that call runs.
  let held: () => void = () => {};
  const firstCall = new Promise<void>((resolve) => { held = resolve; });
  let release: () => void = () => {};
  const steeringSent = new Promise<void>((resolve) => { release = resolve; });
  if (answers.steer) {
    // With a real key the page uses the site's BYOK router instead of the mock.
    const router = new URL((REAL_LLM ? manifest.llm_router?.byok_router : manifest.llm_router?.base_url) || `${base}/v1`, base);
    let calls = 0;
    await page.route(`${router.origin}${router.pathname.replace(/\/$/, "")}/responses`, async (route) => {
      if ((route.request().postData() || "").includes(answers.steer!)) run.steeredRequests += 1;
      if (++calls === 1) {
        held();
        await steeringSent;
      }
      // The held call is cancelled by the steering, so continuing it can fail.
      await route.continue().catch(() => {});
    });
  }
  page.on("pageerror", (error) => run.errors.push(String(error)));
  page.on("console", (message) => {
    // A visible browser also asks for /favicon.ico, which the sites don't have.
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) {
      run.errors.push("console: " + message.text());
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/byok/")) run.routerRequests += 1;
    if (url.pathname.endsWith("/mcp")) {
      run.mcpRequests += 1;
      if (url.origin !== base || url.pathname.startsWith("/ext-mcp/")) run.outsideMcpRequests += 1;
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      run.errors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  const started = Date.now();
  try {
    await page.goto(`${base}/`);
    await page.waitForSelector("#ns-input", { timeout: 30000 });
    await page.fill("#ns-input", query);
    await page.click("#ns-send");
    if (answers.steer) {
      await Promise.race([firstCall, page.waitForTimeout(30000)]);
      // While the turn runs, the same input and button send guidance to it.
      await page.fill("#ns-input", answers.steer);
      await page.click("#ns-send");
      run.steered = true;
      release();
    }
    if (answers.noKey) {
      // The chat asks for a key instead of starting a run, so there is no run to wait for.
      const prompt = page.locator(".ns-msg.bot", { hasText: "add an AI provider key" }).last();
      run.keyPrompt = await prompt.waitFor({ timeout: 10000 }).then(() => true, () => false);
      await page.waitForTimeout(2000);
      run.finished = true;
    } else {
      await answerPrompts(page, answers, run);
    }
    run.events = await readTrace(page);
    run.statusTexts = await page.evaluate(() => (window as any).__statusTexts || []);
    run.statusLeft = (await page.locator(".ns-turn-status").count()) > 0;
    run.steeringMessages = await page.locator('.ns-steering-message[data-input-kind="steering"]').count();
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
    // A model call the user's steering cancelled ends "steered", which is no error.
    if (event.phase === "end" && event.status !== "ok" && event.status !== "steered") {
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

// The travel agent system has both kinds of MCP tool: its own coded tools, hosted
// as MCP servers, and You.com's MCP server, reached through the site's proxy.
const MCP_SITE = "8120";

// MCP on its own, with the mock LLM, which calls every tool. Allowing the calls has to
// send them and get answers back. Declining has to keep the page from contacting any
// MCP server, discovery included, while the run still finishes.
async function checkMcp(browser: Browser): Promise<Result[]> {
  const results: Result[] = [];
  const add = (name: string, run: Run, problems: string[]) =>
    results.push({ name, summary: `${String(run.seconds).padStart(4)}s mcp=${run.mcpRequests} requests`, errors: problems });
  const calls = (run: Run) => ended(run, "mcp_call");

  let run = await runPage(browser, MCP_SITE, { consent: "always" }, "mcp");
  let problems = basicProblems(run);
  if (!calls(run).length) problems.push("no MCP tool call finished");
  if (!calls(run).some((event) => (event.responsePreview || "").trim())) problems.push("no MCP tool call returned anything");
  // An MCP server can send notifications ahead of a tool's result (You.com sends a log
  // line with each one), and those show as the tool's progress.
  const outsideCalls = calls(run).filter((event) => !(event.url || "").startsWith(`http://127.0.0.1:${MCP_SITE}/_mcp/`));
  if (outsideCalls.length && !run.events.some((event) => event.kind === "tool_progress")) {
    problems.push("an outside MCP server's notifications didn't show as tool progress");
  }
  add("call an MCP tool", run, problems);

  // Only an MCP server outside the site needs consent. The site's own, under /_mcp,
  // are part of the page the user chose.
  run = await runPage(browser, MCP_SITE, { consent: "decline" }, "mcp-decline");
  problems = basicProblems(run);
  const outside = (event: TraceEvent) =>
    event.kind === "mcp_call" && !(event.url || "").startsWith(`http://127.0.0.1:${MCP_SITE}/_mcp/`);
  if (!run.declines) problems.push("never asked before contacting an outside MCP server");
  if (run.outsideMcpRequests) problems.push(`sent ${run.outsideMcpRequests} requests to outside MCP servers after they were declined`);
  if (run.events.some(outside)) problems.push("made an outside MCP tool call after it was declined");
  if (!calls(run).some((event) => !outside(event))) problems.push("the site's own MCP tools didn't run");
  add("decline an MCP call", run, problems);
  return results;
}

// What should happen when the user doesn't go along with the agent. These run on the
// mock only, after the sites, and the two link checks need the open link travel agency
// fresh, in this order, since linking it saves the link on the site.
// A running turn, on the travel agent system: the chat shows a status line while the
// agents work and drops it for the answer, the trace has the answer's text as it
// streamed, and guidance sent while the front man's first model call runs replaces
// that call with one that includes it.
async function checkLiveTurn(browser: Browser): Promise<Result[]> {
  const steer = "Keep the whole trip under 2000 dollars.";
  const run = await runPage(browser, MCP_SITE, { consent: "always", steer }, "live");
  const summary = `${String(run.seconds).padStart(4)}s status=${run.statusTexts.length} steered=${run.steeredRequests}`;
  const shown = basicProblems(run);
  if (!run.statusTexts.length) shown.push("the status line never showed while the agents worked");
  if (run.statusLeft) shown.push("the status line was still there after the answer");
  if (!run.events.some((event) => event.kind === "model_call" && event.phase === "update" && event.streamChunk)) {
    shown.push("no model call's text streamed into the trace");
  }
  // The mock calls every tool; a real model may answer without one.
  if (!REAL_LLM && !run.events.some((event) => event.kind === "tool" && event.phase === "start")) {
    shown.push("no tool call showed in the trace");
  }
  const steering: string[] = [];
  const notes = run.events.filter((event) => event.kind === "steering");
  if (!run.steered) steering.push("the first model call never started, so nothing was steered");
  if (run.steeringMessages !== 1) steering.push(`the chat shows ${run.steeringMessages} steering messages, not 1`);
  if (!notes.some((event) => event.state === "received")) steering.push("the trace never got the steering");
  if (!notes.some((event) => event.state === "applied")) steering.push("the steering was never applied");
  if (!run.steeredRequests) steering.push("no model call after the steering included it");
  if (!run.events.some((event) => event.kind === "model_call" && event.status === "steered")) {
    steering.push("the running model call wasn't cancelled for the steering");
  }
  return [
    { name: "show what's happening during a turn", summary, errors: shown },
    { name: "steer a running turn", summary, errors: steering },
  ];
}

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

  // At the site's own limit of 24 agents, a Cailville query stops calling agents and
  // still finishes, as on main.
  run = await runPage(browser, "8091", { consent: "always", agentLimit: 24 }, "agent-limit");
  problems = basicProblems(run);
  const agents = run.events.filter((event) => event.kind === "agent" && event.phase === "start").length;
  if (agents > 24) problems.push(`ran ${agents} agents, over the limit of 24`);
  if (!run.events.some((event) => event.kind === "composition_limit" && (event.reason || "").includes("limit of 24 agent"))) {
    problems.push("never reached the limit of 24 agents");
  }
  add("stop at the agent limit", run, problems);

  // A real router with no key: the chat asks for a key, no run starts, and nothing
  // reaches the router.
  run = await runPage(browser, "8192", { consent: "always", noKey: true }, "no-key");
  problems = run.errors.filter((error) => !error.startsWith("console:"));
  if (!run.keyPrompt) problems.push("the chat never asked for an API key");
  if (run.events.some((event) => event.kind === "run")) problems.push("a run started without a key");
  if (run.routerRequests) problems.push(`sent ${run.routerRequests} requests to the router without a key`);
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
const mcp = (!ARGS.length || ARGS.includes("mcp")) && !REAL_LLM;
// The running-turn checks also run on a real model, since steering has to work there.
const live = !ARGS.length || ARGS.includes("live");
await startExamples([...ports, ...(mcp || live ? [MCP_SITE] : []), ...(scenarios ? ["8191", "8192", "8193"] : [])]);
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
if (mcp) for (const result of await checkMcp(browser)) report(result);
if (live) for (const result of await checkLiveTurn(browser)) report(result);
if (scenarios) for (const result of await checkScenarios(browser)) report(result);
await browser.close();

if (results[0].errors.length) console.log(`FAIL map: ${results[0].errors.join("; ")}`);
const failed = results.filter((result) => result.errors.length).length;
console.log(failed ? `\n${failed} of ${results.length} failed.` : `\nAll ${results.length} passed.`);
process.exit(failed ? 1 : 0);
