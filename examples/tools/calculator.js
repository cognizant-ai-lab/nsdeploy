// calculator.js — an example JavaScript CodedTool (see nsdeploy/runtime/coded_tool.ts).
//
// Loaded by URL from a HOCON tool node and run in the browser's coded-tool
// sandbox: a self-contained ES module (no imports, no network) that exports the
// class named by the node's `class`.

export class Calculator {
  async async_invoke(args, sly_data) {
    const { operation = "add", a, b } = args;
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return `Error: a and b must be numbers (got ${JSON.stringify(a)}, ${JSON.stringify(b)})`;
    }
    const ops = {
      add: () => x + y,
      subtract: () => x - y,
      multiply: () => x * y,
      divide: () => (y === 0 ? NaN : x / y),
    };
    if (!ops[operation]) return `Error: unknown operation '${operation}'`;
    const result = ops[operation]();
    args.progress_reporter?.report({ operation, result }, "calculated");
    return { operation, a: x, b: y, result };
  }
}
