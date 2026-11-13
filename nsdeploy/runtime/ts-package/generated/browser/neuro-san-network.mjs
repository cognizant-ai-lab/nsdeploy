import { NetworkConfigFilterChain, AgentNetwork, ExternalAgentParsing, ToolsShapeValidator, KeywordNetworkValidator, MissingNodesNetworkValidator, UnreachableNodesNetworkValidator, ToolNameNetworkValidator, UrlNetworkValidator, ChatMessageType as ChatMessageType$1 } from "../neuro-san/neuro-san.mjs";
import { isExternalAgent, parseExternalAgent } from "./external-agent-parsing.mjs";
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
  if (!Array.isArray(config?.tools) && config?.tools != null) {
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
const ChatMessageType = {
  UNKNOWN: Number(ChatMessageType$1.UNKNOWN_MESSAGE_TYPE),
  SYSTEM: Number(ChatMessageType$1.SYSTEM),
  HUMAN: Number(ChatMessageType$1.HUMAN),
  AI: Number(ChatMessageType$1.AI),
  AGENT: Number(ChatMessageType$1.AGENT),
  AGENT_FRAMEWORK: Number(ChatMessageType$1.AGENT_FRAMEWORK),
  AGENT_TOOL_RESULT: Number(ChatMessageType$1.AGENT_TOOL_RESULT),
  AGENT_PROGRESS: Number(ChatMessageType$1.AGENT_PROGRESS)
};
const neuroSanNetwork = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ChatMessageType,
  filterNetworkConfig,
  findFrontMan,
  getAgentToolSpec,
  isExternalAgent,
  isMcpTool,
  parseExternalAgent,
  validateNetwork
}, Symbol.toStringTag, { value: "Module" }));
export {
  neuroSanNetwork
};
