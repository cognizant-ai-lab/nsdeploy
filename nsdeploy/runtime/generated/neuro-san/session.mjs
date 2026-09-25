import { getLogger, iter2, list3, slice2, loads, tuple2, monotonic, max2, round2, isinstance2, time, sorted2, copy, string2, hasattr2, getattr2, partial } from "../vendor/libraries.mjs";
import { dict, Lock, contains, set, get, Event, Thread, len, deepcopy, callable, iscoroutinefunction, format_exc, suppress, ClientTimeout, ClientSession, get_running_loop, RuntimeError, run_coroutine_threadsafe, Queue, is_dict } from "./stubs.mjs";
import { DictionaryExtractor, Timeout, SensitiveLogger, Startable, LoggingSetup, AsyncioExecutorPool } from "./leaf_common.mjs";
import { AgentNetworkProvider, AgentStorageSource, StorageClass, ConciergeSession, AgentSessionConstants, ReservationsStorage, RunTarget, AgentSession, AsyncAgentSession, AsyncAgentSessionFactory, InvocationContext, LingeringResource } from "./interfaces.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
import { process } from "../browser/process.mjs";
import { RegistryManifestRestorer, AgentNetwork, AgentToolRegistry, AgentNetworkRestorer } from "./graph.mjs";
import { ResolvedNetworkConfigFilter } from "./filters.mjs";
import { MasterToolboxFactory, AbstractNetworkValidator, RunContextFactory, MasterTracingContextFactory, MasterLlmFactory, DirectAgentReservationist } from "./run_context.mjs";
import { ExternalAgentParsing, InterceptingJournal, Origination, MessageJournal } from "./internals.mjs";
import { MessageProcessor, ChatMessageType, SlyDataRedactor, AgentFrameworkMessage, AnswerMessageProcessor, BaseMessageDictionaryConverter, MessageFilterFactory, StructureMessageProcessor, DecodeUtils } from "./message.mjs";
class SingleAgentNetworkProvider extends AgentNetworkProvider {
  /**
   * Constructor.
   * :param agent_name: name of an agent to provide AgentNetwork instances for;
   * :param agents_table: service-wide table mapping agent names to their
   * currently active AgentNetwork instances.
   * This table is assumed to be dynamically modified outside a single agent scope.
   */
  constructor(agent_name, agents_table) {
    super();
    this.agent_name = agent_name;
    this.agents_table = agents_table;
  }
  /**
   * :return: Current AgentNetwork instance for specific agent name.
   * null if this does not exist for the instance's agent_name.
   */
  get_agent_network() {
    return dict.get(this.agents_table, this.agent_name);
  }
}
exposeClassAttributes(SingleAgentNetworkProvider);
class AgentNetworkStorage extends AgentStorageSource {
  constructor() {
    super();
    this.agents_table = {};
    this.logger = getLogger(this.constructor.name);
    this.lock = new Lock();
    this.listeners = [];
  }
  /**
   * Add a state listener to be notified when status of service agents changes.
   */
  add_listener(listener) {
    this.listeners.push(listener);
  }
  /**
   * Remove a state listener from registered set.
   */
  remove_listener(listener) {
    if (contains(listener, this.listeners)) {
      this.listeners.splice(this.listeners.indexOf(listener), 1);
    }
  }
  /**
   * This method is a single point of entry in the service
   * where we register a new agent name -> AgentNetwork pair in the service scope
   * or notify the service that for existing agent its AgentNetwork has been modified.
   */
  add_agent_network(agent_name, agent_network) {
    let is_new = false;
    const _resource = this.lock;
    try {
      is_new = dict.get(this.agents_table, agent_name) == null;
      this.agents_table[agent_name] = agent_network;
    } finally {
      _resource.close?.();
    }
    let agent_size_in_bytes = agent_network.get_size_in_bytes();
    for (const listener of this.listeners) {
      if (is_new) {
        listener.agent_added(agent_name, this);
        this.logger.info("ADDED network for agent %s (%d bytes): %d", agent_name, agent_size_in_bytes, Number(agent_network));
      } else {
        listener.agent_modified(agent_name, this);
        this.logger.info("REPLACED network for agent %s (%d bytes): %d", agent_name, agent_size_in_bytes, Number(agent_network));
      }
    }
  }
  /**
   * Replace agents networks with a new collection.
   * Previous state could be empty.
   */
  setup_agent_networks(agent_networks) {
    let current_agents = set(Object.keys(this.agents_table));
    let new_agents = set(Object.keys(agent_networks));
    let agents_to_remove = new Set([...current_agents].filter((one) => !new_agents.has(one)));
    for (const agent_name of iter2(agents_to_remove)) {
      this.remove_agent_network(agent_name);
    }
    for (const agent_name of iter2(new_agents)) {
      this.add_agent_network(agent_name, agent_networks[agent_name]);
    }
  }
  /**
   * Remove agent name and its AgentNetwork from service scope,
   * so that agent becomes unavailable on our server.
   */
  remove_agent_network(agent_name) {
    let agent_network = null;
    const _resource = this.lock;
    try {
      agent_network = dict.get(this.agents_table, agent_name, null);
      delete this.agents_table[agent_name];
    } finally {
      _resource.close?.();
    }
    for (const listener of this.listeners) {
      listener.agent_removed(agent_name, this);
    }
    this.logger.info("REMOVED network for agent %s : %d", agent_name, Number(agent_network));
  }
  /**
   * Get AgentNetworkProvider for a specific agent
   * :param agent_name: name of an agent
   */
  get_agent_network_provider(agent_name) {
    return new SingleAgentNetworkProvider(agent_name, this.agents_table);
  }
  /**
   * Return static list of agent names.
   */
  get_agent_names() {
    const _resource = this.lock;
    try {
      return list3(Object.keys(this.agents_table));
    } finally {
      _resource.close?.();
    }
  }
}
exposeClassAttributes(AgentNetworkStorage);
class DirectAgentStorageUtil {
  /**
   * Creates an AgentNetworkStorage instance for a given type.
   *
   * :param manifest_networks: Optional structure that is handed back from a RegistryManifestRestorer.restore()
   * call.  This has major keys being different network storage options like
   * "public" and "protected". The values are agent name -> AgentNetwork mappings.
   * By default the value is null, indicating we need to get this information
   * by calling the RegistryManifestRestorer.
   * :param storage_type: The type of storage ("public" or "protected")
   * Default value is "public".
   * :return: An AgentNetworkStorage populated from the Registry Manifest
   */
  static create_network_storage(manifest_networks = null, storage_type = StorageClass.PUBLIC) {
    let network_storage = new AgentNetworkStorage();
    if (manifest_networks == null) {
      let manifest_restorer = new RegistryManifestRestorer();
      manifest_networks = manifest_restorer.restore();
    }
    let storage_networks = dict.get(manifest_networks, storage_type);
    if (storage_networks == null) {
      return null;
    }
    for (const [agent_name, agent_network] of Object.entries(storage_networks)) {
      network_storage.add_agent_network(agent_name, agent_network);
    }
    return network_storage;
  }
}
exposeClassAttributes(DirectAgentStorageUtil);
class DirectConciergeSession extends ConciergeSession {
  /**
   * Constructor
   *
   * :param network_storage: A AgentNetworkStorage instance which keeps all
   * the AgentNetwork instances.
   * :param metadata: A dictionary of request metadata to be forwarded
   * to subsequent yet-to-be-made requests.
   * :param security_cfg: A dictionary of parameters used to
   * secure the TLS and the authentication of the HTTP
   * connection.  Supplying this implies use of a secure
   * HTTP connection.  If null, uses insecure connection.
   */
  constructor(network_storage, metadata, security_cfg) {
    super();
    this.network_storage = network_storage;
    this._metadata = metadata;
    this._security_cfg = security_cfg;
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
    let agents_names = this.network_storage.get_agent_names();
    let empty_list = [];
    let agents_list = [];
    for (const agent_name of iter2(agents_names)) {
      let provider = this.network_storage.get_agent_network_provider(agent_name);
      let agent_network = provider.get_agent_network();
      let agent_spec = agent_network.get_config();
      let extractor = new DictionaryExtractor(agent_spec, ".");
      let description = extractor.get("metadata.description", "");
      let tags = extractor.get("metadata.tags", empty_list);
      let agent_info = { "agent_name": agent_name, "description": description, "tags": tags };
      agents_list.push(agent_info);
    }
    let response = { "agents": agents_list };
    return response;
  }
}
exposeClassAttributes(DirectConciergeSession);
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
class SessionUtil {
  /**
   * Limit the number of agents to the value of the MAX_AGENTS_FROM_EXTERNAL_SERVER environment variable,
   * if that is set. Otherwise, return the full list of agents.
   *
   * :param agents_list: List of agents
   * :return: Potentially limited list of agents
   */
  static limit_agents_list(agents_list) {
    let use_agents_list = agents_list;
    let max_agents = 0;
    let max_agents_str = dict.get(process.env, "MAX_AGENTS_FROM_EXTERNAL_SERVER");
    if (max_agents_str != null) {
      try {
        max_agents = Number(max_agents_str);
      } catch (e) {
        max_agents = 0;
      }
    }
    if (max_agents > 0) {
      use_agents_list = slice2(use_agents_list, void 0, max_agents);
    }
    return use_agents_list;
  }
}
exposeClassAttributes(SessionUtil);
class HttpConciergeSession extends AbstractHttpServiceAgentSession {
  /**
   * :param request_dict: A dictionary version of the ConciergeRequest
   * protobuf structure. Has the following keys:
   * <None>
   * :return: A dictionary version of the ConciergeResponse
   * protobuf structure. Has the following keys:
   * "agents" - the sequence of dictionaries describing available agents
   */
  list(request_dict) {
    let path = this.get_request_path("list");
    try {
      let response = get(path, { json: request_dict, headers: this.get_headers(), timeout: this.timeout_in_seconds });
      let result_dict = loads(response.text);
      let empty_list = [];
      let agent_infos = dict.get(result_dict, "agents", empty_list);
      agent_infos = SessionUtil.limit_agents_list(agent_infos);
      result_dict["agents"] = agent_infos;
      return result_dict;
    } catch (exc) {
      throw new Error(this.help_message(path));
    }
  }
}
exposeClassAttributes(HttpConciergeSession);
class ConciergeSessionFactory {
  /**
   * :param session_type: The type of session to create
   * :param hostname: The name of the host to connect to (if applicable)
   * :param port: The port on the host to connect to (if applicable)
   * :param metadata: A metadata dictionary of key/value pairs to be inserted into
   * the header. Default is null. Preferred format is a
   * dictionary of string keys to string values.
   * :param connect_timeout_in_seconds: A timeout in seconds after which attempts
   * to reach a server will stop. By default, this is null,
   * meaning sessions will try forever.
   */
  create_session(session_type, hostname, port, metadata, connect_timeout_in_seconds) {
    let session = null;
    let umbrella_timeout = null;
    if (connect_timeout_in_seconds != null) {
      umbrella_timeout = new Timeout();
      umbrella_timeout.set_limit_in_seconds(connect_timeout_in_seconds);
    }
    if (session_type == "direct") {
      let network_storage = DirectAgentStorageUtil.create_network_storage();
      session = new DirectConciergeSession(network_storage, { metadata });
    } else if (contains(session_type, tuple2("http", "https"))) {
      let use_port = port;
      if (port == null) {
        use_port = ConciergeSession.DEFAULT_PORT;
      }
      let security_cfg = null;
      if (session_type == "https") {
        security_cfg = {};
      }
      session = new HttpConciergeSession({ host: hostname, port: use_port, security_cfg, metadata, timeout_in_seconds: connect_timeout_in_seconds });
    } else {
      throw new Error(`session_type ${session_type} is not understood`);
    }
    return session;
  }
}
exposeClassAttributes(ConciergeSessionFactory);
class AbstractReservationsStorage extends ReservationsStorage {
  /**
   * Constructor
   * :param storage_name: A string name for this storage, used for logging purposes.
   * :param check_expirations_interval_seconds: The number of seconds between checks for expired reservations.
   * If set to 0 or negative, the background thread will not be started.
   */
  constructor(storage_name, check_expirations_interval_seconds) {
    super();
    this._thread = null;
    this._check_interval_seconds = check_expirations_interval_seconds;
    this._stop_event = new Event();
    this._logger = getLogger(this.constructor.name);
    this._name = storage_name;
  }
  start() {
    if (this._check_interval_seconds > 0) {
      this._thread = new Thread({ target: this._run_loop, daemon: true });
      this._thread.start();
      this._logger.debug("%s: Expiration cleanup thread started with period %f sec.", this._name, this._check_interval_seconds);
    } else {
      this._logger.debug("%s: Expiration cleanup thread not started.", this._name);
    }
  }
  /**
   * Signal the worker to stop and wait for it with timeout.
   */
  stop(timeout) {
    this._stop_event.set();
    if (this._thread) {
      this._thread.join(timeout);
      this._logger.debug("%s: Expiration cleanup thread stopped.", this._name);
    }
  }
  _run_loop() {
    while (!this._stop_event.is_set()) {
      let start = monotonic();
      try {
        this.expire_reservations();
      } catch (exception) {
        let sensitive_logger = new SensitiveLogger(this._logger);
        sensitive_logger.info("%s: Expiration cleanup failed: %s", this._name, exception);
      }
      let elapsed = monotonic() - start;
      this._logger.debug("%s: Expiration cleanup took %f seconds.", this._name, elapsed);
      let sleep_time = this._check_interval_seconds - elapsed;
      if (sleep_time > 0) {
        this._stop_event.wait({ timeout: sleep_time });
      }
    }
  }
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
  }
}
exposeClassAttributes(AbstractReservationsStorage);
class FixedAgentNetworkProvider extends AgentNetworkProvider {
  /**
   * Constructor.
   * :param agent_network: AgentNetwork instance to be returned by this provider.
   */
  constructor(agent_network) {
    super();
    this.agent_network = agent_network;
  }
  /**
   * :return: Current AgentNetwork instance for specific agent name.
   */
  get_agent_network() {
    return this.agent_network;
  }
}
exposeClassAttributes(FixedAgentNetworkProvider);
class ExpiringAgentNetworkStorage extends AbstractReservationsStorage {
  /**
   * Constructor
   * :param check_expirations_interval_seconds: The number of seconds between checks for expired reservations.
   */
  constructor(check_expirations_interval_seconds) {
    super({ storage_name: "temp_storage", check_expirations_interval_seconds });
    this.reservations_table = {};
    this.access_times = {};
    this.sizes = {};
    this.max_items = 0;
    this.items_overflow_threshold = 0;
    this.base_storage = null;
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Set the base storage to be used as a "source of truth" for reservations and agent networks.
   * This is optional, but if set, then this storage will be used as a source of truth
   * for reservations and agent networks,
   * and any changes to reservations and agent networks in this storage will be reflected in this storage as well.
   *
   * :param base_storage: An ExpiringReservationsStorage instance to be used
   * as a source of truth for reservations and agent networks.
   */
  set_base_storage(base_storage) {
    this.base_storage = base_storage;
  }
  /**
   * Configure the maximum number of temporary networks to keep in memory.
   * When exceeded, least recently used items are evicted.
   *
   * :param max_items: Maximum number of items. 0 or negative means unlimited.
   */
  set_max_agent_networks(max_items) {
    this.max_items = max_items;
    this.items_overflow_threshold = 0;
    if (max_items > 0) {
      this.items_overflow_threshold = max2(1, round2(max_items * 0.05));
    }
    this.evict_lru_agent_networks();
  }
  /**
   * Start this storage, which includes starting the expiration checking loop.
   */
  start() {
    super.start();
    try {
      if (this.base_storage != null) {
        this.base_storage.start();
      }
    } catch (exc) {
      let sensitive_logger = new SensitiveLogger(this.logger);
      sensitive_logger.error("%s: Failed to start base storage: %s", this._name, exc);
      super.stop();
      throw exc;
    }
  }
  /**
   * Stop this storage, which includes stopping the expiration checking loop.
   */
  stop(timeout) {
    super.stop();
    try {
      if (this.base_storage != null && isinstance2(this.base_storage, Startable)) {
        this.base_storage.stop();
      }
    } catch (exc) {
      let sensitive_logger = new SensitiveLogger(this.logger);
      sensitive_logger.error("%s: Failed to stop base storage: %s", this._name, exc);
      throw exc;
    }
  }
  /**
   * :return: Whether this reservation is expired or not.
   */
  static is_expired(reservation) {
    return time() > reservation.get_expiration_time_in_seconds();
  }
  /**
   * Add a set of reservations for agent networks en-masse
   *
   * :param reservations_dict: A mapping of Reservation -> agent network spec
   * :param source: A string describing where the deployment was coming from
   */
  async add_reservations(reservations_dict, source) {
    if (!reservations_dict) {
      return;
    }
    let spec_filter = new ResolvedNetworkConfigFilter();
    let use_reservations = {};
    for (const [reservation, agent_spec] of Object.entries(reservations_dict)) {
      use_reservations[reservation] = spec_filter.filter_config(agent_spec);
    }
    if (this.base_storage != null) {
      await this.base_storage.add_reservations(use_reservations, { source });
    }
    let added = [];
    let replaced = [];
    let now = time();
    const _resource = this.lock;
    try {
      for (const [reservation, agent_spec] of Object.entries(use_reservations)) {
        let agent_name = reservation.get_reservation_id();
        let is_new = dict.get(this.agents_table, agent_name) == null;
        let agent_network = new AgentNetwork(agent_spec, agent_name);
        this.agents_table[agent_name] = agent_network;
        this.reservations_table[agent_name] = reservation;
        this.access_times[agent_name] = now;
        this.sizes[agent_name] = agent_network.get_size_in_bytes();
        if (is_new) {
          added.push(agent_name);
        } else {
          replaced.push(agent_name);
        }
      }
    } finally {
      _resource.close?.();
    }
    for (const listener of this.listeners) {
      for (const agent_name of iter2(added)) {
        listener.agent_added(agent_name, this);
        let agent_size_in_bytes = dict.get(this.sizes, agent_name, 0);
        this.logger.info("%s: ADDED network for agent %s (%d bytes) from %s", this._name, agent_name, agent_size_in_bytes, source);
      }
      for (const agent_name of iter2(replaced)) {
        listener.agent_modified(agent_name, this);
        let agent_size_in_bytes = dict.get(this.sizes, agent_name, 0);
        this.logger.info("%s: REPLACED network for agent %s (%d bytes) from %s", this._name, agent_name, agent_size_in_bytes, source);
      }
    }
    this.evict_lru_agent_networks();
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
    let expired = [];
    let reservations_snapshot = this._get_reservations_snapshot();
    for (const [agent_name, reservation] of Object.entries(reservations_snapshot)) {
      if (ExpiringAgentNetworkStorage.is_expired(reservation)) {
        expired.push(agent_name);
      }
    }
    if (len(expired) == 0) {
      return;
    }
    const _resource = this.lock;
    try {
      for (const agent_name of iter2(expired)) {
        this.remove_agent_network(agent_name);
      }
    } finally {
      _resource.close?.();
    }
    for (const listener of this.listeners) {
      for (const agent_name of iter2(expired)) {
        listener.agent_removed(agent_name, this);
        this.logger.info("%s: REMOVED network for agent %s", this._name, agent_name);
      }
    }
  }
  /**
   * Get a snapshot of all reservations
   */
  _get_reservations_snapshot() {
    let reservations_snapshot = null;
    const _resource = this.lock;
    try {
      reservations_snapshot = this.reservations_table.copy();
    } finally {
      _resource.close?.();
    }
    return reservations_snapshot;
  }
  /**
   * Remove agent name and its AgentNetwork from service internal tables.
   * :param agent_name: name of an agent to remove
   */
  remove_agent_network(agent_name) {
    delete this.reservations_table[agent_name];
    delete this.agents_table[agent_name];
    delete this.access_times[agent_name];
    delete this.sizes[agent_name];
  }
  /**
   * Remove least recently used agent networks to bring storage size under max_items limit.
   */
  evict_lru_agent_networks() {
    if (this.max_items <= 0) {
      return;
    }
    let evicted = [];
    const _resource = this.lock;
    try {
      let overflow = len(this.agents_table) - this.max_items;
      if (overflow <= this.items_overflow_threshold) {
        return;
      }
      let sorted_agents = sorted2(Object.entries(this.access_times), { key: (item) => item[1] });
      for (const [agent_name, _] of slice2(sorted_agents, void 0, overflow)) {
        this.remove_agent_network(agent_name);
        evicted.push(agent_name);
      }
    } finally {
      _resource.close?.();
    }
    for (const listener of this.listeners) {
      for (const agent_name of iter2(evicted)) {
        listener.agent_removed(agent_name, this);
        this.logger.info("%s: EVICTED (LRU) network for agent %s", this._name, agent_name);
      }
    }
  }
  /**
   * Get AgentNetworkProvider for a specific agent
   * :param agent_name: name of an agent
   */
  get_agent_network_provider(agent_name) {
    let reservation = dict.get(this.reservations_table, agent_name, null);
    if (reservation != null) {
      if (ExpiringAgentNetworkStorage.is_expired(reservation)) {
        const _resource = this.lock;
        try {
          this.remove_agent_network(agent_name);
        } finally {
          _resource.close?.();
        }
        for (const listener of this.listeners) {
          listener.agent_removed(agent_name, this);
          this.logger.info("%s: REMOVED expired network for agent %s", this._name, agent_name);
        }
        return null;
      }
      let agent_network = dict.get(this.agents_table, agent_name, null);
      if (agent_network != null) {
        const _resource = this.lock;
        try {
          this.access_times[agent_name] = time();
        } finally {
          _resource.close?.();
        }
        return new FixedAgentNetworkProvider(agent_network);
      }
      return null;
    }
    if (this.base_storage != null) {
      let reservation2, agent_network = this.base_storage.get_one_reservation(agent_name);
      if (reservation2 != null && !ExpiringAgentNetworkStorage.is_expired(reservation2)) ;
    }
    return null;
  }
}
exposeClassAttributes(ExpiringAgentNetworkStorage);
class ConnectivityReporter {
  static {
    this.self_build_logged = false;
  }
  /**
   * Constructor
   *
   * :param inspector: The AgentNetworkInspector to use.
   * :param toolbox_factory: An optional ContextTypeToolboxFactory to consult
   * for display_as information about toolbox tools.
   * This should have been built from the same config as the
   * inspector's agent network and may be passed pre-loaded
   * so toolbox info files are not re-read per report.
   * If null, one is created from the inspector's config.
   */
  constructor(inspector, toolbox_factory) {
    this.inspector = inspector;
    this.toolbox_factory = toolbox_factory;
    if (this.inspector != null && this.toolbox_factory == null) {
      if (!ConnectivityReporter.self_build_logged) {
        ConnectivityReporter.self_build_logged = true;
        let logger = getLogger(this.constructor.name);
        logger.info("No toolbox_factory provided. Building one from the agent network config. Pass a pre-loaded factory to avoid re-reading toolbox info files per report. (Logged once per process.)");
      }
      let config = this.inspector.get_config();
      this.toolbox_factory = MasterToolboxFactory.create_toolbox_factory(config);
    }
  }
  /**
   * Share the connectivity information of the agent network in question
   * :return: A list of connectivity information dictionaries each with the following keys:
   * * origin  - The agent network node whose connectivity is being described
   * * tools   - A list of tool nodes that are possible to reach from the origin
   *
   * This might include references into external agent networks, perhaps hosted
   * on other servers.  Separate calls to those guys will need to be made
   * in order to gain information about their own connectivity, if this is
   * actually desired by the client.
   *
   * Worth noting that server-side agent descriptions are allowed to
   * withhold connectivity info they deem private, or too much of an
   * implementation detail.  That is, connectivity reported is only
   * as much as the server wants a client to know.
   */
  report_network_connectivity() {
    if (this.toolbox_factory != null) {
      this.toolbox_factory.load();
    }
    let front_man = this.inspector.find_front_man();
    let reported_agents = set();
    let connectivity = this.report_node_connectivity(front_man, reported_agents);
    return connectivity;
  }
  /**
   * Share the connectivity information of a single node in the network.
   * :param agent_name: The name of the agent spec dictionary to report on
   * :param reported_agents: A list of agents that have been reported already.
   * Prevents cycles.
   * :return: A list of connectivity information dictionaries.
   */
  report_node_connectivity(agent_name, reported_agents) {
    let connectivity_list = [];
    let agent_spec = null;
    let display_as = null;
    let metadata = null;
    if (!ExternalAgentParsing.is_external_agent(agent_name)) {
      agent_spec = this.inspector.get_agent_tool_spec(agent_name);
      if (agent_spec == null) {
        return connectivity_list;
      }
      let extractor = new DictionaryExtractor(agent_spec, ".");
      let allow_connectivity = Boolean(extractor.get("allow.connectivity", true));
      if (!Boolean(allow_connectivity)) {
        agent_spec = null;
      }
    } else {
      display_as = "external_agent";
    }
    let tool_list = ConnectivityReporter.assemble_tool_list(agent_spec);
    if (display_as == null) {
      display_as = this.determine_display_as(agent_spec);
    }
    if (agent_spec != null) {
      metadata = dict.get(agent_spec, "metadata");
    }
    let connectivity_dict = { "origin": agent_name, "tools": tool_list, "display_as": display_as };
    if (metadata != null) {
      connectivity_dict["metadata"] = metadata;
    }
    reported_agents.add(agent_name);
    connectivity_list.push(connectivity_dict);
    for (const tool of iter2(tool_list)) {
      if (!contains(tool, reported_agents)) {
        let new_list = this.report_node_connectivity(tool, reported_agents);
        if (len(new_list) > 0) {
          connectivity_list.push(...new_list);
        }
      }
    }
    return connectivity_list;
  }
  /**
   * :param agent_spec: The agent spec to assemble a tool list from.
   * :return: A list of tool names referred to by the agent spec.
   */
  static assemble_tool_list(agent_spec) {
    let tool_list = [];
    if (agent_spec == null) {
      return tool_list;
    }
    let combined = [...AbstractNetworkValidator.coerce_tools(agent_spec), ...AbstractNetworkValidator.coerce_args_tools(agent_spec)];
    let tool_set = set();
    for (const tool of AbstractNetworkValidator.remove_dictionary_tools(combined)) {
      if (!contains(tool, tool_set)) {
        tool_set.add(tool);
        tool_list.push(tool);
      }
    }
    return tool_list;
  }
  /**
   * :param agent_spec: The agent spec to determine display_as from.
   * :return: A string describing how the node wants to be seen.
   */
  determine_display_as(agent_spec) {
    let display_as = dict.get(agent_spec, "display_as");
    if (display_as != null) {
      display_as = String(display_as);
      return display_as;
    }
    let tool_name = dict.get(agent_spec, "toolbox");
    if (tool_name != null) {
      display_as = "langchain_tool";
      let tool_info = null;
      if (this.toolbox_factory != null) {
        tool_info = this.toolbox_factory.get_tool_info(tool_name);
      }
      if (tool_info != null) {
        if (dict.get(tool_info, "display_as") != null) {
          display_as = dict.get(tool_info, "display_as");
        } else if (dict.get(tool_info, "description") != null) {
          display_as = "coded_tool";
        }
      }
    } else if (dict.get(agent_spec, "function") != null) {
      if (dict.get(agent_spec, "class") != null) {
        display_as = "coded_tool";
      } else {
        display_as = "llm_agent";
      }
    } else {
      display_as = "llm_agent";
    }
    return display_as;
  }
}
exposeClassAttributes(ConnectivityReporter);
class ChatHistoryMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param max_message_history: The maximum number of messages to preserve
   * in the message history, not including the instructions.
   * The default value of null implies there is no maximum.
   * Non-positive numbers revert to no-maximum behavior.
   */
  constructor(max_message_history) {
    super();
    this.max_message_history = max_message_history;
    if (this.max_message_history != null) {
      if (!isinstance2(this.max_message_history, [int, float])) {
        this.max_message_history = null;
      } else {
        this.max_message_history = Number(this.max_message_history);
      }
    }
    this.message_history = [];
    this.saw_first_system = false;
  }
  /**
   * :return: The filtered message history
   */
  get_message_history() {
    return this.message_history;
  }
  /**
   * Convenience method for processing lists of messages.
   * :param chat_message_dicts: The messages to process.
   */
  process_messages(chat_message_dicts) {
    super.process_messages(chat_message_dicts);
    if (this.max_message_history == null || typeof this.max_message_history !== "number" || this.max_message_history <= 1) {
      return;
    }
    let instructions = this.message_history.shift();
    this.message_history = slice2(this.message_history, -this.max_message_history, void 0);
    this.message_history.unshift(instructions);
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    if (!contains(message_type, tuple2(ChatMessageType.HUMAN, ChatMessageType.SYSTEM, ChatMessageType.AI))) {
      return;
    }
    let transformed_message_dict = chat_message_dict;
    if (!this.saw_first_system && message_type == ChatMessageType.SYSTEM) {
      transformed_message_dict = this.redact_instructions(chat_message_dict);
      this.saw_first_system = true;
    } else {
      transformed_message_dict = this.escape_message(chat_message_dict);
    }
    if (transformed_message_dict != null) {
      this.message_history.push(transformed_message_dict);
    }
  }
  /**
   * Redacts the text instructions of the given system message.
   * These will get replaced by the agent's instructions anyway to preserve
   * server-side intent.
   */
  redact_instructions(chat_message_dict) {
    let redacted = copy(chat_message_dict);
    redacted["text"] = "<redacted>";
    return redacted;
  }
  /**
   * Prepare a message such that it can be re-ingested by the system nicely.
   * This means properly escaping any text that is sent.
   *
   * :param chat_message_dict: The ChatMessage dictionary to transform
   * :return: A shallow copy of the dictionary with its text escaped,
   * or null if the message carries no text at all
   */
  escape_message(chat_message_dict) {
    let transformed = copy(chat_message_dict);
    let text = dict.get(transformed, "text");
    if (text == null) {
      return null;
    }
    if (!isinstance2(text, String)) {
      return transformed;
    }
    let remove_escaped_curly_open = string2.replace(text, "{{", "{");
    let remove_escaped_curly_close = string2.replace(remove_escaped_curly_open, "}}", "}");
    let escape_curly_open = string2.replace(remove_escaped_curly_close, "{", "{{");
    let use_text = string2.replace(escape_curly_open, "}", "}}");
    transformed["text"] = use_text;
    return transformed;
  }
}
exposeClassAttributes(ChatHistoryMessageProcessor);
class DataDrivenChatSession extends RunTarget {
  /**
   * Constructor
   *
   * :param agent_network: The AgentNetwork to use.
   */
  constructor(agent_network) {
    super();
    let agent_network_copy = agent_network;
    let protect_original_copy = dict.get(process.env, "AGENT_PROTECT_ORIGINAL_COPY", "true").toLowerCase() == "true";
    if (protect_original_copy) {
      agent_network_copy = deepcopy(agent_network);
    }
    this.registry = new AgentToolRegistry(agent_network_copy);
    this.front_man = null;
    this.sly_data = {};
    this.invocation_context = null;
    this.interceptor = null;
    this.original_input_message = null;
    this.last_message_sent = false;
    this.tracing_context = null;
  }
  /**
   * Resets or sets the instance up for the first time.
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be null.
   * :param chat_context: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   */
  async set_up(invocation_context, sly_data, chat_context) {
    this.sly_data = {};
    if (sly_data != null) {
      Object.assign(this.sly_data, sly_data);
    }
    if (dict.get(this.sly_data, "request_metadata") == null) {
      this.sly_data["request_metadata"] = deepcopy(invocation_context.get_metadata());
    }
    let run_context = RunContextFactory.create_run_context(null, null, invocation_context, chat_context, null, this.tracing_context);
    this.front_man = this.registry.create_front_man(this.sly_data, run_context);
    await this.front_man.create_any_resources();
  }
  /**
   * Main streaming entry-point method for accepting new user input
   * invoked by DirectAgentSession and its friends.
   *
   * :param user_input: A string with the user's input
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be null.
   * :param chat_context: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   * :return: Nothing.  Response values are put on a queue whose consumtion is
   * managed by the Iterator aspect of AsyncCollatingQueue on the InvocationContext.
   */
  async streaming_chat(user_input, invocation_context, sly_data, chat_context) {
    this.invocation_context = invocation_context;
    this.invocation_context.add_resource(this);
    let journal = this.invocation_context.get_journal();
    this.interceptor = new InterceptingJournal(journal, null);
    let front_man_name = this.registry.find_front_man();
    let front_man_spec = this.registry.get_agent_tool_spec(front_man_name);
    let redactor = new SlyDataRedactor(front_man_spec, ["allow.to_tracing.sly_data"], false);
    this.original_input_message = new AgentFrameworkMessage(user_input, chat_context, sly_data, {}, null, redactor);
    let input_message_for_show = new AgentFrameworkMessage("", {}, {}, {}, this.original_input_message, null);
    let config = { "interceptor": this.interceptor, "invocation_context": this.invocation_context };
    let tracing_factory = MasterTracingContextFactory.create_tracing_context_factory();
    this.tracing_context = tracing_factory.create_tracing_context(config, this);
    try {
      await this.tracing_context.run_it(input_message_for_show);
    } finally {
      this.invocation_context.get_work_done_event().set();
    }
  }
  /**
   * This method is effectively a callback which is invoked within
   * the tracing context infrastructure for the toolkit/context_type.
   *
   * :param inputs: An AgentFrameworkMessage populated with the user's input.
   * :return: The user input. (Outputs are handled by the tracing context infrastructure.)
   */
  async run_it(inputs) {
    if (this.invocation_context.get_effective_invocation() == "event") {
      let event_acknowledge = new AgentFrameworkMessage("Event acknowledged");
      await this.finalize_request(event_acknowledge);
    }
    let user_input = this.original_input_message.content;
    let sly_data = this.original_input_message.sly_data;
    let chat_context = this.original_input_message.chat_context;
    if (this.front_man == null) {
      try {
        await this.set_up(this.invocation_context, sly_data, chat_context);
      } catch (exc) {
        let message2 = new AgentFrameworkMessage(String(exc));
        await this.finalize_request(message2);
        return message2;
      }
    }
    let chat_messages = await this.chat(user_input, this.invocation_context, sly_data);
    let message_list = list3(chat_messages);
    let return_chat_context = this.prepare_chat_context(message_list);
    let front_man_spec = this.front_man.get_agent_tool_spec();
    let structure_formats = dict.get(front_man_spec, "structure_formats");
    let answer_processor = new AnswerMessageProcessor(structure_formats);
    answer_processor.process_messages(message_list);
    let answer = answer_processor.get_answer();
    if (answer == null) {
      answer = "";
    }
    let structure = answer_processor.get_structure();
    let redactor = new SlyDataRedactor(front_man_spec, ["allow.to_upstream.sly_data"], false);
    let return_sly_data = redactor.filter_config(this.sly_data);
    let tracing_redactor = new SlyDataRedactor(front_man_spec, ["allow.to_tracing.sly_data"], false);
    let message = new AgentFrameworkMessage(answer, return_chat_context, return_sly_data, structure, null, tracing_redactor);
    await this.finalize_request(message);
    let outputs = inputs;
    return outputs;
  }
  /**
   * Performs a portion of the streaming_chat() responsibilities
   *
   * :param user_input: A string with the user's input
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be null.
   * :return: An Iterator over dictionary representation of chat messages.
   * The keys/values/structure of these chat message dictionaries will reflect
   * instances of ChatMessage from chat.proto.
   *
   * Note that Iterators themselves are *not* simply lists. They are a Python
   * construct intended for use in a for-loop that is allowed to come up with
   * its content dynamically.  For our purposes, when an initiator of chat()
   * gets a handle to this Iterator, they can begin looping/waiting on its contents
   * without the content itself having been created yet.  This is a building
   * block of streaming results even though direct callers may not actually
   * be streaming.
   */
  async chat(user_input, invocation_context, sly_data) {
    if (this.front_man == null) {
      await this.set_up(invocation_context, sly_data);
    } else {
      this.front_man.update_invocation_context(invocation_context);
    }
    let raw_messages = await this.front_man.submit_message(user_input);
    let converter = new BaseMessageDictionaryConverter(this.front_man.get_origin(), true);
    let chat_messages = [];
    for (const raw_message of iter2(raw_messages)) {
      let chat_message = converter.to_dict(raw_message);
      chat_messages.push(chat_message);
    }
    return iter2(chat_messages);
  }
  /**
   * This is a method that publishes the resulting message of the request
   * and performs necessary finalization steps for request resources.
   *
   * :param message: The final message delivered from the run.
   * :return: Nothing.
   */
  async finalize_request(message) {
    if (this.last_message_sent) {
      return;
    }
    this.last_message_sent = true;
    await this.interceptor.write_message(message, null);
    let queue = this.invocation_context.get_queue();
    await queue.put_final_item({ synchronous: true });
  }
  /**
   * Prepare the chat context.
   *
   * :param chat_message_history: A list of ChatMessage dictionaries that
   * comprise the front man's full chat history.
   * :return: A ChatContext dictionary comprising the full state of play of
   * the conversation such that it could be taken up on a different
   * server instance
   */
  prepare_chat_context(chat_message_history) {
    let max_message_history = dict.get(this.front_man.get_agent_tool_spec(), "max_message_history");
    let processor = new ChatHistoryMessageProcessor(max_message_history);
    processor.process_messages(chat_message_history);
    let chat_history = { "origin": this.front_man.get_origin(), "messages": processor.get_message_history() };
    let chat_context = { "chat_histories": [chat_history] };
    return chat_context;
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: The parent resource, if any
   */
  async close_of_work(parent_resource) {
    await this.close_sly_data();
    if (this.front_man != null) {
      await this.front_man.close_of_work();
      this.front_man = null;
    }
    if (this.tracing_context != null) {
      await this.tracing_context.flush();
      this.tracing_context = null;
    }
  }
  /**
   * Close any sly data value that can be closed.
   */
  async close_sly_data() {
    if (this.sly_data == null || len(this.sly_data) == 0) {
      return;
    }
    for (const [key, value] of Object.entries(this.sly_data)) {
      let description = `sly_data[${key}]`;
      await this.close_one(value, description);
    }
  }
  /**
   * Close a single object if it can be closed.
   * :param value: The object to close
   * :param description: Where the object to close came from
   */
  async close_one(value, description) {
    if (!hasattr2(value, "close")) {
      return;
    }
    let close_method = getattr2(value, "close");
    if (!callable(close_method)) {
      return;
    }
    try {
      if (iscoroutinefunction(close_method)) {
        await close_method();
      } else {
        close_method();
      }
    } catch (e) {
      let logger = getLogger(this.constructor.name);
      logger.error("Unable to close() %s", description);
      logger.error(format_exc());
    }
  }
}
exposeClassAttributes(DataDrivenChatSession);
class QueueFilter {
  /**
   * Constructor
   *
   * :param chat_filter: A dictionary form of chat.ChatFilter
   * :param agent_network: An instance of AgentNetwork
   */
  constructor(chat_filter, agent_network) {
    this.message_filter = MessageFilterFactory.create_message_filter(chat_filter);
    this.message_processor = this.create_outgoing_message_processor(agent_network);
  }
  /**
   * :param agent_network: An instance of AgentNetwork
   * :return: A MessageProcessor that filters messages outgoing to the client.
   * How this works is based on settings on the front man.
   * Can be null.
   */
  create_outgoing_message_processor(agent_network) {
    let front_man_name = agent_network.find_front_man();
    let front_man_spec = agent_network.get_agent_tool_spec(front_man_name);
    let structure_formats = dict.get(front_man_spec, "structure_formats");
    if (structure_formats == null) {
      return null;
    }
    let message_processor = new StructureMessageProcessor(structure_formats);
    return message_processor;
  }
  /**
   * Apply the filter and processor to the MessageJournal
   */
  apply_to_journal(message_journal) {
    message_journal.set_message_filter(this.message_filter);
    message_journal.set_message_processor(this.message_processor);
  }
}
exposeClassAttributes(QueueFilter);
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
class MissingAgentCheck {
  /**
   * :param agent_network: The AgentNetwork to check
   * :param agent_name: The name of the agent to use for the session.
   * :return: The AgentNetwork corresponding to the agent_name
   */
  static check_agent_network(agent_network, agent_name) {
    if (agent_network == null) {
      const manifest_file = dict.get(process.env, "AGENT_MANIFEST_FILE");
      const message = `
Agent named "${agent_name}" not found in manifest file: ${manifest_file}.

Some things to check:
1. If the manifest file named above is null, know that the default points
   to the one provided with the neuro-san library for a smoother out-of-box
   experience.  If the agent you wanted is not part of that standard distribution,
   you need to set the AGENT_MANIFEST_FILE environment variable to point to a
   manifest.hocon file associated with your own project(s).
2. Check that the environment variable AGENT_MANIFEST_FILE is pointing to
   the manifest.hocon file that you expect and has no typos.
3. Does your manifest.hocon file contain a key for the agent specified?
4. Does the value for the key in the manifest file have a value of 'true'?
5. Does your agent name have a typo either in the hocon file or on the command line?
`;
      throw new Error(message);
    }
    return agent_network;
  }
}
exposeClassAttributes(MissingAgentCheck);
class AsyncCollatingQueue {
  static {
    this.END_KEY = "end";
  }
  static {
    this.END_MESSAGE = { [AsyncCollatingQueue.END_KEY]: true };
  }
  /**
   * Constructor
   *
   * :param queue: The queue we will be iterating over.
   * Default value is null, indicating a standard Queue will be used.
   */
  constructor(queue) {
    this.queue = queue;
    if (this.queue == null) {
      this.queue = new Queue();
    }
    this.last_item_sent = false;
  }
  /**
   * :return: The Queue associated with this instance
   */
  get_queue() {
    return this.queue;
  }
  /**
   * Self-identify as an AsyncIterator when called upon by
   * the Python async framework.
   */
  __aiter__() {
    return this;
  }
  /**
   * :return: Blocks waiting to return the next item on the queue.
   * Will throw StopAsyncIteration when the final item is detected
   * via the is_final_item() method..
   */
  async *[Symbol.asyncIterator]() {
    while (true) {
      const message = await this.queue.async_q.get();
      if (this.is_final_item(message)) {
        return;
      }
      yield message;
    }
  }
  /**
   * Fulfills AsyncHopper interface
   *
   * :param item: The item to put on the queue.
   * :param synchronous: When False (the default), we use the asynchronous-side
   * of the queue for our put() operation.  This is generally what
   * would be expected inside an async call, which is why it is the default.
   * When True, we use the synchronous side of the queue for put().
   * This ends up being necessary when each end of the queue is serviced
   * in a different asyncio event loop.
   * :param check_last_item_sent: When True (the default), this method will
   * not put anything if the last item was already sent.
   */
  async put(item, synchronous, check_last_item_sent) {
    if (check_last_item_sent && this.last_item_sent) {
      return;
    }
    if (synchronous) {
      this.queue.sync_q.put(item);
    } else {
      await this.queue.async_q.put(item);
    }
  }
  /**
   * Puts the final item on the queue indicating that no more data will
   * be on the queue and the consumer's iteration can cease when it sees
   * this item.
   * :param synchronous: When False (the default), we use the asynchronous-side
   * of the queue for our put() operation.  This is generally what
   * would be expected inside an async call, which is why it is the default.
   * When True, we use the synchronous side of the queue for put().
   * This ends up being necessary when each end of the queue is serviced
   * in a different asyncio event loop.
   */
  async put_final_item(synchronous) {
    if (this.last_item_sent) {
      return;
    }
    this.last_item_sent = true;
    await this.put(AsyncCollatingQueue.END_MESSAGE, synchronous, false);
  }
  /**
   * :param item: An item that has just been pulled off the queue
   * :return: True if this item is considered the marker for the
   * end of data. False otherwise.
   */
  is_final_item(item) {
    return is_dict(item) && dict.get(item, AsyncCollatingQueue.END_KEY) != null;
  }
  /**
   * Close this queue
   */
  close() {
    this.queue.close();
  }
  /**
   * Allows more messages to be sent on this queue
   */
  reset() {
    this.last_item_sent = false;
  }
}
exposeClassAttributes(AsyncCollatingQueue);
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
  safe_shallow_copy(invocation) {
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
class DirectAgentSessionFactory {
  /**
   * Constructor
   */
  constructor() {
    let manifest_restorer = new RegistryManifestRestorer();
    let manifest_networks = manifest_restorer.restore();
    this.network_storage_dict = {};
    this.network_storage_dict[StorageClass.TEMP] = new ExpiringAgentNetworkStorage();
    for (const storage_class of StorageClass.ALL_PERMANENT) {
      let storage = DirectAgentStorageUtil.create_network_storage(manifest_networks, storage_class);
      this.network_storage_dict[storage_class] = storage;
    }
  }
  /**
   * :param agent_name: The name of the agent to use for the session.
   * This name can be something in the manifest file (with no file suffix)
   * or a specific full-reference to an agent network's hocon file.
   * :param use_direct: When True, will use a Direct session for
   * external agents that would reside on the same server.
   * :param metadata: A grpc metadata of key/value pairs to be inserted into
   * the header. Default is null. Preferred format is a
   * dictionary of string keys to string values.
   * :param umbrella_timeout: A Timeout object to periodically check in loops.
   * Default is null (no timeout).
   */
  create_session(agent_name, use_direct, metadata, umbrella_timeout) {
    let agent_network = this.get_agent_network(agent_name);
    let config = agent_network.get_config();
    let llm_factory = MasterLlmFactory.create_llm_factory(config);
    let toolbox_factory = MasterToolboxFactory.create_toolbox_factory(config);
    llm_factory.load();
    toolbox_factory.load();
    let factory = new ExternalAgentSessionFactory(use_direct, this.network_storage_dict);
    let executors_pool = new AsyncioExecutorPool();
    let reservationist = new DirectAgentReservationist(set([dict.get(this.network_storage_dict, StorageClass.TEMP)]));
    let invocation_context = new SessionInvocationContext(agent_name, factory, executors_pool, llm_factory, toolbox_factory, metadata, reservationist);
    invocation_context.start();
    let session = new DirectAgentSession(agent_network, invocation_context, metadata, null, umbrella_timeout);
    return session;
  }
  /**
   * :param agent_name: The name of the agent whose AgentNetwork we want to get.
   * This name can be something in the manifest file (with no file suffix)
   * or a specific full-reference to an agent network's hocon file.
   * :return: The AgentNetwork corresponding to that agent.
   */
  get_agent_network(agent_name) {
    if (agent_name == null || len(agent_name) == 0) {
      return null;
    }
    let agent_network = null;
    if (agent_name.endsWith(".hocon") || agent_name.endsWith(".json")) {
      let restorer = new AgentNetworkRestorer();
      agent_network = restorer.restore({ file_reference: agent_name });
    } else {
      for (const storage_type of StorageClass.ALL_PERMANENT) {
        let storage = dict.get(this.network_storage_dict, storage_type);
        let agent_network_provider = storage.get_agent_network_provider(agent_name);
        if (agent_network_provider == null) {
          continue;
        }
        agent_network = agent_network_provider.get_agent_network();
        if (agent_network != null) {
          break;
        }
      }
    }
    MissingAgentCheck.check_agent_network(agent_network, agent_name);
    return agent_network;
  }
}
exposeClassAttributes(DirectAgentSessionFactory);
export {
  AsyncDirectAgentSession,
  DirectAgentSession,
  ExpiringAgentNetworkStorage,
  ExternalAgentSessionFactory,
  SessionInvocationContext
};
