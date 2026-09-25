import { parseHocon } from "../../hocon.js";
import { toolboxInfo, defaultLlmInfo } from "../neuro-san/data.mjs";
function unavailable() {
  throw new Error("running subprocesses is not available in the browser");
}
const spawn$1 = unavailable;
const spawnSync = unavailable;
const exec = unavailable;
const execSync = unavailable;
const execFile = unavailable;
const execFileSync = unavailable;
const child_process = { spawn: spawn$1, spawnSync, exec, execSync, execFile, execFileSync };
const SKIP = /* @__PURE__ */ new Set(["length", "name", "prototype", "caller", "arguments"]);
function exposeClassAttributes(cls) {
  if (typeof cls !== "function" || !cls.prototype) return;
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (SKIP.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(cls, key);
    if (!descriptor || typeof descriptor.value === "function" || descriptor.get) continue;
    if (Object.prototype.hasOwnProperty.call(cls.prototype, key)) continue;
    Object.defineProperty(cls.prototype, key, {
      configurable: true,
      get() {
        return cls[key];
      },
      set(value) {
        Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true });
      }
    });
  }
}
const sep = "/";
function normalizeParts(parts, absolute) {
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  return out;
}
function normalize(p) {
  const absolute = p.startsWith("/");
  const joined = normalizeParts(p.split("/"), absolute).join("/");
  return (absolute ? "/" : "") + joined || (absolute ? "/" : ".");
}
function join(...parts) {
  return normalize(parts.filter((p) => p !== "").join("/"));
}
function resolve(...parts) {
  let out = "";
  for (const p of parts) out = p.startsWith("/") ? p : out + "/" + p;
  return normalize(out.startsWith("/") ? out : "/" + out);
}
function dirname(p) {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : p.slice(0, i);
}
function basename(p, ext) {
  const base = p.replace(/\/+$/, "").split("/").pop() || "";
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}
function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}
function isAbsolute(p) {
  return p.startsWith("/");
}
function relative(from, to) {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b].join("/");
}
const posix = { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative };
function fileURLToPath(url2) {
  return decodeURIComponent(new URL(String(url2)).pathname);
}
function pathToFileURL(path) {
  return new URL("file://" + path);
}
const url = { fileURLToPath, pathToFileURL };
const FILES = {
  "data/internals/run_context/langchain/llms/default_llm_info.hocon": defaultLlmInfo,
  "data/internals/run_context/langchain/toolbox/toolbox_info.hocon": toolboxInfo
};
function lookup(path) {
  const p = String(path);
  for (const [suffix, text] of Object.entries(FILES)) {
    if (p.endsWith("/" + suffix)) return text;
  }
  return null;
}
function notFound(path) {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
  err.code = "ENOENT";
  return err;
}
function existsSync(path) {
  return lookup(path) != null;
}
function readFileSync(path) {
  const text = lookup(path);
  if (text == null) throw notFound(path);
  return text;
}
async function readFile(path) {
  return readFileSync(path);
}
function statSync(path) {
  if (lookup(path) == null) throw notFound(path);
  return { isFile: () => true, isDirectory: () => false };
}
const promises = { readFile };
const fs = { existsSync, readFileSync, readFile, statSync, promises };
const fs$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: fs,
  existsSync,
  promises,
  readFile,
  readFileSync,
  statSync
}, Symbol.toStringTag, { value: "Module" }));
class ConfigTree {
  constructor(obj) {
    Object.assign(this, obj || {});
  }
  put(key, value) {
    this[key] = value;
  }
  as_plain_ordered_dict() {
    const out = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === "function") continue;
      out[k] = v && typeof v.as_plain_ordered_dict === "function" ? v.as_plain_ordered_dict() : v;
    }
    return out;
  }
}
function tree(plain) {
  return Object.assign(new ConfigTree(plain), plain);
}
class ConfigFactory {
  static parse_string(hoconString) {
    return tree(parseHocon(hoconString));
  }
  static parse_String(hoconString) {
    return ConfigFactory.parse_string(hoconString);
  }
  static parse_file(filePath) {
    return tree(parseHocon(readFileSync(String(filePath).trim())));
  }
}
const pyhocon = { ConfigFactory, ConfigTree };
function createRequire() {
  return (id) => {
    throw new Error(`require('${id}') is not available in the browser`);
  };
}
const module$1 = { createRequire };
function spawn() {
  throw new Error("spawning processes is not available in the browser");
}
const process = {};
const empty = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  default: process
}, Symbol.toStringTag, { value: "Module" }));
class PassThrough {
  constructor() {
    throw new Error("stdio streams are not available in the browser");
  }
}
const stream = { PassThrough };
class AsyncLocalStorage {
  constructor() {
    this.store = void 0;
  }
  getStore() {
    return this.store;
  }
  run(store, callback, ...args) {
    const previous = this.store;
    this.store = store;
    try {
      return callback(...args);
    } finally {
      this.store = previous;
    }
  }
  enterWith(store) {
    this.store = store;
  }
  disable() {
    this.store = void 0;
  }
}
const async_hooks = { AsyncLocalStorage };
export {
  AsyncLocalStorage,
  ConfigFactory,
  ConfigTree,
  PassThrough,
  createRequire,
  empty,
  existsSync,
  exposeClassAttributes,
  fileURLToPath,
  fs,
  fs$1,
  join,
  posix,
  process,
  spawn$1 as spawn,
  spawn as spawn$1,
  spawnSync
};
