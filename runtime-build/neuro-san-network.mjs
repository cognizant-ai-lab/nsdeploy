// neuro-san-network.mjs: neuro-san's agent network code for the browser, taken from @cognizant-ai-lab/neuro-san-ts-package.
//
// The npm package is the real neuro-san Python sources transpiled to TypeScript, so
// the neuro-san logic the runtime needs comes from there rather than being written
// here. vite.config.mjs builds this file for the browser into
// runtime/ts-package/generated/browser/, which generated-bridge.js loads.
//
// Every export here is a thin adapter over a package class. Where the package's
// transpiled code does not work yet, the adapter works around it and the comment
// says what to fix in the transpiling source so the workaround can be deleted.
// Do not fix these by editing the package: a rebundled package has to be
// reproducible from the transpiling source.

import {
  AgentNetwork,
  NetworkConfigFilterChain,
  KeywordNetworkValidator,
  MissingNodesNetworkValidator,
  ToolNameNetworkValidator,
  ToolsShapeValidator,
  UnreachableNodesNetworkValidator,
  UrlNetworkValidator,
  ChatMessageType as PackageChatMessageType,
} from "@cognizant-ai-lab/neuro-san-ts-package";
import { ExternalAgentParsing } from "./external-agent-parsing.mjs";

// --- config filter chain -----------------------------------------------------

// commondefs substitution, defaults injection and name correction.
export function filterNetworkConfig(config) {
  return new NetworkConfigFilterChain().filter_config(config);
}

// --- front man ---------------------------------------------------------------

// AgentNetwork.find_front_man raises when the first tool is not a usable LLM
// agent. The runtime asks for the front man in places (the trace, the UI) that
// only need a name, so a network without one reads as null here; validateNetwork
// is what turns that into an error before anything runs.
export function findFrontMan(config) {
  try {
    return new AgentNetwork(config, "browser").find_front_man();
  } catch {
    return null;
  }
}

export function getAgentToolSpec(config, name) {
  return new AgentNetwork(config, "browser").get_agent_tool_spec(name);
}

// --- external agent / MCP references --------------------------------------------

export function isMcpTool(toolRef) {
  return ExternalAgentParsing.is_mcp_tool(toolRef);
}

// URL parsing is neuro-san's ExternalAgentParsing; see external-agent-parsing.mjs for
// where it still differs from Python.
export { parseExternalAgent, isExternalAgent } from "./external-agent-parsing.mjs";

// --- validation ------------------------------------------------------------------

// The validators ManifestNetworkValidator runs, in its order. The package doesn't
// export ManifestNetworkValidator, or ParametersSchemaNetworkValidator, the one it
// runs that this list leaves out. Once it exports them, use ManifestNetworkValidator
// directly.
function networkValidators(networkName) {
  return [
    new ToolsShapeValidator(networkName),
    new KeywordNetworkValidator(networkName),
    new MissingNodesNetworkValidator(),
    new UnreachableNodesNetworkValidator(networkName),
    new ToolNameNetworkValidator(),
    new UrlNetworkValidator(null, null, networkName),
  ];
}

// Returns error strings, empty when the network is valid.
export function validateNetwork(config, networkName = "browser") {
  const errors = [];
  if (!Array.isArray(config?.tools) && config?.tools != null) {
    // ToolsShapeValidator throws when tools isn't a list, as neuro-san's Python does,
    // so a partner's malformed network is reported here as an error instead.
    errors.push("network's 'tools' is not a list");
    return errors;
  }
  for (const validator of networkValidators(networkName)) {
    errors.push(...validator.validate(config));
  }
  try {
    new AgentNetwork(config, networkName).find_front_man();
  } catch (err) {
    errors.push(String(err?.message || err).trim().split("\n")[0]);
  }
  return errors;
}

// --- ChatMessage types -------------------------------------------------------------

// Plain numbers for the runtime's ChatMessage envelopes, read from the package's
// ChatMessageType so the values are neuro-san's own.
export const ChatMessageType = {
  UNKNOWN: Number(PackageChatMessageType.UNKNOWN_MESSAGE_TYPE),
  SYSTEM: Number(PackageChatMessageType.SYSTEM),
  HUMAN: Number(PackageChatMessageType.HUMAN),
  AI: Number(PackageChatMessageType.AI),
  AGENT: Number(PackageChatMessageType.AGENT),
  AGENT_FRAMEWORK: Number(PackageChatMessageType.AGENT_FRAMEWORK),
  AGENT_TOOL_RESULT: Number(PackageChatMessageType.AGENT_TOOL_RESULT),
  AGENT_PROGRESS: Number(PackageChatMessageType.AGENT_PROGRESS),
};
