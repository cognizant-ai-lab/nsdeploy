if (typeof globalThis.process === "undefined") {
  const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  const start = now();
  const hrtime = (previous) => {
    const ms = now() - start;
    const time = [Math.floor(ms / 1e3), Math.floor(ms % 1e3 * 1e6)];
    return previous ? [time[0] - previous[0], time[1] - previous[1]] : time;
  };
  hrtime.bigint = () => BigInt(Math.floor((now() - start) * 1e6));
  globalThis.process = {
    env: {},
    argv: [],
    execPath: "",
    version: "",
    versions: {},
    platform: "browser",
    arch: "",
    pid: 0,
    browser: true,
    cwd: () => "/",
    exit: () => {
    },
    on: () => {
    },
    off: () => {
    },
    emitWarning: (warning) => console.warn(warning),
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
    hrtime,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => (now() - start) / 1e3
  };
}
const process = globalThis.process;
const globalObject = globalThis;
export {
  process
};
