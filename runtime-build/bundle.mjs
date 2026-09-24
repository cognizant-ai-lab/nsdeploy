// Bundles @cognizant-ai-lab/neuro-san-npm (the real neuro-san sources transpiled to
// TypeScript) for the browser into one file, nsdeploy/runtime/generated/neuro-san.mjs
// (see neuro-san.mjs for what it exports). The output is committed with the rest of
// the vendored runtime, so a deployed site needs no build step or node_modules. Run
// `npm install && npm run build` here after updating the package.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const generated = path.resolve(root, "..", "nsdeploy", "runtime", "generated");

const shims = path.join(root, "browser-shims");

// Node builtins and the package's Python bridge, swapped for browser stand-ins.
// See build/browser-shims/README.md.
const NODE_BUILTINS = /^(node:)?(fs|fs\/promises|path|os|crypto|child_process|module|url|process|stream|async_hooks|events|util|http|https|net|tls|zlib|string_decoder|readline|worker_threads|perf_hooks)$/;
const SHIMMED = {
  fs: "fs.mjs", "fs/promises": "fs.mjs", path: "path.mjs", url: "url.mjs",
  async_hooks: "async_hooks.mjs", module: "module.mjs", stream: "stream.mjs",
};
const browserShims = {
  name: "browser-shims",
  setup(b) {
    b.onResolve({ filter: NODE_BUILTINS }, (args) => {
      const bare = args.path.replace(/^node:/, "");
      return { path: path.join(shims, SHIMMED[bare] || "empty.mjs") };
    });
    b.onResolve({ filter: /stubs\/pyhocon\.js$/ }, () => ({ path: path.join(shims, "pyhocon.mjs") }));
    b.onResolve({ filter: /^cross-spawn$/ }, () => ({ path: path.join(shims, "cross-spawn.mjs") }));
    // Buffer has a standard browser implementation, the `buffer` package.
    b.onResolve({ filter: /^node:buffer$/ }, () => b.resolve("buffer", { resolveDir: root, kind: "import-statement" }));
    // Optional tracing integrations the package imports dynamically and never
    // reaches without their configuration.
    b.onResolve({ filter: /^(langfuse|opentelemetry|langchain_core)(\/.*)?$/ }, () => ({ path: path.join(shims, "empty.mjs") }));
  },
};

