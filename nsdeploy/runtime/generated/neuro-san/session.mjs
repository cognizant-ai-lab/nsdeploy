import { dict, suppress, Lock, ClientTimeout, ClientSession, get_running_loop, len, RuntimeError, run_coroutine_threadsafe, contains, Event } from "./stubs.mjs";
import { DictionaryExtractor, LoggingSetup } from "./leaf_common.mjs";
import { AgentSession, ConnectivityReporter, DataDrivenChatSession, QueueFilter, AsyncAgentSession, AgentSessionConstants, AsyncAgentSessionFactory, ExternalAgentParsing, StorageClass, InvocationContext, Origination, AsyncCollatingQueue, MessageJournal, LingeringResource } from "./internals.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
import { getLogger, loads, partial, isinstance2 } from "../vendor/libraries.mjs";
import { DecodeUtils } from "./message.mjs";
import { process } from "../browser/process.mjs";
class DirectAgentSession extends AgentSession {
  /**
   * Constructor
   *
   * :param agent_network: The AgentNetwork to use for the session.
   * :param invocation_context: The SessionInvocationContext to use to consult
   * for policy objects scoped at the invocation level.
   * May be null for sessions that only serve connectivity()
   * or function(); chat methods require a real instance.
   * :param metadata: A dictionary of request metadata to be forwarded
   * to subsequent yet-to-be-made requests.
   * :param security_cfg: A dictionary of parameters used to
   * secure the TLS and the authentication of the gRPC
   * connection.  Supplying this implies use of a secure
   * GRPC Channel.  If null, uses insecure channel.
   * :param umbrella_timeout: A Timeout object to periodically check in loops.
   * Default is null (no timeout).
   * :param toolbox_factory: An optional ContextTypeToolboxFactory built from
   * the same agent network's config, so connectivity reporting
   * does not have to re-read toolbox info files per request.
   * May be passed pre-loaded; connectivity reporting will
   * load() it (a no-op if already loaded).
   * If null, the invocation_context's toolbox factory is used
   * when available; failing that, connectivity reporting
   * builds one from the agent network's config.
   */
  constructor(agent_network, invocation_context, metadata, security_cfg, umbrella_timeout, toolbox_factory) {
    super();
    this._metadata = metadata;
    this._security_cfg = security_cfg;
    this.invocation_context = invocation_context;
    this.agent_network = agent_network;
    this.request_id = null;
    this.umbrella_timeout = umbrella_timeout;
    this.toolbox_factory = toolbox_factory;
    if (this.toolbox_factory == null && invocation_context != null) {
      this.toolbox_factory = invocation_context.get_toolbox_factory();
    }
    if (metadata != null) {
      this.request_id = dict.get(metadata, "request_id");
    }
  }
  /**
   * :param request_dict: A dictionary version of the FunctionRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the FunctionResponse
   * protobufs structure. Has the following keys:
   * "function" - the dictionary description of the function
   */
  function(request_dict) {
    let _ = request_dict;
    let response_dict = {};
    let front_man = this.agent_network.find_front_man();
    if (front_man != null) {
      let spec = this.agent_network.get_agent_tool_spec(front_man);
      let empty = {};
      let _function = dict.get(spec, "function", empty);
      response_dict = { "function": _function };
    }
    return response_dict;
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
    let _ = request_dict;
    let reporter = new ConnectivityReporter(this.agent_network, this.toolbox_factory);
    let config = this.agent_network.get_config();
    let metadata = dict.get(config, "metadata");
    let connectivity_info = reporter.report_network_connectivity();
    let response_dict = { "connectivity_info": connectivity_info };
    if (metadata != null) {
      response_dict["metadata"] = metadata;
    }
    return response_dict;
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
    let extractor = new DictionaryExtractor(request_dict, ".");
    let user_input = extractor.get("user_message.text");
    let chat_session = new DataDrivenChatSession(this.agent_network);
    let template_response_dict = {};
    if (chat_session == null || user_input == null) {
      yield template_response_dict;
      return;
    }
    let chat_filter = dict.get(request_dict, "chat_filter");
    let chat_context = dict.get(request_dict, "chat_context");
    let sly_data = dict.get(request_dict, "sly_data");
    let queue_filter = new QueueFilter(chat_filter, this.agent_network);
    queue_filter.apply_to_journal(this.invocation_context.get_journal());
    let asyncio_executor = this.invocation_context.get_asyncio_executor();
    let task = asyncio_executor.submit(this.request_id, chat_session.streaming_chat.bind(chat_session), user_input, this.invocation_context, sly_data, chat_context);
    let _ = task;
    try {
      for await (const message of this.invocation_context.get_queue()) {
        if (message != null) {
          yield message;
        }
      }
    } finally {
      const _resource = suppress(Error);
      try {
        this.invocation_context.finish_request();
      } finally {
        _resource.close?.();
      }
    }
  }
  /**
   * Allows for re-use of the same instance for clients
   */
  reset() {
    this.invocation_context.reset();
  }
  /**
   * Tears down resources created
   */
  close() {
    if (this.invocation_context == null) {
      return;
    }
    this.invocation_context.finish_request();
    this.invocation_context = null;
  }
}
exposeClassAttributes(DirectAgentSession);
class AsyncDirectAgentSession extends AsyncAgentSession {
  static {
    this.LOG_AGENT_NETWORK_USAGE = true;
  }
  /**
   * Constructor
   *
   * :param agent_network: The AgentNetwork to use for the session.
   * :param invocation_context: The SessionInvocationContext to use to consult
   * for policy objects scoped at the invocation level.
   * May be null for sessions that only serve connectivity()
   * or function(); chat methods require a real instance.
   * :param metadata: A dictionary of request metadata to be forwarded
   * to subsequent yet-to-be-made requests.
   * :param security_cfg: A dictionary of parameters used to
   * secure the TLS and the authentication of the gRPC
   * connection.  Supplying this implies use of a secure
   * GRPC Channel.  If null, uses insecure channel.
   * :param toolbox_factory: An optional ContextTypeToolboxFactory built from
   * the same agent network's config, so connectivity reporting
   * does not have to re-read toolbox info files per request.
   * May be passed pre-loaded; connectivity reporting will
   * load() it (a no-op if already loaded).
   * If null, the invocation_context's toolbox factory is used
   * when available; failing that, connectivity reporting
   * builds one from the agent network's config.
   */
  constructor(agent_network, invocation_context, metadata, security_cfg, toolbox_factory) {
    super();
    this._metadata = metadata;
    this._security_cfg = security_cfg;
    this.invocation_context = invocation_context;
    this.agent_network = agent_network;
    this.request_id = null;
    this.toolbox_factory = toolbox_factory;
    if (this.toolbox_factory == null && invocation_context != null) {
      this.toolbox_factory = invocation_context.get_toolbox_factory();
    }
    if (metadata != null) {
      this.request_id = dict.get(metadata, "request_id");
    }
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Logs the usage of the agent network if enabled.
   * :param operation: The operation being performed (e.g., "function", "connectivity", "streaming_chat").
   */
  _log_agent_network_usage(operation) {
    if (AsyncDirectAgentSession.LOG_AGENT_NETWORK_USAGE) {
      this.logger.info("Agent network '%s' (ID: %d) used for operation: %s", this.agent_network.get_network_name(), Number(this.agent_network), operation);
    }
  }
  /**
   * :param request_dict: A dictionary version of the FunctionRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the FunctionResponse
   * protobufs structure. Has the following keys:
   * "function" - the dictionary description of the function
   */
  async function(request_dict) {
    this._log_agent_network_usage("function");
    let _ = request_dict;
    let response_dict = {};
    let front_man = this.agent_network.find_front_man();
    if (front_man != null) {
      let spec = this.agent_network.get_agent_tool_spec(front_man);
      let empty = {};
      let _function = dict.get(spec, "function", empty);
      response_dict = { "function": _function };
    }
    return response_dict;
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
    this._log_agent_network_usage("connectivity");
    let _ = request_dict;
    let reporter = new ConnectivityReporter(this.agent_network, this.toolbox_factory);
    let config = this.agent_network.get_config();
    let metadata = dict.get(config, "metadata");
    let connectivity_info = reporter.report_network_connectivity();
    let response_dict = { "connectivity_info": connectivity_info };
    if (metadata != null) {
      response_dict["metadata"] = metadata;
    }
    return response_dict;
  }
  /**
   * :param request_dict: A dictionary version of the ChatRequest
   * protobufs structure. Has the following keys:
   * "user_message" - A ChatMessage dict representing the user input to the chat stream
   * "chat_context" - A ChatContext dict representing the state of the previous conversation
   * (if any)
   * :return: An iterator of dictionary versions of the ChatResponse
   * protobufs structure. Has the following keys:
   * "response"      - An optional ChatMessage dictionary.  See chat.proto for details.
   *
   * Note that responses to the chat input might be numerous and will come as they
   * are produced until the system decides there are no more messages to be sent.
   */
  async *streaming_chat(request_dict) {
    this._log_agent_network_usage("streaming_chat");
    let extractor = new DictionaryExtractor(request_dict, ".");
    let user_input = extractor.get("user_message.text");
    let chat_session = new DataDrivenChatSession(this.agent_network);
    let template_response_dict = {};
    if (chat_session == null || user_input == null) {
      yield template_response_dict;
      return;
    }
    let chat_filter = dict.get(request_dict, "chat_filter");
    let chat_context = dict.get(request_dict, "chat_context");
    let sly_data = dict.get(request_dict, "sly_data");
    let queue_filter = new QueueFilter(chat_filter, this.agent_network);
    queue_filter.apply_to_journal(this.invocation_context.get_journal());
    let asyncio_executor = this.invocation_context.get_asyncio_executor();
    let task = asyncio_executor.submit(this.request_id, chat_session.streaming_chat.bind(chat_session), user_input, this.invocation_context, sly_data, chat_context);
    let _ = task;
    let queue_generator = this.invocation_context.get_queue();
    try {
      let message = null;
      for await (const message2 of queue_generator) {
        if (message2 != null) {
          yield message2;
        }
      }
    } finally {
      const _resource = suppress(Error);
      try {
        this.invocation_context.finish_request();
      } finally {
        _resource.close?.();
      }
    }
  }
  /**
   * Allows for re-use of the same instance for clients
   */
  reset() {
    this.invocation_context.reset();
  }
  /**
   * Tears down all resources created
   */
  close() {
    if (this.invocation_context == null) {
      return;
    }
    this.invocation_context.finish_request();
    this.invocation_context = null;
  }
}
exposeClassAttributes(AsyncDirectAgentSession);
class AbstractHttpServiceAgentSession extends AgentSessionConstants {
  /**
   * Creates a AsyncAgentSession that asynchronously connects to the
   * Agent Service and delegates its implementations to the service.
   *
   * :param host: the service host to connect to
   * If null, will use a default
   * :param port: the service port
   * If null, will use a default
   * :param timeout_in_seconds: timeout to use when communicating
   * with the service
   * :param metadata: A grpc metadata of key/value pairs to be inserted into
   * the header. Default is null. Preferred format is a
   * dictionary of string keys to string values.
   * :param security_cfg: An optional dictionary of parameters used to
   * secure the TLS and the authentication of the gRPC
   * connection.  Supplying this implies use of a secure
   * GRPC Channel.  Default is null, uses insecure channel.
   * :param umbrella_timeout: A Timeout object under which the length of all
   * looping and retries should be considered
   * :param streaming_timeout_in_seconds: timeout to use when streaming to/from
   * the service. Default is null, indicating connection should
   * stay open until the (last) result is yielded.
   * :param agent_name: The name of the agent to talk to
   */
  constructor(host, port, timeout_in_seconds, metadata, security_cfg, umbrella_timeout, streaming_timeout_in_seconds, agent_name) {
    super();
    let _ = umbrella_timeout;
    this.security_cfg = security_cfg;
    this.use_host = "localhost";
    if (host != null) {
      this.use_host = host;
    }
    this.use_port = String(AbstractHttpServiceAgentSession.DEFAULT_HTTP_PORT);
    if (port != null) {
      this.use_port = port;
    }
    this.agent_name = agent_name;
    this.timeout_in_seconds = timeout_in_seconds;
    this.streaming_timeout_in_seconds = streaming_timeout_in_seconds;
    this.metadata = metadata;
  }
  /**
   * :param method: The method endpoint we wish to reach
   * :return: The full URL for accessing the method, given the host, port and agent_name.
   */
  get_request_path(method) {
    let scheme = "http";
    if (this.security_cfg != null) {
      scheme = "https";
    }
    let require_https = (process.env["AGENT_SESSION_REQUIRE_HTTPS"] ?? "false").toLowerCase() == "true";
    if (require_https && scheme != "https") {
      throw new Error(`AGENT_SESSION_REQUIRE_HTTPS=true requires https. Configure the ${this.constructor.name} accordingly`);
    }
    if (this.agent_name == null) {
      return `${scheme}://${this.use_host}:${this.use_port}/api/v1/${method}`;
    }
    return `${scheme}://${this.use_host}:${this.use_port}/api/v1/${this.agent_name}/${method}`;
  }
  /**
   * Get headers for any outgoing request
   */
  get_headers() {
    let headers = this.metadata;
    if (headers == null) {
      headers = {};
    }
    return headers;
  }
  /**
   * Method returning general help message for http connectivity problems.
   * :param path: url path of a request
   * :return: help message
   */
  help_message(path) {
    let message = `
        Some basic suggestions to help debug connectivity issues:
        1. Ensure the server is running and reachable:
           ping <server_address>
           curl -v <server_url>
        2. Check network issues:
           traceroute <server_address>  # Linux/macOS
           tracert <server_address>  # Windows
        3. Ensure you are using correct protocol (http/https) and port number;
        4. Run service health check:
           curl <server_url:server_port>
        5. Try testing with increased timeout;
        6. Did you misspell the agent and/or method name in your ${path} request path?
        7. If working with a local docker container:
           7.1 Does your http port EXPOSEd in the Dockerfile match your value for AGENT_HTTP_PORT?
           7.2 Did you add a -p <server_port>:<server_port> to your docker run command line to map container port(s)
               to your local ones?
        8. Is the agent turned on in your manifest.hocon?
        9. If you are attempting to use https, know that the default server configurations do not
           provide any of the necessary certificates for this to work and any certs used will
           need to be well known.  If you're unfamiliar with this process, it's a big deal.
           Try regular http instead.
        10. Is the server your are attempting to reach running with an AGENT_AUTHORIZER?
            If so, have the administrator for the server check its authorization
            policy/database to be sure the your user has the correct permissions for the network.
        `;
    return message;
  }
}
exposeClassAttributes(AbstractHttpServiceAgentSession);
;
`
See class comment for details.
`;
class AgentSessionClosedError extends Error {
}
exposeClassAttributes(AgentSessionClosedError);
class AsyncHttpServiceAgentSession extends AbstractHttpServiceAgentSession {
  /**
   * Constructor. Delegates all connection parameters to the base class and
   * adds cancellation state so an in-flight streaming_chat() can be aborted
   * via close(). aiohttp objects are bound to their event loop and are not
   * thread-safe, so close() schedules the actual close on that loop.
   */
  constructor(...args) {
    super(...args);
    this._stream_lock = new Lock();
    this._active_response = null;
    this._active_session = null;
    this._active_loop = null;
    this._closed = false;
  }
  /**
   * :param request_dict: A dictionary version of the FunctionRequest
   * protobufs structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the FunctionResponse
   * protobufs structure. Has the following keys:
   * "function" - the dictionary description of the function
   */
  async function(request_dict) {
    this._raise_if_closed();
    let path = this.get_request_path("function");
    let result_dict = null;
    let timeout = null;
    try {
      if (this.timeout_in_seconds != null) {
        timeout = new ClientTimeout(this.timeout_in_seconds);
      }
      const session = new ClientSession(this.get_headers, timeout);
      try {
        const response = session.get(path, request_dict);
        try {
          result_dict = await response.json();
          return result_dict;
        } finally {
          await response.close?.();
        }
      } finally {
        await session.close?.();
      }
    } catch (exc) {
      throw new Error(this.help_message(path));
    }
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
    this._raise_if_closed();
    let path = this.get_request_path("connectivity");
    let result_dict = null;
    let timeout = null;
    try {
      if (this.timeout_in_seconds != null) {
        timeout = new ClientTimeout(this.timeout_in_seconds);
      }
      const session = new ClientSession(this.get_headers, timeout);
      try {
        const response = session.get(path, request_dict);
        try {
          result_dict = await response.json();
          return result_dict;
        } finally {
          await response.close?.();
        }
      } finally {
        await session.close?.();
      }
    } catch (exc) {
      throw new Error(this.help_message(path));
    }
  }
  /**
   * :param request_dict: A dictionary version of the ChatRequest
   * protobufs structure. Has the following keys:
   * "user_message" - A ChatMessage dict representing the user input to the chat stream
   * "chat_context" - A ChatContext dict representing the state of the previous conversation
   * (if any)
   * :return: An iterator of dictionary versions of the ChatResponse
   * protobufs structure. Has the following keys:
   * "response"      - An optional ChatMessage dictionary.  See chat.proto for details.
   *
   * Note that responses to the chat input might be numerous and will come as they
   * are produced until the system decides there are no more messages to be sent.
   */
  async *streaming_chat(request_dict) {
    let separator = "\n";
    let max_chunk_size = 64 * 1024;
    let path = this.get_request_path("streaming_chat");
    let accumulator = new Uint8Array();
    let index = 0;
    let unicode_line = "";
    this._raise_if_closed();
    const _resource = this._stream_lock;
    try {
      this._active_loop = get_running_loop();
    } finally {
      _resource.close?.();
    }
    let timeout = new ClientTimeout({ total: null });
    if (this.streaming_timeout_in_seconds != null) {
      timeout = new ClientTimeout({ total: this.streaming_timeout_in_seconds });
    }
    let session = new ClientSession(this.get_headers, timeout);
    let abort = false;
    const next_with = this._stream_lock;
    try {
      let _ = next_with;
      if (this._closed) {
        abort = true;
      } else {
        this._active_session = session;
      }
    } finally {
      next_with.close?.();
    }
    if (abort) {
      await session.close();
      throw new AgentSessionClosedError("async HTTP agent session has been closed");
    }
    try {
      const _resource2 = session;
      try {
        const response = session.post(path, { json: request_dict });
        try {
          response.raise_for_status();
          const _resource3 = this._stream_lock;
          try {
            if (this._closed) {
              throw new AgentSessionClosedError("async HTTP agent session has been closed");
            }
            this._active_response = response;
          } finally {
            _resource3.close?.();
          }
          for (const data of response.content.iter_chunked(max_chunk_size)) {
            accumulator.push(...data);
            index = accumulator.indexOf(separator);
            while (index >= 0) {
              let single_line_bytes = accumulator.slice(void 0, index);
              unicode_line = DecodeUtils.decode(single_line_bytes, "utf-8");
              unicode_line = unicode_line.trim();
              if (unicode_line) {
                let result_dict = loads(unicode_line);
                yield result_dict;
              }
              accumulator = accumulator.slice(0, index + 1);
              index = accumulator.indexOf(separator);
            }
          }
          if (len(accumulator) > 0) {
            unicode_line = DecodeUtils.decode(accumulator, "utf-8");
            unicode_line = unicode_line.trim();
            if (unicode_line) {
              let result_dict = loads(unicode_line);
              yield result_dict;
            }
          }
        } finally {
          await response.close?.();
        }
      } finally {
        _resource2.close?.();
      }
    } catch (e) {
      if (e instanceof Error) {
        if (this.is_closed()) {
          throw new AgentSessionClosedError("async HTTP agent session was closed during streaming_chat()");
        }
        throw e;
      } else if (e instanceof Error) {
        const exc = e;
        if (this.is_closed()) {
          throw new AgentSessionClosedError("async HTTP agent session was closed during streaming_chat()");
        }
        throw new Error(this.help_message(path));
      }
    } finally {
      const _resource2 = this._stream_lock;
      try {
        this._active_response = null;
        this._active_session = null;
        this._active_loop = null;
      } finally {
        _resource2.close?.();
      }
    }
  }
  /**
   * :return: True if close() has been called on this session.
   */
  is_closed() {
    const _resource = this._stream_lock;
    try {
      return this._closed;
    } finally {
      _resource.close?.();
    }
  }
  /**
   * Raise AgentSessionClosedError if this session has been closed.
   */
  _raise_if_closed() {
    if (this.is_closed()) {
      throw new AgentSessionClosedError("async HTTP agent session has been closed");
    }
  }
  /**
   * Close this session by aborting any in-flight streaming request.
   *
   * Marks the session closed and, on the event loop the request runs on,
   * aborts it so streaming_chat() unblocks on the client side. Both handles
   * are needed because aiohttp aborts differently per phase: closing the
   * response unblocks an in-flight read after headers have arrived, while
   * closing the session aborts a request still awaiting headers (there may be
   * no total timeout). aiohttp objects are bound to their loop and are not
   * thread-safe, so the work is scheduled on that loop. Safe to call from
   * another thread than the one running streaming_chat(), and safe to call
   * more than once.
   *
   * Server-side scope: close() releases the client connection; it does NOT
   * directly cancel the server-side work. The neuro-san service ends the
   * corresponding request only when it next detects the dropped connection --
   * on its next result or heartbeat flush. That is prompt while results stream
   * (or a keep-alive heartbeat is enabled), but a request producing no output
   * with heartbeat and request-timeout disabled may keep running server-side
   * until it does.
   */
  close() {
    let response = null;
    let session = null;
    let loop = null;
    const _resource = this._stream_lock;
    try {
      this._closed = true;
      response = this._active_response;
      session = this._active_session;
      loop = this._active_loop;
      this._active_response = null;
      this._active_session = null;
      this._active_loop = null;
    } finally {
      _resource.close?.();
    }
    if (loop == null || loop.is_closed()) {
      if (response != null) {
        const _resource2 = suppress(Error);
        try {
          response.close();
        } finally {
          _resource2.close?.();
        }
      }
      return;
    }
    const next_with = suppress(RuntimeError);
    try {
      let _ = next_with;
      if (response != null) {
        loop.call_soon_threadsafe(response.close);
      }
      if (session != null) {
        run_coroutine_threadsafe(AsyncHttpServiceAgentSession._close_session(session), loop);
      }
    } finally {
      next_with.close?.();
    }
  }
  /**
   * Close the aiohttp session on its owning loop; swallows teardown errors.
   */
  static async _close_session(session) {
    const _resource = suppress(Error);
    try {
      if (!session.closed) {
        await session.close();
      }
    } finally {
      _resource.close?.();
    }
  }
}
exposeClassAttributes(AsyncHttpServiceAgentSession);
class ExternalAgentSessionFactory extends AsyncAgentSessionFactory {
  /**
   * Constructor
   *
   * :param use_direct: When True, will use a Direct session for
   * external agents that would reside on the same server.
   * :param network_storage_dict: A dictionary of AgentNetworkStorage instances which keeps all
   * the AgentNetwork instances.  Only used with use_direct=True.
   */
  constructor(use_direct, network_storage_dict) {
    super();
    this.use_direct = use_direct;
    this.network_storage_dict = null;
    if (this.use_direct) {
      this.network_storage_dict = network_storage_dict;
    }
  }
  /**
   * :param agent_url: An url string pointing to an external agent that came from
   * a tools list in an agent spec.
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param invocation: String describing how the agent wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   * :return: An AsyncAgentSession through which communications about the external agent can be made.
   */
  create_session(agent_url, invocation_context, invocation) {
    let server_port = invocation_context.get_port();
    let agent_location = ExternalAgentParsing.parse_external_agent(agent_url, { server_port });
    let session = this.create_session_from_location_dict(agent_location, invocation_context, invocation);
    return session;
  }
  /**
   * :param network_storage_dict: The dictionary of AgentNetworkStorage instances to check for networks.
   * :return: A List of AgentNetworkStorage names in the order they should be checked.
   * Note: we need our "temp" storage to be checked last,
   * because in the general case this might involve querying external storage, which is potentially slow.
   */
  get_networks_order(network_storage_dict) {
    let networks_order = [];
    if (network_storage_dict == null) {
      return networks_order;
    }
    for (const storage_name of Object.keys(network_storage_dict)) {
      if (storage_name != StorageClass.TEMP) {
        networks_order.push(storage_name);
      }
    }
    if (contains(StorageClass.TEMP, network_storage_dict)) {
      networks_order.push(StorageClass.TEMP);
    }
    return networks_order;
  }
  /**
   * Creates the session for an external agent from its parsed location, in-process when possible.
   *
   * :param agent_location: An agent location dictionary returned by
   * ExternalAgentParsing.parse_external_agent().
   * When its "scheme" is "https", the http session built here
   * talks https; any other (or absent) scheme talks plain http.
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param invocation: String describing how the agent wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   * :return: An AsyncAgentSession through which communications about the external agent can be made.
   */
  create_session_from_location_dict(agent_location, invocation_context, invocation) {
    if (agent_location == null) {
      return null;
    }
    let host = dict.get(agent_location, "host");
    let port = dict.get(agent_location, "port");
    let agent_name = dict.get(agent_location, "agent_name");
    let metadata = null;
    if (invocation_context != null) {
      metadata = invocation_context.get_metadata();
    }
    let session = null;
    if (this.is_use_direct() && (host == null || host.length == 0 || host == "localhost")) {
      let agent_network_provider = null;
      for (const network_storage_name of this.get_networks_order(this.network_storage_dict)) {
        let network_storage = this.network_storage_dict[network_storage_name];
        agent_network_provider = network_storage.get_agent_network_provider(agent_name);
        if (agent_network_provider == null) {
          continue;
        }
        if (agent_network_provider.get_agent_network() != null) {
          break;
        }
      }
      if (agent_network_provider != null) {
        let agent_network = agent_network_provider.get_agent_network();
        if (agent_network != null) {
          let safe_invocation_context = invocation_context.safe_shallow_copy(invocation);
          session = new AsyncDirectAgentSession(agent_network, safe_invocation_context, metadata, null, null);
        }
      }
    }
    if (session == null) {
      let security_cfg = ExternalAgentSessionFactory.get_security_cfg(agent_location);
      session = new AsyncHttpServiceAgentSession(host, port, { agent_name, metadata, security_cfg, streaming_timeout_in_seconds: null });
    }
    return session;
  }
  /**
   * Derives the security_cfg for an http session from the scheme of the
   * parsed external agent reference.
   *
   * :param agent_location: An agent location dictionary returned by
   * ExternalAgentParsing.parse_external_agent()
   * :return: An empty dict when the reference used the https scheme, so that
   * AbstractHttpServiceAgentSession.get_request_path() builds an
   * https url. null otherwise, which keeps plain http.
   */
  static get_security_cfg(agent_location) {
    let scheme = dict.get(agent_location, "scheme", "");
    let security_cfg = null;
    if (scheme == "https") {
      security_cfg = {};
    }
    return security_cfg;
  }
  /**
   * :return: When True, will use a Direct session for external agents that would reside on the same server.
   */
  is_use_direct() {
    return this.use_direct;
  }
}
exposeClassAttributes(ExternalAgentSessionFactory);
class SessionInvocationContext extends InvocationContext {
  /**
   * Constructor
   *
   * :param agent_name: The name of the agent
   * :param async_session_factory: The AsyncAgentSessionFactory to use
   * when connecting with external agents.
   * :param async_executors_pool: pool of AsyncioExecutors to use for obtaining
   * an executor instance to use for this context;
   * :param llm_factory: The ContextTypeLlmFactory instance
   * :param toolbox_factory: The ContextTypeToolboxFactory instance
   * :param metadata: A request metadata of key/value pairs to be inserted into
   * the header. Default is null. Preferred format is a
   * dictionary of string keys to string values.
   * :param reservationist: The Reservationist instance to use.
   * :param port: The port on which the server was started
   * :param effective_invocation: A string representing the effective invocation of the session.
   * :param event_work_queue: The AsyncCollatingQueue instance to use to queue up work
   * for events that will be finished up after the request ends.
   */
  constructor(agent_name, async_session_factory, async_executors_pool, llm_factory, toolbox_factory, metadata, reservationist, port, effective_invocation, event_work_queue) {
    super();
    this.agent_name = agent_name;
    this.async_session_factory = async_session_factory;
    this.async_executors_pool = async_executors_pool;
    this.llm_factory = llm_factory;
    this.toolbox_factory = toolbox_factory;
    this.metadata = metadata;
    this.reservationist = reservationist;
    this.port = port;
    this.effective_invocation = effective_invocation;
    this.event_work_queue = event_work_queue;
    this.asyncio_executor = this.async_executors_pool.get_executor();
    this.request_reporting = {};
    this.origination = new Origination();
    this.queue = new AsyncCollatingQueue(null);
    this.journal = new MessageJournal(this.queue);
    this.resources = [];
    this.work_done_event = new Event();
    this.request_finished = false;
    this.cloned = false;
  }
  /**
   * Starts the active components of this invocation context.
   * Do this separately from constructor for more control.
   * Currently, we only start internal AsyncioExecutor.
   * It could be already running, but starting it twice is allowed.
   */
  start() {
    let logging_setup = partial(LoggingSetup.setup_extra_logging_fields, { metadata_dict: this.metadata });
    this.asyncio_executor.start();
    this.asyncio_executor.initialize(logging_setup);
  }
  /**
   * :return: The effective invocation of the session
   */
  get_effective_invocation() {
    return this.effective_invocation;
  }
  /**
   * :return: The AsyncAgentSessionFactory associated with the invocation
   */
  get_async_session_factory() {
    return this.async_session_factory;
  }
  /**
   * :return: The AsyncioExecutor associated with the invocation
   */
  get_asyncio_executor() {
    return this.asyncio_executor;
  }
  /**
   * :return: The Origination instance carrying state about tool instantation
   * during the course of the AgentSession.
   */
  get_origination() {
    return this.origination;
  }
  /**
   * :return: The Journal instance that allows message reporting
   * during the course of the AgentSession.
   */
  get_journal() {
    return this.journal;
  }
  /**
   * :return: The AsyncCollatingQueue instance via which messages are streamed to the
   * AgentSession mechanics
   */
  get_queue() {
    return this.queue;
  }
  /**
   * :return: The metadata to pass along with any request
   */
  get_metadata() {
    return this.metadata;
  }
  /**
   * :param resource: The resource to add
   */
  add_resource(resource) {
    this.resources.push(resource);
  }
  /**
   * Release resources owned by this context when the request is complete.
   * This can happen earlier than when the work is complete.
   *
   * :param parent_resource: The parent resource, if any
   */
  async close_of_request(parent_resource) {
    if (this.queue != null) {
      this.queue.close();
      this.queue = null;
    }
    for (const resource of this.resources) {
      await resource.close_of_request(null);
    }
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * Note: unknown time close_of_work(null) is called, return_executor() should also be called
   * but not in the executor.  Use the synchronous done_with_work() for that combo.
   *
   * :param parent_resource: The parent resource, if any
   */
  async close_of_work(parent_resource) {
    for (const resource of this.resources) {
      await resource.close_of_work(null);
    }
    if (!this.cloned && this.reservationist != null && isinstance2(this.reservationist, LingeringResource)) {
      await this.reservationist.close_of_work(null);
    }
  }
  /**
   * :return: The request reporting dictionary
   */
  get_request_reporting() {
    return this.request_reporting;
  }
  /**
   * :return: True if this instance is a clone created by safe_shallow_copy()
   * to invoke an external agent network on the same server via a
   * direct session.
   * False for the original InvocationContext of a request.
   */
  is_cloned() {
    return this.cloned;
  }
  /**
   * :return: The ContextTypeLlmFactory instance for the session
   */
  get_llm_factory() {
    return this.llm_factory;
  }
  /**
   * :return: The ContextTypeToolboxFactory instance for the session
   */
  get_toolbox_factory() {
    return this.toolbox_factory;
  }
  /**
   * :return: The Reservationist instance for the session
   */
  get_reservationist() {
    return this.reservationist;
  }
  /**
   * :return: The agent name for the session
   */
  get_agent_name() {
    return this.agent_name;
  }
  /**
   * :return: The port on which the server was started
   */
  get_port() {
    return this.port;
  }
  /**
   * Resets the instance for a subsequent use for another exchange with the agent network.
   */
  reset() {
    this.origination.reset();
    this.request_reporting.length = 0;
    if (this.queue != null) {
      this.queue.reset();
    } else {
      this.queue = new AsyncCollatingQueue(null);
      this.journal = new MessageJournal(this.queue);
    }
    if (this.asyncio_executor == null) {
      this.asyncio_executor = this.async_executors_pool.get_executor();
    }
  }
  /**
   * Makes a safe shallow copy of the invocation context.
   * Generally used with direct sessions.
   *
   * :param invocation: String describing how the agent wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   * :return: A copy of the invocation context
   */
  async safe_shallow_copy(invocation) {
    let invocation_context = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    invocation_context.cloned = true;
    invocation_context.work_done_event = new Event();
    invocation_context.resources = [];
    invocation_context.queue = new AsyncCollatingQueue(null);
    invocation_context.journal = new MessageJournal(invocation_context.queue);
    if (invocation != null) {
      invocation_context.effective_invocation = invocation;
    }
    return invocation_context;
  }
  /**
   * :return: The Event (synchronous) that will be set when work is done for this event
   */
  get_work_done_event() {
    return this.work_done_event;
  }
  /**
   * Clean up our resources.
   * Depending on the invocation, we might Queue ourselves to let our work finish on its own
   * so that some of the resources can be cleaned up later.
   */
  finish_request() {
    if (this.request_finished) {
      return;
    }
    this.request_finished = true;
    let close_of_work_now = true;
    try {
      this._run_in_executor_until_complete("finish_request", this.close_of_request(null));
      if (this.get_effective_invocation() == "event") {
        if (this.event_work_queue != null) {
          close_of_work_now = false;
          this._run_in_executor_until_complete("finish_request", this.event_work_queue.put(this, true, true));
        }
      }
    } finally {
      if (close_of_work_now) {
        this.done_with_work("finish_request");
      }
    }
  }
  /**
   * Submits a function to be run on the executor and runs until complete.
   * Note this is synchronous and can be run from within the executor or another event loop.
   */
  _run_in_executor_until_complete(submitter_id, coroutine) {
    let other_loop = this.asyncio_executor.get_event_loop();
    let loop = null;
    try {
      loop = get_running_loop();
    } catch {
    }
    let future = null;
    if (loop == other_loop) {
      future = this.asyncio_executor.create_task(coroutine, submitter_id, { raise_exception: true });
    } else {
      future = run_coroutine_threadsafe(coroutine, other_loop);
      let result = future.result();
      let _ = result;
      future = null;
    }
    return future;
  }
  /**
   * Runs close_of_work(null) on the executor and potentially returns the executor back to the pool
   */
  done_with_work(submitter_id) {
    this._run_in_executor_until_complete(submitter_id, this.close_of_work(null));
    if (this.cloned) {
      return;
    }
    if (this.asyncio_executor != null) {
      this.async_executors_pool.return_executor(this.asyncio_executor);
      this.asyncio_executor = null;
    }
  }
}
exposeClassAttributes(SessionInvocationContext);
export {
  AsyncDirectAgentSession,
  DirectAgentSession,
  ExternalAgentSessionFactory,
  SessionInvocationContext
};
