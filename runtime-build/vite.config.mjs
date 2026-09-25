// vite.config.mjs: builds @cognizant-ai-lab/neuro-san-npm (the real neuro-san sources
// transpiled to TypeScript) for the browser into nsdeploy/runtime/generated/. The
// output is committed with the rest of the runtime, so a deployed site needs no build
// step, and it is laid out to be read in review:
//   browser/     our code from runtime-build/, unminified: browser/neuro-san.mjs (the
//                entry the runtime imports), the kernel and session adapters, and
//                browser/shims.mjs (the Node stand-ins, see browser-shims/README.md)
//   neuro-san/   the package's own code, unminified, one file per area of the package
//                (graph, run_context, session, ...), with the SOURCE_PATCHES below
//                applied in place
//   vendor/      third-party libraries (LangChain, the MCP SDK, pythonlib, ...), in one
//                minified file, pinned by package-lock.json
// Run `npm install && npm run build` here after updating the package. DEBUG=1 leaves
// vendor/ unminified and adds source maps, for tracing a browser error.

import { defineConfig, transformWithEsbuild } from "vite";
import inject from "@rollup/plugin-inject";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const root = path.dirname(fileURLToPath(import.meta.url));
const generated = path.resolve(root, "..", "nsdeploy", "runtime", "generated");
const shims = path.join(root, "browser-shims");
const DEBUG = !!process.env.DEBUG;
const RUNTIME_HOCON = "nsdeploy-runtime/hocon.js";

// --- browser stand-ins ---------------------------------------------------------------

// Node builtins and the package's Python bridge, swapped for browser stand-ins.
// See browser-shims/README.md.
const NODE_BUILTINS = /^(node:)?(fs|fs\/promises|path|os|crypto|child_process|module|url|process|stream|async_hooks|events|util|http|https|net|tls|zlib|string_decoder|readline|worker_threads|perf_hooks)$/;
const SHIMMED = {
  fs: "fs.mjs", "fs/promises": "fs.mjs", path: "path.mjs", url: "url.mjs",
  async_hooks: "async_hooks.mjs", module: "module.mjs", stream: "stream.mjs",
  child_process: "child_process.mjs",
};
const browserShims = {
  name: "browser-shims",
  enforce: "pre",
  async resolveId(source, importer) {
    if (NODE_BUILTINS.test(source)) {
      return path.join(shims, SHIMMED[source.replace(/^node:/, "")] || "empty.mjs");
    }
    if (/stubs\/pyhocon\.js$/.test(source)) return path.join(shims, "pyhocon.mjs");
    if (source === "cross-spawn") return path.join(shims, "cross-spawn.mjs");
    // Buffer has a standard browser implementation, the `buffer` package.
    if (source === "node:buffer") return this.resolve("buffer", importer, { skipSelf: true });
    // Optional tracing integrations the package imports dynamically and never reaches
    // without their configuration.
    if (/^(langfuse|opentelemetry|langchain_core)(\/.*)?$/.test(source)) return path.join(shims, "empty.mjs");
    // runtime/hocon.js (used by the pyhocon stand-in) is already served by the runtime,
    // so it stays a separate file; output.paths below says where it is from browser/.
    if (source.endsWith("/nsdeploy/runtime/hocon.js")) return { id: RUNTIME_HOCON, external: true };
    return null;
  },
  // The two packaged data files the loop reads, as text (see browser-shims/fs.mjs).
  async load(id) {
    if (!id.endsWith(".hocon")) return null;
    return `export default ${JSON.stringify(await fs.readFile(id, "utf8"))};`;
  },
};

// --- package transforms ----------------------------------------------------------------

// Spots in the package's transpiled output that are rewritten as the bundle is built:
// JavaScript a bundler refuses to parse (Node only fails if the line runs), and a stub
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

