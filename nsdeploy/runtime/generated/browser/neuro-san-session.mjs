import { AgentNetwork } from "../neuro-san/graph.mjs";
import { AsyncioExecutorPool } from "../neuro-san/leaf_common.mjs";
import { StorageClass, ExpiringAgentNetworkStorage, DirectAgentReservationist } from "../neuro-san/internals.mjs";
import { MasterLlmFactory, MasterToolboxFactory, LangChainRunContext, BaseToolFactory, LangChainOpenAIFunctionTool, PydanticArgumentDictionaryConverter, LangChainRun, NeuroSanRunnable, LangChainMcpAdapter, McpToolErrorHandler } from "../neuro-san/run_context.mjs";
import { SessionInvocationContext, DirectAgentSession, ExternalAgentSessionFactory, AsyncDirectAgentSession } from "../neuro-san/session.mjs";
import { ChatMessageType, AgentMessage, AgentFrameworkMessage, AgentToolResultMessage, AgentProgressMessage, ChatMessageTypeUtil, ContentUtils } from "../neuro-san/message.mjs";
import { SystemMessage, HumanMessage, AIMessage, MultiServerMCPClient } from "../vendor/libraries.mjs";
import { parseExternalAgent } from "./external-agent-parsing.mjs";
const hooks = {
  // async ({ url }) => boolean. Runs before anything is sent to an MCP server
  // (initialize, tools/list), so declining means the server is never contacted and
  // the agent carries on without its tools.
  mcpConsent: null,
  // async ({ url, tool, args }) => string | null. Runs before each MCP tool call. A
  // string is returned to the agent as the tool's output instead of making the call
  // (e.g. the user declined); null lets the call go ahead.
  mcpCall: null,
  // ({ url, tool, result, error }) => void. After an MCP tool call returns or fails.
  mcpResult: null,
  // async (agentUrl, { chain, request }) => { config, name } | { answer }. Turns a
  // partner network's URL into its published network, after the runtime's consent and
  // policy checks. `chain` lists the partner URLs already running above this call, and
  // `request` is the chat request about to be sent (for the consent card). Returning
  // { answer } does not run the partner: that text is the partner's answer (a declined
  // consent, a skipped cycle). Throwing fails the call.
  resolvePeer: null,
  // ({ url, error }) => void. After a partner network's run ends.
  peerDone: null,
  // (agentUrl) => function spec | null. What to advertise for a partner before it is
  // contacted, e.g. the contract nsdeploy published for the leaf it replaced.
  peerFunction: null
};
function setHooks(values) {
  Object.assign(hooks, values);
}
function setEnv(values) {
  Object.assign(globalThis.process.env, values);
}
function createSession(config, name) {
  const network = new AgentNetwork(config, name);
  const llmFactory = MasterLlmFactory.create_llm_factory(config);
  llmFactory.load();
  const toolboxFactory = MasterToolboxFactory.create_toolbox_factory(config);
  toolboxFactory.load();
  const storage = { [StorageClass.TEMP]: new ExpiringAgentNetworkStorage() };
  const context = new SessionInvocationContext(
    name,
    new PeerSessionFactory(),
    new AsyncioExecutorPool(),
    llmFactory,
    toolboxFactory,
    null,
    new DirectAgentReservationist(/* @__PURE__ */ new Set([storage[StorageClass.TEMP]]))
  );
  context.start();
  return new DirectAgentSession(network, context, null, null, null);
}
const MESSAGE_CLASS_TO_CHAT_MESSAGE_TYPE = /* @__PURE__ */ new Map([
  [SystemMessage, ChatMessageType.SYSTEM],
  [HumanMessage, ChatMessageType.HUMAN],
  [AIMessage, ChatMessageType.AI],
  [AgentMessage, ChatMessageType.AGENT],
  [AgentFrameworkMessage, ChatMessageType.AGENT_FRAMEWORK],
  [AgentToolResultMessage, ChatMessageType.AGENT_TOOL_RESULT],
  [AgentProgressMessage, ChatMessageType.AGENT_PROGRESS]
]);
ChatMessageTypeUtil.from_message = function fromMessage(baseMessage) {
  const messageClass = baseMessage == null ? null : baseMessage.constructor;
  return MESSAGE_CLASS_TO_CHAT_MESSAGE_TYPE.get(messageClass) ?? ChatMessageType.UNKNOWN_MESSAGE_TYPE;
};
const fromResponseType = ChatMessageTypeUtil.from_response_type;
ChatMessageTypeUtil.from_response_type = function(responseType) {
  if (typeof responseType === "number") return responseType;
  return fromResponseType.call(this, responseType);
};
const createResources = LangChainRunContext.prototype.create_resources;
LangChainRunContext.prototype.create_resources = function(agentName, instructions, assignments, toolNames, ...rest) {
  const isKeywordObject = toolNames != null && typeof toolNames === "object" && !Array.isArray(toolNames) && Object.keys(toolNames).every((key) => key === "tool_names");
  return createResources.call(
    this,
    agentName,
    instructions,
    assignments,
    isKeywordObject ? toolNames.tool_names : toolNames,
    ...rest
  );
};
BaseToolFactory.prototype.ensure_external_parameters = async function ensureExternalParameters(functionJson, name) {
  const isDict = (value) => value != null && typeof value === "object" && !Array.isArray(value);
  const isEmpty = (value) => value == null || (isDict(value) ? Object.keys(value).length === 0 : !value);
  if (functionJson == null) {
    return null;
  }
  if (functionJson.description == null) {
    return functionJson;
  }
  const rawParameters = functionJson.parameters;
  if (rawParameters != null && !isDict(rawParameters)) {
    return functionJson;
  }
  const parameters = isEmpty(rawParameters) ? {} : rawParameters;
  const properties = isEmpty(parameters.properties) ? {} : parameters.properties;
  if (!isEmpty(properties)) {
    BaseToolFactory.synthesis_warned.delete(name);
    return functionJson;
  }
  const allowedKeys = /* @__PURE__ */ new Set(["type", "properties", "required"]);
  if (!isEmpty(parameters) && !Object.keys(parameters).every((key) => allowedKeys.has(key))) {
    return functionJson;
  }
  if (!BaseToolFactory.synthesis_warned.has(name)) {
    BaseToolFactory.synthesis_warned.add(name);
    const message = `The front-man of external agent ${name} declares no parameters in its function definition, so a single required '${BaseToolFactory.DEFAULT_EXTERNAL_PARAMETER_NAME}' string parameter is being synthesized for it to receive the calling agent's request. To control what this agent network receives, declare at least one parameter in the function definition of its front-man.`;
    await this.journal.write_message(new AgentMessage(message, {}, null), null);
    this.logger.warning(message);
  }
  return { ...functionJson, parameters: structuredClone(BaseToolFactory.DEFAULT_EXTERNAL_PARAMETERS) };
};
const fromFunctionJson = LangChainOpenAIFunctionTool.from_function_json;
LangChainOpenAIFunctionTool.from_function_json = function(functionJson, toolCaller) {
  const tool = fromFunctionJson.call(this, functionJson, toolCaller);
  for (const field of ["name", "description", "parameters"]) {
    if (tool[field] == null && functionJson?.[field] != null) tool[field] = functionJson[field];
  }
  return tool;
};
Object.defineProperty(LangChainOpenAIFunctionTool.prototype, "schema", {
  configurable: true,
  get() {
    const parameters = this.function_json;
    const isSchema = parameters != null && typeof parameters === "object" && !Array.isArray(parameters) && (parameters.type === "object" || "properties" in parameters);
    return isSchema ? parameters : { type: "object", properties: {} };
  },
  set(value) {
    Object.defineProperty(this, "schema", { value, writable: true, configurable: true });
  }
});
LangChainOpenAIFunctionTool.prototype._call = async function call(args) {
  let run = null;
  try {
    const kwargs = new PydanticArgumentDictionaryConverter().to_dict(args || {});
    const initialRun = new LangChainRun("tool_base", [""], this.name, kwargs, null, this.invocation);
    run = await this.tool_caller.make_tool_function_calls(initialRun);
  } catch (exception) {
    console.error("Tool._arun() got Exception:", exception);
    return String(exception);
  }
  const theAnswer = run.get_tool_message();
  if (theAnswer == null) {
    return null;
  }
  return ContentUtils.history_safe_text(theAnswer);
};
const prepareRunnableConfig = NeuroSanRunnable.prototype.prepare_runnable_config;
NeuroSanRunnable.prototype.prepare_runnable_config = function(...args) {
  const config = prepareRunnableConfig.apply(this, args);
  for (const [python, js] of [["recursion_limit", "recursionLimit"], ["run_name", "runName"]]) {
    if (config && python in config) {
      config[js] ??= config[python];
      delete config[python];
    }
  }
  return config;
};
LangChainMcpAdapter.prototype.get_mcp_tools = async function getMcpTools(serverUrl, allowedTools = null, headers = null) {
  if (this._mcp_servers_info == null) {
    this._load_mcp_servers_info();
  }
  const serversInfo = this._mcp_servers_info || {};
  const serverInfo = serversInfo[serverUrl] || {};
  if (hooks.mcpConsent && !await hooks.mcpConsent({ kind: "mcp", url: serverUrl })) {
    this.client_allowed_tools = allowedTools;
    return [];
  }
  const connection = { url: serverUrl, transport: "http" };
  const headersDict = headers || serverInfo.http_headers;
  if (headersDict) {
    if (typeof headersDict === "object" && !Array.isArray(headersDict)) {
      connection.headers = { ...headersDict };
    } else {
      this.logger.error("MCP client headers for server %s must be a dictionary.", serverUrl);
    }
  }
  const client = new MultiServerMCPClient({
    mcpServers: { server: connection },
    // The Python client names tools exactly as the server does.
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: ""
  });
  let mcpTools = await client.getTools();
  let clientAllowedTools = allowedTools;
  if (clientAllowedTools == null) {
    clientAllowedTools = serverInfo.tools || [];
  }
  if (clientAllowedTools && clientAllowedTools.length) {
    mcpTools = mcpTools.filter((tool) => clientAllowedTools.includes(tool.name));
  }
  this.client_allowed_tools = clientAllowedTools;
  for (const tool of mcpTools) {
    tool.tags = ["langchain_tool"];
    if (typeof tool.func === "function") {
      const handler = new McpToolErrorHandler(tool);
      handler.original_coroutine = tool.func.bind(tool);
      tool.func = async (args, ...rest) => {
        const instead = hooks.mcpCall ? await hooks.mcpCall({ url: serverUrl, tool: tool.name, args }) : null;
        if (instead != null) return instead;
        try {
          const result = await handler.async_invoke(args, ...rest);
          hooks.mcpResult?.({ url: serverUrl, tool: tool.name, result });
          return result;
        } catch (error) {
          hooks.mcpResult?.({ url: serverUrl, tool: tool.name, error });
          throw error;
        }
      };
    }
  }
  return mcpTools;
};
class PeerSessionFactory extends ExternalAgentSessionFactory {
  constructor() {
    super(false, null);
  }
  create_session(agentUrl, invocationContext = null, invocation = null) {
    if (invocationContext != null && typeof invocationContext.get_port !== "function" && "invocation_context" in invocationContext) {
      invocation = invocationContext.invocation ?? invocation;
      invocationContext = invocationContext.invocation_context;
    }
    return new PeerSession(agentUrl, invocationContext, invocation);
  }
}
class PeerSession {
  constructor(agentUrl, invocationContext, invocation) {
    this.agentUrl = agentUrl;
    this.invocationContext = invocationContext;
    this.invocation = invocation;
    this.session = null;
  }
  // Advertise the partner without contacting it. With no published contract, the
  // description alone is enough: neuro-san then synthesizes a single "inquiry"
  // parameter on the calling side (BaseToolFactory.ensure_external_parameters).
  async function() {
    const published = hooks.peerFunction ? hooks.peerFunction(this.agentUrl) : null;
    const location = parseExternalAgent(this.agentUrl);
    const name = location ? location.agent_name : this.agentUrl;
    return { function: published || { description: `The partner network "${name}" at ${this.agentUrl}.` } };
  }
  async connectivity() {
    return { connectivity_info: [] };
  }
  // The partner URLs running above this session, carried on the invocation context
  // each partner's session gets, so the runtime can refuse a cycle.
  chain() {
    return this.invocationContext?.nsdeploy_peer_chain || [];
  }
  async *streaming_chat(request) {
    if (!hooks.resolvePeer) throw new Error(`No partner resolver is set, so ${this.agentUrl} cannot be run.`);
    const chain = this.chain();
    const resolved = await hooks.resolvePeer(this.agentUrl, { chain, request });
    if (resolved.answer != null) {
      yield { response: { type: ChatMessageType.AGENT_FRAMEWORK, text: resolved.answer, origin: [] } };
      return;
    }
    const network = new AgentNetwork(resolved.config, resolved.name);
    const context = await this.invocationContext.safe_shallow_copy(this.invocation);
    context.nsdeploy_peer_chain = [...chain, this.agentUrl];
    const metadata = this.invocationContext.get_metadata ? this.invocationContext.get_metadata() : null;
    const session = new AsyncDirectAgentSession(network, context, metadata, null, null);
    let error = null;
    try {
      yield* session.streaming_chat(request);
    } catch (err) {
      error = err;
      throw err;
    } finally {
      hooks.peerDone?.({ url: this.agentUrl, error });
    }
  }
}
const neuroSanSession = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  createSession,
  setEnv,
  setHooks
}, Symbol.toStringTag, { value: "Module" }));
export {
  neuroSanSession
};
