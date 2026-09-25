// vite.config.mjs: builds @cognizant-ai-lab/neuro-san-npm (the real neuro-san sources
// transpiled to TypeScript) for the browser into nsdeploy/runtime/generated/. The
// output is committed with the rest of the runtime, so a deployed site needs no build
// step, and it is laid out to be read in review:
//   browser/     our code from runtime-build/, unminified: browser/neuro-san.mjs (the
//                entry the runtime imports), the kernel and session adapters, and
//                browser/shims.mjs (the Node stand-ins, see browser-shims/README.md)
//   neuro-san/   the package's own code, unminified, one file per area of the package
//                (graph, run_context, session, ...)
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

const classAttributes = path.join(shims, "class-attributes.mjs");
const EXPORTED_CLASS = /^export class (\w+)(?:\s+extends\s+[\w.$]+)?\s*\{/gm;

// Every JS file of the package passes through here, for python class-attribute
// semantics on the classes it exports (see browser-shims/class-attributes.mjs).
// Package files and our own are not tree-shaken,
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
// No two of these files may import each other, even through a third: the package's
// modules have no import cycles, but files that did would let a class run before the
// class it extends ("Cannot access 'X' before initialization"). So validation and
// reservations share run_context's file (their modules import each other), and the
// config filters, which validation imports, have a file of their own apart from graph.
const PACKAGE_AREAS = [
  [/\/dist\/src\//, "index"],
  [/\/dist\/data\//, "data"],
  [/\/dist\/stubs\//, "stubs"],
  [/\/generated\/leaf_common\//, "leaf_common"],
  [/\/neuro_san\/message\//, "message"],
  [/\/neuro_san\/(interfaces|internals\/interfaces)\//, "interfaces"],
  [/\/neuro_san\/internals\/(run_context|reservations|validation)\//, "run_context"],
  [/\/neuro_san\/internals\/graph\/filters\//, "filters"],
  [/\/neuro_san\/internals\/graph\//, "graph"],
  [/\/neuro_san\/(session|client|internals\/chat|internals\/network_providers)\//, "session"],
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
