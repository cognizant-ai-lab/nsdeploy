// fs stand-in. The package's agent loop reads two of its own packaged data files
// (found by tracing a Node run of DirectAgentSession): the llm info and the
// toolbox info. They are embedded here at build time and served by the path the
// package asks for. Every other path does not exist, which is what the package's
// other probes (a LangSmith config, a package.json) expect in a browser.
import defaultLlmInfo from "@cognizant-ai-lab/neuro-san-npm/data/internals/run_context/langchain/llms/default_llm_info.hocon";
import toolboxInfo from "@cognizant-ai-lab/neuro-san-npm/data/internals/run_context/langchain/toolbox/toolbox_info.hocon";

const FILES = {
  "data/internals/run_context/langchain/llms/default_llm_info.hocon": defaultLlmInfo,
  "data/internals/run_context/langchain/toolbox/toolbox_info.hocon": toolboxInfo,
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

export function existsSync(path) {
  return lookup(path) != null;
}

export function readFileSync(path) {
  const text = lookup(path);
  if (text == null) throw notFound(path);
  return text;
}

export async function readFile(path) {
  return readFileSync(path);
}

export function statSync(path) {
  if (lookup(path) == null) throw notFound(path);
  return { isFile: () => true, isDirectory: () => false };
}

export const promises = { readFile };
export default { existsSync, readFileSync, readFile, statSync, promises };
