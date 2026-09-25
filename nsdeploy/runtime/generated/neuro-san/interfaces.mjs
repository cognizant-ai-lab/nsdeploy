import { exposeClassAttributes } from "../browser/shims.mjs";
import { dict } from "./stubs.mjs";
import { getenv } from "../vendor/libraries.mjs";
class AgentNameMapper {
  /**
   * Converts an agent name from manifest file to file path to this agent definition file.
   */
  agent_name_to_filepath(agent_name) {
    throw new Error();
  }
  /**
   * Converts a file path to agent definition file (relative to registry root directory)
   * to agent network name identifying it to the service.
   */
  filepath_to_agent_network_name(filepath) {
    throw new Error();
  }
}
exposeClassAttributes(AgentNameMapper);
class StorageClass {
  static {
    this.PUBLIC = "public";
  }
  static {
    this.PROTECTED = "protected";
  }
  static {
    this.TEMP = "temp";
  }
  static {
    this.ALL_PERMANENT = [StorageClass.PUBLIC, StorageClass.PROTECTED];
  }
}
exposeClassAttributes(StorageClass);
class AgentStorageSource {
  /**
   * Get AgentNetworkProvider for a specific agent
   * :param agent_name: name of an agent
   */
  get_agent_network_provider(agent_name) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentStorageSource);
class AgentNetworkProvider {
  /**
   * :return: AgentNetwork instance or null if no such AgentNetwork is available.
   */
  get_agent_network() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentNetworkProvider);