// Every JS file of the package passes through here: the SOURCE_PATCHES that apply to
// it, then python class-attribute semantics for the classes it exports (see
// browser-shims/class-attributes.mjs). Package files and our own are not tree-shaken,
// so each output file holds the whole of every module in it, as in the package.
const packageTransforms = {
  name: "package-transforms",
  enforce: "pre",
  async transform(code, id) {
    const ours = id.startsWith(root + path.sep) && !id.includes(`${path.sep}node_modules${path.sep}`);
    if (!/neuro-san-npm\/dist\/.*\.js$/.test(id)) {
      return ours ? { code, moduleSideEffects: "no-treeshake" } : null;
    }
    let text = code;
    for (const p of SOURCE_PATCHES.filter((patch) => patch.file.test(id))) {
      const before = text;
      text = text.replace(p.from, p.to);
      if (text === before) throw new Error(`source patch no longer applies to ${id}: ${p.from}`);
    }
    const classes = [...text.matchAll(EXPORTED_CLASS)].map((m) => m[1]);
    if (classes.length) {
      text += `\nimport { exposeClassAttributes as __exposeClassAttributes } from ${JSON.stringify(classAttributes)};\n`
        + classes.map((name) => `__exposeClassAttributes(${name});`).join("\n") + "\n";
    }
    return { code: text, map: null, moduleSideEffects: "no-treeshake" };
  },
};

// --- output layout -----------------------------------------------------------------------

// Areas of the package, each one output file under neuro-san/. The first match wins.
const PACKAGE_AREAS = [
  [/\/dist\/data\//, "data"],
  [/\/dist\/stubs\//, "stubs"],
  [/\/generated\/leaf_common\//, "leaf_common"],
  [/\/neuro_san\/internals\/run_context\//, "run_context"],
  [/\/neuro_san\/internals\/graph\//, "graph"],
  [/\/neuro_san\/internals\/validation\//, "validation"],
  [/\/neuro_san\/message\//, "message"],
  [/\/neuro_san\/(session|client)\//, "session"],
  [/\/generated\/neuro_san\//, "internals"],
];

function chunkFor(id) {
  if (id.includes("neuro-san-npm/dist/")) {
    const area = PACKAGE_AREAS.find(([pattern]) => pattern.test(id));
    return `neuro-san/${area[1]}`;
  }
  // The process stand-in has no imports, and every module that names `process` (vendor
  // code included) imports it, so it is a file of its own to keep that import acyclic.
  if (id === path.join(shims, "process.mjs")) return "browser/process";
  if (id.startsWith(shims + path.sep)) return "browser/shims";
  if (id.startsWith(root + path.sep) && !id.includes(`${path.sep}node_modules${path.sep}`)) {
    return `browser/${path.basename(id).replace(/\.m?js$/, "")}`;
  }
  // Third-party code, one minified file. Split further, the libraries import each other
  // in cycles, and a cycle between output files can run one before the other is ready.
  return "vendor/libraries";
}

// Minify vendor/ only. Class names are kept: the transpiled code checks types by class
// name (pythonlib_gaps isinstance walks constructor names).
const minifyVendor = {
  name: "minify-vendor",
  async renderChunk(code, chunk) {
    if (DEBUG || !chunk.fileName.startsWith("vendor/")) return null;
    const result = await transformWithEsbuild(code, chunk.fileName, {
      minify: true, keepNames: true, format: "esm", target: "es2022", legalComments: "none",
    });
    return { code: result.code, map: null };
  },
};

export default defineConfig({
  root,
  publicDir: false,
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [
    browserShims,
    packageTransforms,
    // Node globals, as imports of the stand-ins, in every module that names them. It
    // runs after Vite converts CommonJS dependencies, so it sees them as ES modules.
    { ...inject({
      exclude: [path.join(shims, "process.mjs")],
      process: [path.join(shims, "process.mjs"), "process"],
      Buffer: ["buffer", "Buffer"],
      global: [path.join(shims, "process.mjs"), "globalObject"],
    }), enforce: "post" },
    minifyVendor,
  ],
  build: {
    outDir: generated,
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    sourcemap: DEBUG ? "inline" : false,
    reportCompressedSize: false,
    lib: {
      entry: path.join(root, "neuro-san.mjs"),
      formats: ["es"],
      fileName: () => "browser/neuro-san.mjs",
    },
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      output: {
        manualChunks: chunkFor,
        chunkFileNames: "[name].mjs",
        // Real names on the imports between files, so a reviewer can follow them.
        minifyInternalExports: false,
        // Only browser/shims.mjs imports it, from generated/browser/.
        paths: { [RUNTIME_HOCON]: "../../hocon.js" },
      },
    },
  },
});
