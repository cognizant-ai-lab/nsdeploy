import "../neuro-san/index.mjs";
import { getSafeAgentName, isExternalAgent, parseExternalAgent } from "./external-agent-parsing.mjs";
import { NetworkConfigFilterChain } from "../neuro-san/filters.mjs";
import { AgentNetwork } from "../neuro-san/graph.mjs";
import { SlyDataRedactor, ChatMessageType as ChatMessageType$1 } from "../neuro-san/message.mjs";
import { ExternalAgentParsing } from "../neuro-san/internals.mjs";
import { ToolsShapeValidator, KeywordNetworkValidator, MissingNodesNetworkValidator, UnreachableNodesNetworkValidator, ToolNameNetworkValidator, UrlNetworkValidator } from "../neuro-san/run_context.mjs";
function filterNetworkConfig(config) {
  return new NetworkConfigFilterChain().filter_config(config);
}
function findFrontMan(config) {
  try {
    return new AgentNetwork(config, "browser").find_front_man();
  } catch {
    return null;
  }
}
function getAgentToolSpec(config, name) {
  return new AgentNetwork(config, "browser").get_agent_tool_spec(name);
}
function filterSlyData(agentSpec, configKeys, slyData, allowEmptyDict = true) {
  return new SlyDataRedactor(agentSpec, configKeys, allowEmptyDict).filter_config(slyData);
}
function isMcpTool(toolRef) {
  return ExternalAgentParsing.is_mcp_tool(toolRef);
}
function networkValidators(networkName) {
  return [
    new ToolsShapeValidator(networkName),
    new KeywordNetworkValidator(networkName),
    new MissingNodesNetworkValidator(),
    new UnreachableNodesNetworkValidator(networkName),
    new ToolNameNetworkValidator(),
    new UrlNetworkValidator(null, null, networkName)
  ];
}
function validateNetwork(config, networkName = "browser") {
  const errors = [];
  if (!Array.isArray(config?.tools) || config.tools.length === 0) {
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
const ChatMessageType = {
  UNKNOWN: 0,
  SYSTEM: Number(ChatMessageType$1.SYSTEM),
  HUMAN: Number(ChatMessageType$1.HUMAN),
  AI: Number(ChatMessageType$1.AI),
  AGENT: Number(ChatMessageType$1.AGENT),
  AGENT_FRAMEWORK: Number(ChatMessageType$1.AGENT_FRAMEWORK),
  AGENT_TOOL_RESULT: Number(ChatMessageType$1.AGENT_TOOL_RESULT),
  AGENT_PROGRESS: Number(ChatMessageType$1.AGENT_PROGRESS)
};
const neuroSanKernel = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ChatMessageType,
  filterNetworkConfig,
  filterSlyData,
  findFrontMan,
  getAgentToolSpec,
  getSafeAgentName,
  isExternalAgent,
  isMcpTool,
  parseExternalAgent,
  validateNetwork
}, Symbol.toStringTag, { value: "Module" }));
export {
  neuroSanKernel
};