class AgentSessionConstants {
  static {
    this.DEFAULT_HTTP_PORT = 8080;
  }
  static {
    this.DEFAULT_HTTPS_PORT = 443;
  }
  static {
    this.DEFAULT_PORT = AgentSessionConstants.DEFAULT_HTTP_PORT;
  }
}
exposeClassAttributes(AgentSessionConstants);
class AgentSession extends AgentSessionConstants {
  /**
   * :param request_dict: A dictionary version of the FunctionRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the FunctionResponse
   * protobufs structure. Has the following keys:
   * "function" - the dictionary description of the function
   */
  function(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * :param request_dict: A dictionary version of the ConnectivityRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the ConnectivityResponse
   * protobufs structure. Has the following keys:
   * "connectivity_info" - the list of connectivity descriptions for
   * each node in the agent network the service
   * wants the client ot know about.
   */
  connectivity(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * :param request_dict: A dictionary version of the ChatRequest
   * protobufs structure. Has the following keys:
   * "user_message" - A ChatMessage dict representing the user input to the chat stream
   * "chat_context" - A ChatContext dict representing the state of the previous conversation
   * (if any)
   *
   * :return: An iterator of dictionary versions of the ChatResponse
   * protobufs structure. Has the following keys:
   * "response"      - An optional ChatMessage dictionary.  See chat.proto for details.
   *
   * Note that responses to the chat input might be numerous and will come as they
   * are produced until the system decides there are no more messages to be sent.
   */
  streaming_chat(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * Close the session, releasing any underlying client connection.
   *
   * For remote sessions this drops the client connection to the service and
   * unblocks an in-flight streaming_chat() on the client side. It does NOT
   * directly cancel the server-side work: the neuro-san service ends the
   * corresponding request only when it next detects the dropped connection --
   * that is, on its next result or heartbeat flush. So termination is prompt
   * while the service is streaming results (or a keep-alive heartbeat is
   * enabled), but a request that produces no output, with heartbeat and
   * request-timeout disabled, may keep running server-side until it does.
   * In short: close() guarantees release of the client connection, not
   * immediate server-side termination.
   *
   * Safe to call from another thread than the one iterating streaming_chat(),
   * and safe to call more than once.
   *
   * A remote session is single-use with respect to close(): once closed it
   * cannot be reused -- subsequent streaming_chat(), function() and
   * connectivity() calls raise AgentSessionClosedError (see is_closed()).
   *
   * The default implementation is a no-op: sessions that hold no external
   * connection (e.g. in-process direct sessions) have nothing to close and
   * are never considered closed.
   */
  close() {
    return;
  }
  /**
   * :return: True if close() has been called on this session, in which case
   * further streaming_chat()/function()/connectivity() calls raise
   * AgentSessionClosedError. The default is False for sessions that
   * hold no external connection and therefore cannot be closed.
   */
  is_closed() {
    return false;
  }
}
exposeClassAttributes(AgentSession);
class ConciergeSession {
  static {
    this.DEFAULT_HTTP_PORT = AgentSession.DEFAULT_HTTP_PORT;
  }
  static {
    this.DEFAULT_PORT = AgentSession.DEFAULT_HTTP_PORT;
  }
  /**
   * :param request_dict: A dictionary version of the ConciergeRequest
   * protobuf structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the ConciergeResponse
   * protobuf structure. Has the following keys:
   * "agents" - the sequence of dictionaries describing available agents
   */
  list(request_dict) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ConciergeSession);
class ReservationsStorage {
  /**
   * Add a set of reservations for agent networks en-masse
   *
   * :param reservations_dict: A mapping of Reservation -> some deployable entity
   * :param source: A string describing where the deployment was coming from
   */
  async add_reservations(reservations_dict, source) {
    throw Error("Method not implemented");
  }
  /**
   * Extract a single reservation.
   *
   * :param obj_key: unique key for the reservation
   * :return: Tuple of (reservation, agent data) if successful
   * and reservation is not expired,
   * (None, null) otherwise
   */
  get_one_reservation(obj_key) {
    throw Error("Method not implemented");
  }
  /**
   * Remove Reservations that are expired
   */
  expire_reservations() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ReservationsStorage);
class Reservationist {
  static {
    this.DEFAULT_LIFETIME = 24 * 60 * 60;
  }
  /**
   * Creates a reservation for a specific time period.
   *
   * :param lifetime_in_seconds: The lifetime of the reservation
   * :param prefix: A string prefix to prepend to the id so as to provide external context.
   * :return: A new Reservation object corresponding to the request.
   */
  reserve(lifetime_in_seconds, DEFAULT_LIFETIME, prefix) {
    throw Error("Method not implemented");
  }
  /**
   * Python context manager protocol entrypoint.
   * This is what gets called when you enter a with-statement.
   */
  async __aenter__() {
  }
  /**
   * Deploy multiple Reservations.
   *
   * :param deployment_dict: A dictionary whose keys are Reservation objects
   * previously obtained with reserve() and whose values are each an
   * object to deploy using the key as Reservation.
   * :param confirmation: When True, indicates a confirmation Event is desired.
   * When False (the default), no such confirmation is needed.
   * :return: Either a confiramtion Event object whose wait() method will confirm
   * that the deployment is complete, or null, depending on the value passed
   * for confirmation.
   */
  async deploy(deployment_dict, confirmation) {
    throw Error("Method not implemented");
  }
  /**
   * Python context manager protocol exit point.
   * This is what gets called when you exit a with-statement.
   * This triggers the initiation of the deployment.
   * :return: True to suppress exception. False or null to propagate exception.
   */
  async __aexit__(exc_type, exc_val, exc_tb) {
  }
  /**
   * Convenience method to deploy a single Reservation.
   *
   * :param reservation: A Reservation object previously obtained with reserve()
   * :param deployment: The object to deploy
   * :param confirmation: When True, indicates a confirmation Event is desired.
   * When False (the default), no such confirmation is needed.
   * :return: Either a confiramtion Event object whose wait() method will confirm
   * that the deployment is complete, or null, depending on the value passed
   * for confirmation.
   */
  async deploy_one(reservation, deployment, confirmation) {
    let deployment_dict = { [reservation]: deployment };
    let event = await this.deploy(deployment_dict, { confirmation });
    return event;
  }
  /**
   * Allow passing of validation parameters when using a with-statement.
   * These get reset in __aexit()__.
   *
   * :param external_networks: A list of external network names
   * :param mcp_servers: A list of MCP servers, as read in from a mcp_info.hocon file
   * :return: The instance
   */
  validate_with(external_networks, mcp_servers) {
    let _ = [external_networks, mcp_servers];
    return this;
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
  }
}
exposeClassAttributes(Reservationist);
class Reservation {
  /**
   * Constructor
   *
   * :param lifetime_in_seconds: The number of seconds the reservation is allowed to exist.
   */
  constructor(lifetime_in_seconds) {
    this.id = null;
    this.lifetime_in_seconds = lifetime_in_seconds;
    this.expiration_time_in_seconds = 0;
  }
  /**
   * :return: The id associated with the reservation instance
   */
  get_reservation_id() {
    return this.id;
  }
  /**
   * :return: The lifetime in seconds associated with the reservation
   */
  get_lifetime_in_seconds() {
    return this.lifetime_in_seconds;
  }
  /**
   * :return: The expiration time in seconds since the epoch, ala time.time().
   */
  get_expiration_time_in_seconds() {
    return this.expiration_time_in_seconds;
  }
  /**
   * :return: A url associated with the reservation.
   * Can be null if this is not an option for what we are reserving.
   */
  get_url() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Reservation);
class ContextTypeLlmFactory {
  /**
   * Goes through the process of loading any user extensions and/or configuration
   * files
   */
  load() {
    throw Error("Method not implemented");
  }
  /**
   * Create an llm instance BaseLanguageModel from the fully-specified llm config.
   * :param config: The fully specified llm config from which the LLM instance
   * should be created.
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :return: An llm instance native to the context type.
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   * Can return null if required llm_config keys are not provided.
   */
  create_llm(config, sly_data) {
    throw Error("Method not implemented");
  }
  /**
   * :param config: A dictionary which describes which LLM to use, perhaps with fallbacks specified.
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :param num_fallbacks: The number of fallbacks to try. Default value of null implies all.
   * :return: An LLM instance native to the context type that deals with fallback specifications.
   */
  create_llm_withFallbacks(config, sly_data, num_fallbacks) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ContextTypeLlmFactory);
class EnvironmentConfiguration {
  /**
   * :param config: The config dictionary to search
   * :param key: The key for the config to look for
   * :param env_key: The os.environ key whose value should be gotten if either
   * the key does not exist or the value for the key is null
   * :param none_obj:  An optional object instance to test.
   * If present this method will return null, implying
   * that some other external object/mechanism is supplying the values.
   */
  static get_value_or_env(config, key, env_key, none_obj) {
    if (none_obj != null) {
      return null;
    }
    const value = null;
    if (config != null) {
      const value2 = dict.get(config, key);
    }
    if (value == null && env_key != null) {
      const value2 = getenv(env_key);
    }
    return value;
  }
}
exposeClassAttributes(EnvironmentConfiguration);
class LingeringResource {
  /**
   * Release resources owned by this context when the request is complete.
   * This can happen earlier than when the work is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_request(parent_resource) {
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
  }
}
exposeClassAttributes(LingeringResource);
class ContextTypeToolboxFactory {
  /**
   * Goes through the process of loading any user extensions and/or configuration
   * files
   */
  load() {
    throw Error("Method not implemented");
  }
  /**
   * Create a tool instance from the fully-specified tool config.
   * :param tool_name: The name of the tool to instantiate.
   * :param user_args: Arguments provided by the user, which override the args in config file.
   * :return: A tool instance native to the context type.
   * Can raise a Error if the config's class or tool_name value is
   * unknown to this method.
   */
  create_tool_from_toolbox(tool_name, user_args) {
    throw Error("Method not implemented");
  }
  /**
   * Get class of the shared coded tool from toolbox
   *
   * :param tool_name: The name of the tool
   * :return: The class of the coded tool from toolbox.
   * Can raise a Error if the tool_name value is
   * unknown to this method.
   */
  get_shared_coded_tool_class(tool_name) {
    throw Error("Method not implemented");
  }
  /**
   * :param tool_name: The name of the tool.
   * :return: The toolbox dictionary entry for the tool name
   */
  get_tool_info(tool_name) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ContextTypeToolboxFactory);
class CallableActivation extends LingeringResource {
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    throw Error("Method not implemented");
  }
  /**
   * :return: A List of origin dictionaries indicating the origin of the tool.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  get_origin() {
    throw Error("Method not implemented");
  }
  /**
   * Release resources owned by this context when the request is complete.
   * This can happen earlier than when the work is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_request(parent_resource) {
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(CallableActivation);
class ErrorFormatter {
  /**
   * Format an error message
   *
   * :param agent_name: A string describing the name of the agent experiencing
   * the error.
   * :param message: The specific message describing the error occurrence.
   * :param details: An optional string describing further details of how/where the
   * error occurred.  Think: traceback.
   * :return: String encapsulation and/or filter of the error information
   * presented in the arguments.
   */
  format(agent_name, message, details) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ErrorFormatter);
class AgentProgressReporter {
  /**
   * Reports the structure and optional message to the chat message stream returned to the client
   * To be used from within CodedTool.async_invoke().
   *
   * :param structure: The Dictionary instance to write as progress.
   * All keys and values must be JSON-serializable.
   * :param content: An optional message to send to the client
   */
  async async_report_progress(structure, content) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentProgressReporter);
class CodedTool {
  /**
   * This method is provided as a convenience for an "easy" start to using
   * coded-tools.
   *
   * Know that any CodedTool is run within the confines of a Python asynchronous
   * EventLoop., unknown synchronous blocking that happens - like making a call to a
   * web service over a socket, or something that inherently sleep()s - *will* also
   * block all other agent operations.  This is not so bad in a low-traffic or
   * test environment, but when scaling up, you really really want to embrace
   * and override the async_invoke() method below instead of this one.
   *
   * The idea is to allow easy development of CodedTools and use of invoke() is not so bad in a
   * low-traffic or test environment. However, when scaling up, you really really want to embrace
   * and override the async_invoke() method below instead of this one if at all possible,
   * as it is inherently more efficient.
   *
   * :param args: An argument dictionary whose keys are the parameters
   * to the coded tool and whose values are the values passed for them
   * by the calling agent.  This dictionary is to be treated as read-only.
   * :param sly_data: A dictionary whose keys are defined by the agent hierarchy,
   * but whose values are meant to be kept out of the chat stream.
   *
   * This dictionary is largely to be treated as read-only.
   * It is possible to add key/value pairs to this dict that do not
   * yet exist as a bulletin board, as long as the responsibility
   * for which coded_tool publishes new entries is well understood
   * by the agent chain implementation and the coded_tool implementation
   * adding the data is not invoke()-ed more than once.
   * :return: A return value that goes into the chat stream.
   */
  invoke(args, sly_data) {
  }
  /**
   * Called when the coded tool is invoked asynchronously by the agent hierarchy.
   * Strongly consider overriding this method instead of the "easier" synchronous
   * invoke() version above when the possibility of making any kind of call that could block
   * (like sleep() or a socket read/write out to a web service) is within the
   * scope of your CodedTool and can be done asynchronously, especially within
   * the context of your CodedTool running within a server.
   *
   * If you find your CodedTools can't help but synchronously block,
   * strongly consider looking into using the asyncio.to_thread() function
   * to not block the EventLoop for other requests.
   * See: https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread
   * async def async_invoke(this, args: Record<string, unknown>, sly_data: Record<string, unknown>) -> Any:
   * return await asyncio.to_thread(this.invoke, args, sly_data)
   *
   * :param args: An argument dictionary whose keys are the parameters
   * to the coded tool and whose values are the values passed for them
   * by the calling agent.  This dictionary is to be treated as read-only.
   * :param sly_data: A dictionary whose keys are defined by the agent hierarchy,
   * but whose values are meant to be kept out of the chat stream.
   *
   * This dictionary is largely to be treated as read-only.
   * It is possible to add key/value pairs to this dict that do not
   * yet exist as a bulletin board, as long as the responsibility
   * for which coded_tool publishes new entries is well understood
   * by the agent chain implementation and the coded_tool implementation
   * adding the data is not invoke()-ed more than once.
   * :return: A return value that goes into the chat stream.
   */
  async async_invoke(args, sly_data) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(CodedTool);
class AgentToolFactory {
  /**
   * Create an active node for an agent from its spec.
   *
   * :param parent_run_context: The RunContext of the agent calling this method
   * :param parent_agent_spec: The spec of the agent calling this method.
   * :param name: The name of the agent to get out of the registry
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   * :param args: A dictionary of arguments for the newly constructed agent
   * :param factory: A factory that will be used to create the agent tool
   * :param invocation: The invocation style of the activation.
   * :return: The CallableActivation agent referred to by the name.
   */
  create_agent_activation(parent_run_context, parent_agent_spec, name, sly_data, args, factory, invocation) {
    throw Error("Method not implemented");
  }
  /**
   * :return: The entire config dictionary given to the instance.
   */
  get_config() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The path under which tools for this registry should be looked for.
   */
  get_agent_tool_path() {
    throw Error("Method not implemented");
  }
  /**
   * :param agent_spec: A single agent to register
   * :return: The agent name as per the spec
   */
  get_name_from_spec(agent_spec) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentToolFactory);
class RunTarget {
  /**
   * Entry point method for the run.
   *
   * :param inputs: A list of inputs from the user.
   * :return: The outputs of the run.
   */
  async run_it(inputs) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(RunTarget);
class ContextTypeTracingContextFactory {
  /**
   * Creates a RunTarget based on another RunTarget
   *
   * :param config: The configuration for the tracing context
   * :param run_target: The RunTarget instance to be traced
   * :return: An appropriate TracingContext
   */
  create_tracing_context(config, run_target) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ContextTypeTracingContextFactory);
class TracingContext extends RunTarget {
  /**
   * Entry point method for the run.
   *
   * :param inputs: A list of inputs from the user.
   * :return: The outputs of the run.
   */
  async run_it(inputs) {
    throw Error("Method not implemented");
  }
  /**
   * Creates a copy the tracing context.
   *
   * :return: A clone of the tracing context.
   */
  clone() {
    throw Error("Method not implemented");
  }
  /**
   * Augment the configuration however the implementation sees fit (if at all).
   * :param runnable_config: The config for the runnable
   * :return: The augmented config
   */
  augment_config(runnable_config) {
    throw Error("Method not implemented");
  }
  /**
   * Flush the tracing context.
   */
  flush() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(TracingContext);
class AsyncAgentSessionFactory {
  /**
   * :param agent_url: A url string pointing to an external agent that came from
   * a tools list in an agent spec.
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   *
   * Note: At this interface level we are typing this as, unknown to avoid
   * an import cycle.  This will always be an InvocationContext.
   *
   * :param invocation: String describing how the agent wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   *
   * :return: An implementation of AsyncAgentSession through which
   * communications about external agents can be made.
   */
  create_session(agent_url, invocation_context, invocation) {
    throw Error("Method not implemented");
  }
  /**
   * :return: When True, will use a Direct session for external agents that would reside on the same server.
   */
  is_use_direct() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AsyncAgentSessionFactory);
class AsyncAgentSession extends AgentSessionConstants {
  /**
   * :param request_dict: A dictionary version of the FunctionRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the FunctionResponse
   * protobufs structure. Has the following keys:
   * "function" - the dictionary description of the function
   */
  async function(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * :param request_dict: A dictionary version of the ConnectivityRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the ConnectivityResponse
   * protobufs structure. Has the following keys:
   * "connectivity_info" - the list of connectivity descriptions for
   * each node in the agent network the service
   * wants the client ot know about.
   */
  async connectivity(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * :param request_dict: A dictionary version of the ChatRequest
   * protobufs structure. Has the following keys:
   * "user_message" - A ChatMessage dict representing the user input to the chat stream
   * "chat_context" - A ChatContext dict representing the state of the previous conversation
   * (if any)
   *
   * :return: An iterator of dictionary versions of the ChatResponse
   * protobufs structure. Has the following keys:
   * "response"      - An optional ChatMessage dictionary.  See chat.proto for details.
   *
   * Note that responses to the chat input might be numerous and will come as they
   * are produced until the system decides there are no more messages to be sent.
   */
  async *streaming_chat(request_dict) {
    throw Error("Method not implemented");
  }
  /**
   * Close the session, releasing any underlying client connection.
   *
   * For remote sessions this drops the client connection to the service and
   * unblocks an in-flight streaming_chat() on the client side. It does NOT
   * directly cancel the server-side work: the neuro-san service ends the
   * corresponding request only when it next detects the dropped connection --
   * that is, on its next result or heartbeat flush. So termination is prompt
   * while the service is streaming results (or a keep-alive heartbeat is
   * enabled), but a request that produces no output, with heartbeat and
   * request-timeout disabled, may keep running server-side until it does.
   * In short: close() guarantees release of the client connection, not
   * immediate server-side termination.
   *
   * This is a synchronous method (no await needed) so it can be invoked from
   * a supervising sync context or another thread; implementations that own an
   * event-loop-bound client schedule the actual close on that loop.
   * Safe to call more than once.
   *
   * A remote session is single-use with respect to close(): once closed it
   * cannot be reused -- subsequent streaming_chat(), function() and
   * connectivity() calls raise AgentSessionClosedError (see is_closed()).
   *
   * The default implementation is a no-op: sessions that hold no external
   * connection (e.g. in-process direct sessions) have nothing to close and
   * are never considered closed.
   */
  close() {
    return;
  }
  /**
   * :return: True if close() has been called on this session, in which case
   * further streaming_chat()/function()/connectivity() calls raise
   * AgentSessionClosedError. The default is False for sessions that
   * hold no external connection and therefore cannot be closed.
   */
  is_closed() {
    return false;
  }
}
exposeClassAttributes(AsyncAgentSession);
class InvocationContext extends LingeringResource {
  /**
   * Starts the active components of this invocation context.
   * Do this separately from constructor for more control.
   */
  start() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The effective invocation of the session
   */
  get_effective_invocation() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The AsyncAgentSessionFactory associated with the invocation
   */
  get_async_session_factory() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The AsyncioExecutor associated with the invocation
   */
  get_asyncio_executor() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The Origination instance carrying state about tool instantation
   * during the course of the AgentSession.
   */
  get_origination() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The Journal instance that allows message reporting
   * during the course of the AgentSession.
   */
  get_journal() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The AsyncCollatingQueue instance via which messages are streamed to the
   * QueueFilter mechanics
   */
  get_queue() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The metadata to pass along with any request
   */
  get_metadata() {
    throw Error("Method not implemented");
  }
  /**
   * Release resources owned by this context when the request is complete.
   * This can happen earlier than when the work is complete.
   *
   * :param parent_resource: The parent resource, if any
   */
  async close_of_request(parent_resource) {
    throw Error("Method not implemented");
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: The parent resource, if any
   */
  async close_of_work(parent_resource) {
    throw Error("Method not implemented");
  }
  /**
   * :return: The request reporting dictionary
   */
  get_request_reporting() {
    throw Error("Method not implemented");
  }
  /**
   * :return: True if this instance is a clone of a request's original
   * InvocationContext, created to invoke an external agent network
   * on the same server via a direct session.
   * False for the original InvocationContext of a request.
   */
  is_cloned() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The ContextTypeLlmFactory instance for the session
   */
  get_llm_factory() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The ContextTypeToolboxFactory instance for the session
   */
  get_toolbox_factory() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The Reservationist instance for the session
   */
  get_reservationist() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The port on which the server was started
   */
  get_port() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The Event (synchronous) that will be set when work is done for this event
   */
  get_work_done_event() {
    throw Error("Method not implemented");
  }
  /**
   * :param resource: The resource to add
   */
  add_resource(resource) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(InvocationContext);
export {
  AgentNameMapper,
  AgentNetworkProvider,
  AgentProgressReporter,
  AgentSession,
  AgentSessionConstants,
  AgentStorageSource,
  AgentToolFactory,
  AsyncAgentSession,
  AsyncAgentSessionFactory,
  CallableActivation,
  CodedTool,
  ConciergeSession,
  ContextTypeLlmFactory,
  ContextTypeToolboxFactory,
  ContextTypeTracingContextFactory,
  EnvironmentConfiguration,
  ErrorFormatter,
  InvocationContext,
  LingeringResource,
  Reservation,
  Reservationist,
  ReservationsStorage,
  RunTarget,
  StorageClass,
  TracingContext
};
