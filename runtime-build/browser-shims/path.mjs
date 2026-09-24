// POSIX path stand-in, enough for the package to locate its data directory and the
// files in it.
export const sep = "/";

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

export function normalize(p) {
  const absolute = p.startsWith("/");
  const joined = normalizeParts(p.split("/"), absolute).join("/");
  return (absolute ? "/" : "") + joined || (absolute ? "/" : ".");
}

export function join(...parts) {
  return normalize(parts.filter((p) => p !== "").join("/"));
}

export function resolve(...parts) {
  let out = "";
  for (const p of parts) out = p.startsWith("/") ? p : out + "/" + p;
  return normalize(out.startsWith("/") ? out : "/" + out);
}

export function dirname(p) {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : p.slice(0, i);
}

export function basename(p, ext) {
  const base = p.replace(/\/+$/, "").split("/").pop() || "";
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i);
}

export function isAbsolute(p) {
  return p.startsWith("/");
}

export function relative(from, to) {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => ".."), ...b].join("/");
}

export const posix = { sep, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative };
export default posix;
