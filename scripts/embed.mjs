import { readFile, writeFile, mkdir, stat, realpath, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { StaticNetwork } from "./static-network.mjs";

/** Install a static agent bundle and a reversible HTML mount without Python. */
export class Embed {
  static RUNTIME = fileURLToPath(new URL("../nsdeploy/runtime/", import.meta.url));
  static START = "<!-- nsdeploy:agent:start -->";
  static END = "<!-- nsdeploy:agent:end -->";
  static PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent</title><link rel="stylesheet" href="./runtime/widget-page.css"></head>
<body><main id="app"><div data-ns-slot="header"></div><div data-ns-slot="chat"></div>
<div data-ns-slot="agents"></div></main><script type="module" src="./runtime/widget-page.js"></script></body></html>
`;

  /** Parse CLI arguments and report actionable errors with their original cause. */
  static async main(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      entry: { type: "string" }, mode: { type: "string", default: "floating" },
      bundle: { type: "string" }, "dry-run": { type: "boolean" }, remove: { type: "boolean" },
      "mock-llm": { type: "boolean" }, help: { type: "boolean" },
    } });
    if (values.help) {
      console.info("node scripts/embed.mjs network.hocon WEBSITE_OR_HTML [--entry index.html] " +
        "[--mode floating|inline] [--bundle STATIC_DIR] [--dry-run] [--remove] [--mock-llm]");
      return;
    }
    if (positionals.length !== 2 || !["floating", "inline"].includes(values.mode)) {
      throw new Error("Supply a HOCON and website directory or .html file; mode must be floating or inline. See --help.");
    }
    await Embed.install(positionals[0], positionals[1], values);
  }

  /** Validate all inputs before changing the selected HTML file or managed assets. */
  static async install(hocon, website, options = {}) {
    const target = await realpath(website);
    const directory = (await stat(target)).isDirectory();
    const root = directory ? target : path.dirname(target);
    const entry = directory ? path.resolve(root, options.entry || "index.html") : target;
    if (!entry.startsWith(root + path.sep) || !/\.html?$/i.test(entry) || await realpath(entry) !== entry) {
      throw new Error("Entry must be an ordinary HTML file inside the website directory, without symlinks.");
    }
    const html = await readFile(entry, "utf8");
    const clean = Embed.remove_block(html);
    const insertion = Embed.body_end(clean);
    if (options.remove) {
      if (!options["dry-run"]) {
        await writeFile(entry, clean);
      }
      console.info("Removed the Agent mount. Generated assets are retained for other pages and recovery.");
      return;
    }
    const name = path.basename(hocon, path.extname(hocon));
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error("The HOCON filename must contain only letters, numbers, underscores and hyphens.");
    }
    const bundle = path.join(root, "assets", "nsdeploy", name);
    await Embed.safe_path(root, bundle);
    const files = new Map();
    let manifest;
    if (options.bundle) {
      const source = await realpath(options.bundle);
      manifest = JSON.parse(await readFile(path.join(source, "agent-manifest.json"), "utf8"));
      if (manifest.deployment?.mode !== "static" || manifest.deployment?.public_mcp_facade !== false) {
        throw new Error("--bundle must be an nsdeploy static bundle; hosted deployments are unsupported.");
      }
      if (manifest.networks?.[0]?.name !== name) {
        throw new Error("The bundle's primary network must match the HOCON filename.");
      }
      await Embed.collect(source, source, files);
      files.delete(".embed-files.json");
      if (!files.has("runtime/index.js")) {
        throw new Error("The static bundle is missing runtime/index.js.");
      }
    } else {
      const built = StaticNetwork.compile(await readFile(hocon, "utf8"), name, !!options["mock-llm"]);
      manifest = built.manifest;
      files.set(`${name}.network.json`, Buffer.from(JSON.stringify(built.config, null, 2)));
      files.set("links.json", Buffer.from(JSON.stringify({ version: 1, networks: { [name]: built.config.links || {} } })));
      await Embed.collect(Embed.RUNTIME, Embed.RUNTIME, files, "runtime/");
      if (built.omitted.length) {
        console.warn(`Static bundle omits Python tools: ${built.omitted.join(", ")}`);
      }
      // Surface validation warnings before writing a public deployment.
      for (const warning of built.warnings) {
        console.warn(warning);
      }
    }
    files.set("agent-manifest.json", Buffer.from(JSON.stringify(manifest, null, 2)));
    // The compact surface is independent of a bundle's full-page theme.
    for (const filename of ["widget.js", "widget-page.js", "widget-page.css"]) {
      files.set(`runtime/${filename}`, await readFile(path.join(Embed.RUNTIME, filename)));
    }
    files.set("widget.html", Buffer.from(Embed.PAGE));
    if (!files.has("index.html")) {
      files.set("index.html", Buffer.from(Embed.PAGE));
    }
    const relative = path.relative(path.dirname(entry), bundle).split(path.sep).map(encodeURIComponent).join("/");
    const snippet = `${Embed.START}\n<nsdeploy-widget mode="${options.mode || "floating"}" ` +
      `src="${relative}/widget.html"></nsdeploy-widget>\n` +
      `<script type="module" src="${relative}/runtime/widget.js"></script>\n${Embed.END}\n`;
    const result = clean.slice(0, insertion) + snippet + clean.slice(insertion);
    await Embed.check_owned(bundle, files);
    if (options["dry-run"]) {
      console.info(`Would install ${files.size} static files in ${bundle} and add Agent to ${entry}`);
      return;
    }
    await mkdir(bundle, { recursive: true });
    const hashes = {};
    // Only files verified as owned by this installer can be replaced.
    for (const [filename, contents] of files) {
      const destination = path.join(bundle, filename);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents);
      hashes[filename] = Embed.hash(contents);
    }
    await writeFile(path.join(bundle, ".embed-files.json"), JSON.stringify(hashes, null, 2));
    await writeFile(entry, result);
    console.info(`Installed Agent (${options.mode || "floating"}) in ${entry}. Serve ${root} over HTTP(S).`);
    console.info("BYOK calls go directly to the selected provider, which must allow browser CORS. No Python server runs.");
  }

  /** Find a real closing body tag, ignoring comments and script/style strings. */
  static body_end(html) {
    if (/<base\b/i.test(html)) {
      throw new Error("Pages with a <base> element need a manually placed snippet with explicit asset URLs.");
    }
    const tokens = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>"']*(?:"[^"]*"|'[^']*'|[^>"']*)*>/gi;
    let found = -1;
    // Match actual HTML tags rather than closing-body text inside JavaScript or comments.
    for (const match of html.matchAll(tokens)) {
      if (/^<\/body\s*>$/i.test(match[0])) {
        if (found !== -1) {
          throw new Error("Ambiguous HTML: multiple closing body tags.");
        }
        found = match.index;
      }
    }
    if (found === -1) {
      throw new Error("No closing </body> found. Supply built HTML or add a mount to your framework's layout manually.");
    }
    return found;
  }

  /** Remove exactly one installer block, preserving all surrounding bytes. */
  static remove_block(html) {
    const start = html.indexOf(Embed.START);
    const end = html.indexOf(Embed.END);
    if (start === -1 && end === -1) {
      return html;
    }
    if (start === -1 || end < start || html.indexOf(Embed.START, start + 1) !== -1
        || html.indexOf(Embed.END, end + 1) !== -1) {
      throw new Error("Agent markers are incomplete or duplicated; repair them before installing.");
    }
    const after = end + Embed.END.length;
    return html.slice(0, start) + html.slice(after + (html[after] === "\n" ? 1 : 0));
  }

  /** Reject symlink ancestors so assets cannot escape the selected website. */
  static async safe_path(root, destination) {
    let current = destination;
    while (current !== root) {
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`Refusing symlink asset path: ${current}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      current = path.dirname(current);
    }
  }

  /** Read only regular assets; refuse symlinks rather than copying outside content. */
  static async collect(root, directory, files, prefix = "") {
    // Traverse the explicit bundle, retaining relative import paths.
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Bundle contains a symlink: ${filename}`);
      }
      if (entry.isDirectory()) {
        await Embed.collect(root, filename, files, prefix);
      } else if (entry.isFile()) {
        files.set(prefix + path.relative(root, filename).split(path.sep).join("/"), await readFile(filename));
      }
    }
  }

  /** Refuse overwriting preexisting assets or edits made since an earlier install. */
  static async check_owned(bundle, files) {
    let owned;
    try {
      await stat(bundle);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    try {
      owned = JSON.parse(await readFile(path.join(bundle, ".embed-files.json"), "utf8"));
    } catch (error) {
      throw new Error(`Asset directory is not managed by embed: ${bundle}`, { cause: error });
    }
    const existing = new Map();
    await Embed.collect(bundle, bundle, existing);
    // Preserve designer edits and reject unexpected files instead of replacing them.
    for (const [filename, contents] of existing) {
      if (filename !== ".embed-files.json" && (owned[filename] !== Embed.hash(contents) || !files.has(filename))) {
        throw new Error(`Agent asset has changed or is no longer generated: ${filename}. Preserve it before rebuilding.`);
      }
    }
  }

  /** Fingerprint owned output to detect user edits during later installs. */
  static hash(contents) {
    return createHash("sha256").update(contents).digest("hex");
  }

  /** Fail visibly without swallowing the original diagnostic. */
  static fail(error) {
    console.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await Embed.main(process.argv.slice(2)).catch(Embed.fail);
}
