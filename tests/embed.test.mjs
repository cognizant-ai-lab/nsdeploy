import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Embed } from "../scripts/embed.mjs";
import { StaticNetwork } from "../scripts/static-network.mjs";

/** Exercise real installs, validation and reversibility using temporary websites. */
class TestEmbed {
  static HOCON = 'tools=[{name="concierge", instructions="Help visitors", tools=[]}]';
  static HTML = '<!doctype html><html><body><script>const example="</body>";</script><h1>Host</h1></body></html>';

  /** Create a disposable website and matching self-contained HOCON. */
  static async fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "nsdeploy-embed-"));
    const hocon = path.join(root, "concierge.hocon");
    await writeFile(hocon, TestEmbed.HOCON);
    await writeFile(path.join(root, "index.html"), TestEmbed.HTML);
    return { root, hocon, entry: path.join(root, "index.html") };
  }

  /** A repeat install is identical and removal restores the exact original bytes. */
  static async roundtrip() {
    const { root, hocon, entry } = await TestEmbed.fixture();
    await Embed.install(hocon, root);
    const first = await readFile(entry, "utf8");
    assert.ok(first.indexOf(Embed.START) > first.indexOf("<h1>Host</h1>"));
    assert.match(first, /mode="floating"/);
    await Embed.install(hocon, root);
    assert.equal(await readFile(entry, "utf8"), first);
    const bundle = path.join(root, "assets/nsdeploy/concierge");
    const manifest = JSON.parse(await readFile(path.join(bundle, "agent-manifest.json"), "utf8"));
    assert.equal(manifest.deployment.mode, "static");
    assert.equal(manifest.llm_router.mock, false);
    assert.equal(manifest.deployment.public_mcp_facade, false);
    await Embed.install(hocon, root, { remove: true });
    assert.equal(await readFile(entry, "utf8"), TestEmbed.HTML);
    assert.ok((await readdir(bundle)).includes("widget.html"));
  }

  /** Dry runs write nothing, including when configuration is invalid. */
  static async dry_run() {
    const { root, hocon, entry } = await TestEmbed.fixture();
    await Embed.install(hocon, entry, { "dry-run": true });
    assert.deepEqual((await readdir(root)).sort(), ["concierge.hocon", "index.html"]);
    await writeFile(hocon, "include \"other.conf\"");
    await assert.rejects(Embed.install(hocon, root), /self-contained/);
    assert.equal(await readFile(entry, "utf8"), TestEmbed.HTML);
  }

  /** Asset collisions, designer modifications and symlink escapes fail before HTML changes. */
  static async protect_assets() {
    const { root, hocon, entry } = await TestEmbed.fixture();
    await Embed.install(hocon, root);
    const original = await readFile(entry, "utf8");
    const asset = path.join(root, "assets/nsdeploy/concierge/widget.html");
    await writeFile(asset, "Designer changes");
    await assert.rejects(Embed.install(hocon, root), /asset has changed/);
    assert.equal(await readFile(asset, "utf8"), "Designer changes");
    assert.equal(await readFile(entry, "utf8"), original);
    const second = await TestEmbed.fixture();
    await symlink(root, path.join(second.root, "assets"));
    await assert.rejects(Embed.install(second.hocon, second.root), /symlink/);
    const third = await TestEmbed.fixture();
    await mkdir(path.join(third.root, "assets/nsdeploy/concierge"), { recursive: true });
    await assert.rejects(Embed.install(third.hocon, third.root), /not managed/);
  }

  /** Nested HTML resolves assets beside the selected webroot and can use inline mode. */
  static async nested_entry() {
    const { root, hocon } = await TestEmbed.fixture();
    await mkdir(path.join(root, "pages"));
    await writeFile(path.join(root, "pages/visit.html"), TestEmbed.HTML);
    await Embed.install(hocon, root, { entry: "pages/visit.html", mode: "inline" });
    const html = await readFile(path.join(root, "pages/visit.html"), "utf8");
    assert.match(html, /mode="inline"/);
    assert.match(html, /src="\.\.\/assets\/nsdeploy\/concierge\/widget.html"/);
    assert.throws(TestEmbed.bad_markers, /markers/);
    assert.throws(TestEmbed.no_body, /closing/);
    assert.throws(TestEmbed.base_tag, /base/);
  }

  /** Supply incomplete markers to the reversible editor. */
  static bad_markers() { Embed.remove_block(Embed.START + "content"); }
  /** Supply a framework component rather than HTML. */
  static no_body() { Embed.body_end("<App />"); }
  /** Supply a base URL whose asset resolution needs explicit configuration. */
  static base_tag() { Embed.body_end('<base href="/elsewhere/"><body></body>'); }

  /** Reuse only static bundles and preserve their full-page entry and network. */
  static async existing_bundle() {
    const source = await TestEmbed.fixture();
    await Embed.install(source.hocon, source.root, { "mock-llm": true });
    const bundle = path.join(source.root, "assets/nsdeploy/concierge");
    const target = await TestEmbed.fixture();
    await Embed.install(target.hocon, target.root, { bundle });
    const manifest_path = path.join(bundle, "agent-manifest.json");
    const manifest = JSON.parse(await readFile(manifest_path, "utf8"));
    manifest.deployment.mode = "hosted";
    await writeFile(manifest_path, JSON.stringify(manifest));
    await assert.rejects(Embed.install(target.hocon, target.root, { bundle }), /static bundle/);
  }

  /** Python definitions are omitted explicitly and unresolved references stay linkable. */
  static network() {
    const hocon = 'tools=[{name="root",instructions="Help",tools=["python", "peer"]},' +
      '{name="python",class="tools.Example"}]';
    const result = StaticNetwork.compile(hocon, "sample");
    assert.deepEqual(result.omitted, ["python"]);
    assert.deepEqual(result.config.tools[0].tools, ["peer"]);
    assert.deepEqual(result.config.link_slots.peer.callers, ["root"]);
    assert.equal(result.config.cruse.version, 1);
  }
}

test("embed is static, idempotent and reversible", TestEmbed.roundtrip);
test("dry run and unsupported HOCON leave no changes", TestEmbed.dry_run);
test("protect modified assets, collisions and symlinks", TestEmbed.protect_assets);
test("nested entry, inline mount and malformed HTML", TestEmbed.nested_entry);
test("reuse existing static bundles; reject hosted bundles", TestEmbed.existing_bundle);
test("report omitted Python tools and retain peer links", TestEmbed.network);