// Spots in the package's transpiled output that are rewritten as the bundle is built:
// JavaScript esbuild refuses to bundle (Node only fails if the line runs), and a stub
// that does not behave as python does. The package on disk is not touched.
// PORT BACK: fix each in the transpiling source.
const SOURCE_PATCHES = [
  {
    // The importlib stub searches a developer's own checkouts (absolute paths under a
    // home directory) for a require() root. A browser has no filesystem to search, and
    // those paths would be published in the committed bundle, so only process.cwd()
    // is kept.
    file: /stubs\/importlib\.js$/,
    from: /(const roots = \[\s*process\.cwd\(\),)[^\]]*\]/,
    to: "$1\n    ]",
  },
  {
    // python's dict(x) copies a dict, and the transpile represents every python dict
    // as a plain object, but the stub's callable dict() is pythonlib's `new Map(x)`,
    // which throws for a plain object. Five package files call dict(x), among them
    // BaseToolFactory.create_function_tool, so no external agent could become a tool.
    file: /stubs\/pythonlib_gaps\.js$/,
    from: "export const dict = Object.assign((entries) => pythonlib_dict(entries), pythonlib_dict, {",
    to: "export const dict = Object.assign((entries) => (entries == null ? {}"
      + " : entries instanceof Map || typeof entries[Symbol.iterator] === \"function\""
      + " ? Object.fromEntries(entries) : { ...entries }), pythonlib_dict, {",
  },
  {
    // python: SlyDataRedactor(parent_spec, config_keys=[...]). The keyword argument
    // became a trailing object in the positional config_keys slot, so redacting the
    // sly_data sent to an external agent threw and every partner call failed.
    // allow_empty_dict keeps its python default, True.
    file: /external_activation_prepper\.js$/,
    from: 'new SlyDataRedactor(parent_spec, { config_keys: ["allow.sly_data", "allow.to_downstream.sly_data"] })',
    to: 'new SlyDataRedactor(parent_spec, ["allow.sly_data", "allow.to_downstream.sly_data"], true)',
  },
  {
    // python: `async for chat_response in chat_responses`. Transpiled as a plain
    // for...of over an async generator, which throws before the external agent runs.
    file: /activations\/external_activation\.js$/,
    from: "for (const chat_response of chat_responses) {",
    to: "for await (const chat_response of chat_responses) {",
  },
  {
    // python: `with suppress(Exception): await chat_responses.aclose()`. A JS async
    // generator closes with return(), and the transpiled suppress() suppresses
    // nothing, so the missing aclose() replaced whatever error the loop had raised.
    file: /activations\/external_activation\.js$/,
    from: "await chat_responses.aclose();",
    to: "await chat_responses.return?.().catch?.(() => {});",
  },
  {
    // python: copy(self) keeps the class. `{ ...this }` is a plain object without the
    // SessionInvocationContext methods, so a direct session built on the copy fails
    // (get_toolbox_factory is not a function). It is the package's only `{ ...this }`.
    file: /session_invocation_context\.js$/,
    from: "let invocation_context = { ...this };",
    to: "let invocation_context = Object.assign(Object.create(Object.getPrototypeOf(this)), this);",
  },
  {
    // parse_tool_output checks isinstance(..., tuple) but the file never imports tuple,
    // so handing any tool result back to the calling agent throws.
    file: /core\/langchain_run_context\.js$/,
    from: 'import { at, isinstance, iter, slice, sorted, string } from "pythonlib";',
    to: 'import { at, isinstance, iter, slice, sorted, string, tuple } from "pythonlib";',
  },
  {
    // python calls LangChainRun with keywords (tool_message=..., invocation=...), which
    // the transpile turns into a trailing object in whatever positional slot comes
    // next: submit_tool_outputs passes { tool_message } as tool_name, so every tool
    // result reaches the calling agent as null. The constructor binds a trailing
    // keyword object here the way python binds keywords. Only the last argument is
    // read this way, and only when all its keys are this constructor's parameters.
    file: /core\/langchain_run\.js$/,
    from: "    constructor(run_id_base, chat_history, tool_name, args, tool_message, invocation) {\n        super();",
    to: "    constructor(...positional) {\n        super();\n"
      + "        const names = [\"run_id_base\", \"chat_history\", \"tool_name\", \"args\", \"tool_message\", \"invocation\"];\n"
      + "        const last = positional[positional.length - 1];\n"
      + "        const bound = {};\n"
      + "        if (positional.length > 2 && last != null && Object.getPrototypeOf(last) === Object.prototype\n"
      + "            && Object.keys(last).length > 0 && Object.keys(last).every((key) => names.indexOf(key) >= positional.length - 1)) {\n"
      + "            Object.assign(bound, positional.pop());\n"
      + "        }\n"
      + "        names.forEach((name, i) => { if (!(name in bound)) bound[name] = positional[i]; });\n"
      + "        const { run_id_base, chat_history, tool_name, args, tool_message, invocation } = bound;",
  },
  {
    // _arun reassigns the kwargs it declared const (_run declares it the same way).
    file: /langchain_openai_function_tool\.js$/,
    from: /const kwargs = args.length > 0/g,
    to: "let kwargs = args.length > 0",
  },
  {
    // Assigning to a namespace import (python's sys.stdout = ...). A browser has no
    // stdout to reroute, so the rerouting is dropped.
    file: /stream_to_logger\.js$/,
    from: /sys\.(stdout|stderr) = \w+;/g,
    to: "/* browser: no $1 to reroute */",
  },
];
const classAttributes = path.join(shims, "class-attributes.mjs");
const EXPORTED_CLASS = /^export class (\w+)(?:\s+extends\s+[\w.$]+)?\s*\{/gm;

// Every JS file of the package passes through here: the SOURCE_PATCHES that apply
// to it, then python class-attribute semantics for the classes it exports (see
// browser-shims/class-attributes.mjs).
const packageTransforms = {
  name: "package-transforms",
  setup(b) {
    b.onLoad({ filter: /neuro-san-npm\/dist\/.*\.js$/ }, async (args) => {
      let text = await fs.readFile(args.path, "utf8");
      for (const p of SOURCE_PATCHES.filter((patch) => patch.file.test(args.path))) {
        const before = text;
        text = text.replace(p.from, p.to);
        if (text === before) throw new Error(`source patch no longer applies to ${args.path}: ${p.from}`);
      }
      const classes = [...text.matchAll(EXPORTED_CLASS)].map((m) => m[1]);
      if (classes.length) {
        text += `\nimport { exposeClassAttributes as __exposeClassAttributes } from ${JSON.stringify(classAttributes)};\n`
          + classes.map((name) => `__exposeClassAttributes(${name});`).join("\n") + "\n";
      }
      return { contents: text, loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

await build({
  entryPoints: [path.join(root, "neuro-san.mjs")],
  outfile: path.join(generated, "neuro-san.mjs"),
  inject: [path.join(shims, "process.mjs"), path.join(shims, "buffer.mjs")],
  loader: { ".hocon": "text" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  // DEBUG=1 npm run build: unminified with source maps, for tracing a browser error
  // back to the package file it came from. Commit the default (minified) build.
  minify: !process.env.DEBUG,
  // The transpiled code checks types by class name (pythonlib_gaps isinstance walks
  // constructor names), which minified names would break.
  keepNames: true,
  sourcemap: process.env.DEBUG ? "inline" : false,
  // `global` is Node's name for globalThis, which some CommonJS dependencies read.
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  legalComments: "none",
  logLevel: "info",
  plugins: [browserShims, packageTransforms],
});

console.log("bundled -> nsdeploy/runtime/generated/neuro-san.mjs");
