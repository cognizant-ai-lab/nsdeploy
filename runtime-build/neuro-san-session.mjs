// neuro-san-session.mjs: the package's agent loop (DirectAgentSession) for the browser.
//
// The loop is neuro-san's own, from @cognizant-ai-lab/neuro-san-npm. Where the
// package's transpiled code does not work yet, this module replaces that one method
// from here (the package on disk is never edited) and says what to fix in the
// transpiling source. Each is marked WORKAROUND / PORT BACK.
import { AgentNetwork } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/graph/registry/agent_network.js";
import { AsyncioExecutorPool } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/leaf_common/asyncio/asyncio_executor_pool.js";
import { StorageClass } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/interfaces/storage_class.js";
import { ExpiringAgentNetworkStorage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/network_providers/expiring_agent_network_storage.js";
import { DirectAgentReservationist } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/reservations/direct_agent_reservationist.js";
import { MasterToolboxFactory } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/factory/master_toolbox_factory.js";
import { MasterLlmFactory } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/factory/master_llm_factory.js";
import { DirectAgentSession } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/session/direct_agent_session.js";
import { ExternalAgentSessionFactory } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/session/external_agent_session_factory.js";
import { SessionInvocationContext } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/session/session_invocation_context.js";
import { LangChainMcpAdapter } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/mcp/langchain_mcp_adapter.js";
import { McpToolErrorHandler } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/mcp/mcp_tool_error_handler.js";
import { BaseToolFactory } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/core/base_tool_factory.js";
import { AgentMessage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/agent_message.js";
import { LangChainOpenAIFunctionTool } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/core/langchain_openai_function_tool.js";
import { LangChainRun } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/core/langchain_run.js";
import { PydanticArgumentDictionaryConverter } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/core/pydantic_argument_dictionary_converter.js";
import { ContentUtils } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/utils/content_utils.js";
import { ChatMessageType } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/chat_message_type.js";
import { ChatMessageTypeUtil } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/chat_message_type_util.js";
import { AgentMessage as NeuroSanAgentMessage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/agent_message.js";
import { AgentFrameworkMessage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/agent_framework_message.js";
import { AgentToolResultMessage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/agent_tool_result_message.js";
import { AgentProgressMessage } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/message/types/agent_progress_message.js";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { LangChainRunContext } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/internals/run_context/langchain/core/langchain_run_context.js";
import { AsyncDirectAgentSession } from "./node_modules/@cognizant-ai-lab/neuro-san-npm/dist/generated/neuro_san/session/async_direct_agent_session.js";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
// Imported for its side effect too: it makes the package's ExternalAgentParsing work.
import { parseExternalAgent } from "./external-agent-parsing.mjs";

// --- hooks the runtime sets ------------------------------------------------------

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
  peerFunction: null,
};

export function setHooks(values) {
  Object.assign(hooks, values);
}

export function setEnv(values) {
  Object.assign(globalThis.process.env, values);
}

export function createSession(config, name) {
  const network = new AgentNetwork(config, name);
  const llmFactory = MasterLlmFactory.create_llm_factory(config);
  llmFactory.load();
  const toolboxFactory = MasterToolboxFactory.create_toolbox_factory(config);
  toolboxFactory.load();
  const storage = { [StorageClass.TEMP]: new ExpiringAgentNetworkStorage() };
  const context = new SessionInvocationContext(name, new PeerSessionFactory(),
    new AsyncioExecutorPool(), llmFactory, toolboxFactory, null,
    new DirectAgentReservationist(new Set([storage[StorageClass.TEMP]])));
  context.start();
  return new DirectAgentSession(network, context, null, null, null);
}

// --- message types -----------------------------------------------------------------

// WORKAROUND: ChatMessageTypeUtil.from_message decides each message's ChatMessageType
// by looking type(message) up in MESSAGE_TYPE_TO_CHAT_MESSAGE_TYPE. In python that map
// is keyed by message class. The transpiled map is keyed by strings ("ai", "AGENT",
// ...) while pythonlib's type() returns "object" for every message, so every message
// is UNKNOWN (0). The default MINIMAL chat filter only passes the AGENT_FRAMEWORK
// message that carries the answer, so with every type UNKNOWN a session streams
// nothing back at all, and a partner network's answer never reaches its caller.
// (This is why a caller of the package has to ask for the MAXIMAL filter.)
// from_response_type has the matching gap for numbers: it calls
// new ChatMessageType(n), but ChatMessageType is a plain object of numbers here.
// PORT BACK: key MESSAGE_TYPE_TO_CHAT_MESSAGE_TYPE by class and look it up by
// message.constructor, and map ChatMessageType(n) to n, in the transpiling source.
// Both follow python here: an exact class match, as type(x) is.
const MESSAGE_CLASS_TO_CHAT_MESSAGE_TYPE = new Map([
  [SystemMessage, ChatMessageType.SYSTEM],
  [HumanMessage, ChatMessageType.HUMAN],
  [AIMessage, ChatMessageType.AI],
  [NeuroSanAgentMessage, ChatMessageType.AGENT],
  [AgentFrameworkMessage, ChatMessageType.AGENT_FRAMEWORK],
  [AgentToolResultMessage, ChatMessageType.AGENT_TOOL_RESULT],
  [AgentProgressMessage, ChatMessageType.AGENT_PROGRESS],
]);

ChatMessageTypeUtil.from_message = function fromMessage(baseMessage) {
  const messageClass = baseMessage == null ? null : baseMessage.constructor;
  return MESSAGE_CLASS_TO_CHAT_MESSAGE_TYPE.get(messageClass) ?? ChatMessageType.UNKNOWN_MESSAGE_TYPE;
};

const fromResponseType = ChatMessageTypeUtil.from_response_type;
ChatMessageTypeUtil.from_response_type = function (responseType) {
  if (typeof responseType === "number") return responseType;
  return fromResponseType.call(this, responseType);
};

// --- tools -------------------------------------------------------------------------

// WORKAROUND: CallingActivation calls
//   run_context.create_resources(name, use_instructions, assignments, { tool_names })
// (python: tool_names=tool_names), but the transpiled
// LangChainRunContext.create_resources takes tool_names as a plain positional
// parameter, so it iterates that keyword object and asks for a tool literally named
// "tool_names". Every agent that has tools (sub-agents, MCP servers, external agents)
// ends up with none of them, and the run carries on without an error.
// PORT BACK: make the transpiled create_resources read a trailing keyword object, as
// the transpiler already does for methods that take **kwargs.
const createResources = LangChainRunContext.prototype.create_resources;
LangChainRunContext.prototype.create_resources = function (agentName, instructions, assignments, toolNames, ...rest) {
  const isKeywordObject = toolNames != null && typeof toolNames === "object" && !Array.isArray(toolNames)
    && Object.keys(toolNames).every((key) => key === "tool_names");
  return createResources.call(this, agentName, instructions, assignments,
    isKeywordObject ? toolNames.tool_names : toolNames, ...rest);
};

// WORKAROUND: BaseToolFactory.ensure_external_parameters is how an external agent
// whose front man declares no parameters still receives the caller's request: it
// synthesizes a single "inquiry" parameter. Two transpile gaps stop that:
//   * python's `if properties:` is false for an empty dict, the transpiled
//     `if (properties)` is true for {}, so nothing is ever synthesized and the
//     partner is dropped as "an invalid function definition";
//   * it calls python's set.discard() on a JS Set (the package's only discard());
// PORT BACK: python truthiness for containers, and set.discard -> Set.delete, in the
// transpiling source. Then delete this.
// Until then this follows the python method line for line.
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
  const allowedKeys = new Set(["type", "properties", "required"]);
  if (!isEmpty(parameters) && !Object.keys(parameters).every((key) => allowedKeys.has(key))) {
    return functionJson;
  }
  if (!BaseToolFactory.synthesis_warned.has(name)) {
    BaseToolFactory.synthesis_warned.add(name);
    const message = (`The front-man of external agent ${name} declares no parameters `
      + "in its function definition, so a single required "
      + `'${BaseToolFactory.DEFAULT_EXTERNAL_PARAMETER_NAME}' string parameter `
      + "is being synthesized for it to receive the calling agent's request. "
      + "To control what this agent network receives, declare at least one parameter "
      + "in the function definition of its front-man.");
    await this.journal.write_message(new AgentMessage(message, {}, null), null);
    this.logger.warning(message);
  }
  return { ...functionJson, parameters: structuredClone(BaseToolFactory.DEFAULT_EXTERNAL_PARAMETERS) };
};

// WORKAROUND: LangChainOpenAIFunctionTool, the tool neuro-san gives an agent for each
// sub-agent and external agent it can call, follows python LangChain's BaseTool
// contract: an `args_schema` and an `_arun` method. LangChain.js's StructuredTool, which
// it extends, reads `schema` and calls `_call` instead, so invoking one fails
// ("Cannot destructure property '$ref' of 'schema'") and an agent can call neither its
// sub-agents nor its partners. Two keyword-argument gaps inside _arun would stop it
// even then: its keyword-object check only pops an EMPTY trailing object, so the tool
// arguments never reach kwargs, and it calls
//   new LangChainRun("tool_base", [""], name, kwargs, { invocation })
// (python: invocation=self.invocation), which lands in the tool_message slot.
// PORT BACK: map args_schema/_arun to schema/_call for StructuredTool subclasses, and
// the keyword-argument calls, in the transpiling source.
// The schema is the parameters object from_function_json keeps as function_json (JSON
// Schema, which LangChain.js accepts); _call follows python's _arun line for line.
Object.defineProperty(LangChainOpenAIFunctionTool.prototype, "schema", {
  configurable: true,
  get() {
    const parameters = this.function_json;
    const isSchema = parameters != null && typeof parameters === "object" && !Array.isArray(parameters)
      && (parameters.type === "object" || "properties" in parameters);
    return isSchema ? parameters : { type: "object", properties: {} };
  },
  set(value) {
    Object.defineProperty(this, "schema", { value, writable: true, configurable: true });
  },
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

// --- MCP ---------------------------------------------------------------------------

// WORKAROUND: LangChainMcpAdapter.get_mcp_tools calls the Python client API on the JS
// MultiServerMCPClient: client.get_tools() (JS: getTools()) and
// transport "streamable_http" (JS: "http"), which the JS client's config schema
// rejects. The Python wraps each tool's `coroutine` in McpToolErrorHandler; a JS
// DynamicStructuredTool keeps its implementation in `func` instead, so the transpiled
// wrapper would never run. The agent is left with no MCP tools and no error.
// PORT BACK: map these three names in the transpiling source, then delete this.
// Otherwise this follows the Python get_mcp_tools line for line, plus the runtime's
// consent hook ahead of any contact with the server.
LangChainMcpAdapter.prototype.get_mcp_tools = async function getMcpTools(serverUrl, allowedTools = null, headers = null) {
  if (this._mcp_servers_info == null) {
    this._load_mcp_servers_info();
  }
  const serversInfo = this._mcp_servers_info || {};
  const serverInfo = serversInfo[serverUrl] || {};

  if (hooks.mcpConsent && !(await hooks.mcpConsent({ kind: "mcp", url: serverUrl }))) {
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
    additionalToolNamePrefix: "",
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

// --- partner networks --------------------------------------------------------------

// A partner network is another site's published network, fetched and run in this
// browser. neuro-san already runs an external agent this way when it lives on the
// same server (ExternalAgentSessionFactory with use_direct: an
// AsyncDirectAgentSession over its AgentNetwork, in a safe_shallow_copy of the
// caller's invocation context). A browser has to fetch the network first, and only
// after the user consents, while create_session is synchronous. So this factory
// returns a session that advertises the partner without contacting it and resolves
// it on the first chat, then hands off to neuro-san's own AsyncDirectAgentSession.
//
// WORKAROUND: two call sites pass create_session's arguments differently.
// ExternalToolAdapter.get_function_json calls
//   create_session(agent_url, { invocation_context })   (python: invocation_context=...)
// while ExternalActivation passes them positionally. The transpiled factory only
// takes the positional form, so the adapter's call fails and the partner is dropped
// from the agent's tools. Separately, the transpiled use_direct path does not await
// safe_shallow_copy, which the transpile made async, so the direct session would get a
// Promise for its invocation context.
// PORT BACK: read the trailing keyword object in the transpiled create_session, and
// await safe_shallow_copy in create_session_from_location_dict.
class PeerSessionFactory extends ExternalAgentSessionFactory {
  constructor() {
    super(false, null);
  }

  create_session(agentUrl, invocationContext = null, invocation = null) {
    if (invocationContext != null && typeof invocationContext.get_port !== "function"
        && "invocation_context" in invocationContext) {
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
      // Shaped like the final message a partner's own session streams back.
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

