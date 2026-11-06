import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Embed } from "../scripts/embed.mjs";

/** Exercise the installed widget in a real browser against a plain static server. */
class TestEmbedBrowser {
  /** Serve the temporary website with no application or Python backend. */
  static async serve(root, request, response) {
    try {
      const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const filename = path.resolve(root, "." + (requested.endsWith("/") ? requested + "index.html" : requested));
      if (!filename.startsWith(root + path.sep)) {
        throw new Error("Invalid path");
      }
      const contents = await readFile(filename);
      const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
        ".json": "application/json", ".css": "text/css" };
      response.writeHead(200, { "Content-Type": types[path.extname(filename)] || "text/plain" });
      response.end(contents);
    } catch (error) {
      response.writeHead(404);
      response.end(error.message);
    }
  }

  /** Collect browser exceptions independently from assertions. */
  static record_error(errors, error) { errors.push(error.message); }

  /** Return a deterministic provider response to test the real CRUSE rendering path. */
  static response() {
    return Promise.resolve({ content: 'Here are the details.\n```cruse-ui\n' + JSON.stringify({
      version: 1, components: [{ id: "visit", kind: "form", title: "Plan your visit",
        schema: { type: "object", properties: { name: { type: "string", title: "Your name" } } } }],
    }) + '\n```', toolCalls: [] });
  }

  /** Install deterministic model behavior without changing the production widget. */
  static inject_model(source) {
    window.__nsweb.engine.top.llm.chat = new Function(`return function ${source}`)();
  }

  /** Measure iframe layout using its own viewport. */
  static fits() {
    const input = document.querySelector(".ns-inputbar").getBoundingClientRect();
    return input.bottom <= innerHeight + 1 && input.top >= 0
      && document.documentElement.scrollWidth <= innerWidth;
  }

  /** Open, chat, collapse, dismiss and resize the real generated widget. */
  static async run() {
    const { chromium } = await import(process.env.NSDEPLOY_PLAYWRIGHT_MODULE || "playwright");
    const root = await mkdtemp(path.join(os.tmpdir(), "nsdeploy-widget-browser-"));
    const hocon = path.join(root, "concierge.hocon");
    await writeFile(hocon, 'tools=[{name="concierge", instructions="Help visitors", tools=[]}]');
    await copyFile("examples/widget/index.html", path.join(root, "index.html"));
    await Embed.install(hocon, root, { "mock-llm": true });
    await mkdir(path.join(root, "inline"));
    await copyFile("examples/widget/index.html", path.join(root, "inline/index.html"));
    await Embed.install(hocon, path.join(root, "inline"), { mode: "inline", "mock-llm": true });
    await mkdir(path.join(root, "byok"));
    await copyFile("examples/widget/index.html", path.join(root, "byok/index.html"));
    await Embed.install(hocon, path.join(root, "byok"));
    const server = createServer(TestEmbedBrowser.serve.bind(null, root));
    await new Promise(TestEmbedBrowser.listen.bind(null, server));
    const browser = await chromium.launch({ headless: true,
      ...(process.env.NSDEPLOY_CHROME ? { executablePath: process.env.NSDEPLOY_CHROME } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on("pageerror", TestEmbedBrowser.record_error.bind(null, errors));
      await page.route("https://api.openai.com/**", TestEmbedBrowser.provider);
      const base = `http://127.0.0.1:${server.address().port}`;
      await page.goto(base);
      assert.equal(await page.locator("nsdeploy-widget iframe").count(), 0, "runtime loads only on open");
      await page.getByRole("button", { name: "Explore the neighborhood" }).click();
      assert.equal(await page.getByRole("button", { name: "Website button still works" }).count(), 1);
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      const frame = page.frameLocator("nsdeploy-widget iframe");
      await frame.locator("#ns-input").fill("Hello");
      await frame.getByRole("button", { name: "Send", exact: true }).click();
      await frame.locator(".ns-msg.bot").nth(1).waitFor();
      await frame.locator("#ns-input").fill("Keep this draft");
      await page.getByRole("button", { name: "Close Agent", exact: true }).click();
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      assert.equal(await frame.locator("#ns-input").inputValue(), "Keep this draft");
      assert.equal(await frame.locator(".ns-msg.bot").count(), 2);
      const actual = page.frames().find(TestEmbedBrowser.widget_frame);
      await actual.evaluate(TestEmbedBrowser.inject_model, TestEmbedBrowser.response.toString());
      await frame.getByRole("button", { name: "Send", exact: true }).click();
      await frame.getByText("Plan your visit", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(root, "desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await actual.evaluate(TestEmbedBrowser.settle);
      await actual.evaluate(TestEmbedBrowser.settle);
      assert.equal(await actual.evaluate(TestEmbedBrowser.fits), true, "mobile controls fit");
      await page.screenshot({ path: path.join(root, "mobile.png") });
      await frame.locator("#ns-input").press("Escape");
      await page.getByRole("button", { name: "Agent", exact: true }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Hide Agent for this session" }).click();
      await page.reload();
      assert.equal(await page.getByRole("button", { name: "Agent", exact: true }).isVisible(), false);
      await page.goto(base + "/inline/");
      await frame.locator("#ns-input").waitFor();
      assert.equal(await page.locator("nsdeploy-widget").getAttribute("mode"), "inline");
      await page.goto(base + "/byok/");
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      await frame.getByText("API key required", { exact: true }).waitFor();
      assert.equal(await frame.locator("#ns-key").isVisible(), true);
      await frame.locator("#ns-key").fill("test-only-not-a-real-key");
      await frame.locator("#ns-model").fill("fixture-model");
      await frame.getByRole("button", { name: "Apply, save & reload" }).click();
      await frame.locator("#ns-key").waitFor({ state: "attached" });
      await frame.locator(".ns-llmbadge.pending").waitFor();
      assert.equal(page.url().includes("test-only"), false);
      assert.deepEqual(errors, []);
      console.info("PASS: lazy load, host isolation, chat, CRUSE, retained state, Escape, dismissal, mobile, inline, BYOK.");
      console.info(`Screenshots: ${root}/desktop.png and ${root}/mobile.png`);
    } finally {
      await browser.close();
      server.close();
    }
  }

  /** Identify the installed frame for in-frame assertions. */
  static widget_frame(frame) { return frame.url().endsWith("/widget.html"); }

  /** Allow viewport resizing to paint before capturing the mobile layout. */
  static settle() { return new Promise(requestAnimationFrame); }

  /** Resolve startup only when the local server is listening. */
  static listen(server, resolve, reject) {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }

  /** Answer model discovery locally so the BYOK test never contacts a provider. */
  static async provider(route) {
    await route.fulfill({ json: { data: [{ id: "fixture-model" }] } });
  }
}

await TestEmbedBrowser.run();
