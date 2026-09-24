// neuro-san-kernel.mjs: the browser kernel, taken from @cognizant-ai-lab/neuro-san-npm.
//
// The npm package is the real neuro-san Python sources transpiled to TypeScript, so
// the neuro-san logic the runtime needs comes from there rather than being written
// here. bundle.mjs bundles this file for the browser into
// runtime/generated/neuro-san.mjs, which generated-bridge.js loads.
//
// Every export here is a thin adapter over a package class. Where the package's
// transpiled code does not work yet, the adapter works around it and the comment
// says what to fix in the transpiling source so the workaround can be deleted.
// Do not fix these by editing the package: a rebundled package has to be
// reproducible from the transpiling source.

// PORT BACK: the package root only exports ConciergeSessionFactory,
// DirectAgentSessionFactory and ChatMessageType, and its "exports" map blocks deep
// imports, so these reach into dist by relative path. Exporting these classes from
// the package's src/index.ts would let them be imported by name.
import { AgentNetwork } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/graph/registry/agent_network.js";
import { NetworkConfigFilterChain } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/graph/filters/network_config_filter_chain.js";
import { SlyDataRedactor } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/utils/sly_data_redactor.js";
import { ExternalAgentParsing } from "./external-agent-parsing.mjs";
import { KeywordNetworkValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/keyword_network_validator.js";
import { MissingNodesNetworkValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/missing_nodes_network_validator.js";
import { ToolNameNetworkValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/tool_name_network_validator.js";
import { ToolsShapeValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/tools_shape_validator.js";
import { UnreachableNodesNetworkValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/unreachable_nodes_network_validator.js";
import { UrlNetworkValidator } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/validation/network/url_network_validator.js";
// ChatMessageType is imported from its own module rather than the package root:
// the root also exports the session factories, whose imports reach the whole
// LangChain run context and Node-only code that cannot bundle for a browser.
import { ChatMessageType as PackageChatMessageType } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/chat_message_type.js";

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

// --- sly_data ------------------------------------------------------------------

// PORT BACK: with allow_empty_dict false, SlyDataRedactor returns {} where the
// Python returns None for an empty result. The runtime always passes true, so
// this path is not exercised here.
export function filterSlyData(agentSpec, configKeys, slyData, allowEmptyDict = true) {
  return new SlyDataRedactor(agentSpec, configKeys, allowEmptyDict).filter_config(slyData);
}

// --- external agent / MCP references --------------------------------------------

export function isMcpTool(toolRef) {
  return ExternalAgentParsing.is_mcp_tool(toolRef);
}

// URL parsing is neuro-san's ExternalAgentParsing; see external-agent-parsing.mjs for
// the workaround that makes it run.
export { parseExternalAgent, isExternalAgent, getSafeAgentName } from "./external-agent-parsing.mjs";

// --- validation ------------------------------------------------------------------

// WORKAROUND: ManifestNetworkValidator runs these validators plus
// ParametersSchemaNetworkValidator, which rejects every valid `parameters` schema
// ("pydantic model conversion failed - TypeError: Cannot use 'in' operator to
// search for 'string' in undefined", then "parameters.required has undefined
// props"). Any network whose agents declare parameters, like the airline and
// car-rental demos, would fail to load. So the validators are listed here without
// it, in the order ManifestNetworkValidator uses.
// PORT BACK: fix the transpiled pydantic conversion behind
// ParametersSchemaNetworkValidator, then use ManifestNetworkValidator directly.
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
  if (!Array.isArray(config?.tools) || config.tools.length === 0) {
    // WORKAROUND: ToolNameNetworkValidator throws on a network with no tools
    // ("Cannot read properties of undefined (reading 'slice')"), so that case is
    // reported here instead of reaching it.
    // PORT BACK: fix the transpiled ToolNameNetworkValidator for an empty network.
    errors.push("network has no 'tools' list");
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
// WORKAROUND: Number(ChatMessageType.UNKNOWN) is NaN, where the proto value is 0.
// PORT BACK: fix the transpiled ChatMessageType so UNKNOWN coerces to 0.
export const ChatMessageType = {
  UNKNOWN: 0,
  SYSTEM: Number(PackageChatMessageType.SYSTEM),
  HUMAN: Number(PackageChatMessageType.HUMAN),
  AI: Number(PackageChatMessageType.AI),
  AGENT: Number(PackageChatMessageType.AGENT),
  AGENT_FRAMEWORK: Number(PackageChatMessageType.AGENT_FRAMEWORK),
  AGENT_TOOL_RESULT: Number(PackageChatMessageType.AGENT_TOOL_RESULT),
  AGENT_PROGRESS: Number(PackageChatMessageType.AGENT_PROGRESS),
};
