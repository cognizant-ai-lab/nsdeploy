import { exposeClassAttributes } from "../browser/shims.mjs";
import { urlparse, at2, slice2, isinstance2, tuple2, string2, getLogger, monotonic, max2, round2, time, iter2, sorted2, uuid4, UUID, min2, getenv, type2, copy, dumps, strFormat2, AIMessage, SystemMessage, list3, hasattr2, getattr2 } from "../vendor/libraries.mjs";
import { len, contains, is_dict, dict, Event, Thread, Event$1, get_running_loop, run_coroutine_threadsafe, Lock, open, open$1, BytesIO, nullcontext, set, deepcopy, callable, iscoroutinefunction, format_exc, Queue } from "./stubs.mjs";
import { SensitiveLogger, Startable, Restorer, HoconSerializationFormat, JsonSerializationFormat, DictionaryExtractor } from "./leaf_common.mjs";
import { ResolvedNetworkConfigFilter, AgentNetwork, AgentToolRegistry } from "./graph.mjs";
import { process } from "../browser/process.mjs";
import { MasterToolboxFactory, RunContextFactory, MasterTracingContextFactory } from "./run_context.mjs";
import { AbstractNetworkValidator, ManifestNetworkValidator } from "./validation.mjs";
import { MessageProcessor, ChatMessageType, TracedMessage, BaseMessageDictionaryConverter, AgentToolResultMessage, ContentUtils, AgentProgressMessage, SlyDataRedactor, AgentFrameworkMessage, AnswerMessageProcessor, MessageFilterFactory, StructureMessageProcessor, MaximalMessageFilter } from "./message.mjs";
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
class ExternalAgentParsing {
  /**
   * Parses an external agent reference into the host, port, agent name and scheme it points at.
   *
   * :param agent_url: The URL describing where to find the desired agent.
   * :param server_port: The port that the server is listening on
   * Does not have to be set for all operations.
   * :return: A Dictionary with the following keys:
   * "host" - the hostname where the agent lives; an IPv6 literal
   * keeps its square brackets so it can be placed in a URL
   * "port" - the port on the host which serves up the agent (if any)
   * "agent_name" - the name of the agent on that host
   * "scheme" - the url scheme of the reference ("http" or
   * "https"), or "" when the reference has no
   * scheme, e.g. "/math_guy" for an agent on the
   * same server.
   *
   * OR
   *
   * null if the parsing of the agent_url was unsuccessful.
   */
  static parse_external_agent(agent_url, server_port = null) {
    if (agent_url == null || len(agent_url) == 0) {
      return null;
    }
    let port_number = null;
    let parse_result = null;
    try {
      parse_result = urlparse(agent_url);
      port_number = parse_result.port;
    } catch (e) {
      return null;
    }
    if (parse_result == null) {
      return null;
    }
    if (parse_result.path == null || len(parse_result.path) <= 1) {
      return null;
    }
    let hostinfo = at2(parse_result.netloc.rsplit("@", 1), -1);
    let malformed_authority = Boolean(parse_result.netloc) && (!parse_result.hostname || hostinfo.endsWith(":"));
    if (!parse_result.path.startsWith("/") || malformed_authority) {
      return null;
    }
    let scheme = parse_result.scheme || "";
    let host = null;
    let port = null;
    if (parse_result.hostname) {
      host = parse_result.hostname;
      if (contains(":", host)) {
        host = `[${host}]`;
      }
      if (port_number != null) {
        port = slice2(parse_result.netloc.rsplit(":", 1), 1);
      }
    }
    if (host == null || len(host) == 0) {
      host = "localhost";
    }
    if (host == "localhost" && port == null) {
      port = server_port;
    }
    if (port == null && scheme == "https") {
      port = String(AgentSessionConstants.DEFAULT_HTTPS_PORT);
    }
    let agent_name = parse_result.path;
    while (agent_name.startsWith("/")) {
      agent_name = slice2(agent_name, 1, void 0);
    }
    let return_dict = { "host": host, "port": port, "agent_name": agent_name, "scheme": scheme };
    return return_dict;
  }
  /**
   * :param agent_url: The URL describing where to find the desired agent.
   * :return: True if the given string is interpretable as an agent url
   * (without actually connecting to it).  False otherwise.
   */
  static is_external_agent(agent_url) {
    let agent_location = ExternalAgentParsing.parse_external_agent(agent_url);
    let is_external = agent_location != null;
    return is_external;
  }
  /**
   * Check if the tool reference is for an MCP server.
   * :param tool_ref: String URL or dict config for MCP tool
   * :return: True if this is an MCP tool reference
   */
  static is_mcp_tool(tool_ref) {
    if (is_dict(tool_ref)) {
      return true;
    }
    if (!isinstance2(tool_ref, String)) {
      return false;
    }
    let parsed = null;
    try {
      parsed = urlparse(tool_ref);
    } catch (e) {
      return false;
    }
    if (!contains(parsed.scheme.toLowerCase(), tuple2("http", "https"))) {
      return false;
    }
    if (!parsed.netloc || parsed.fragment) {
      return false;
    }
    let host_labels = (parsed.hostname || "").toLowerCase().split(".");
    let path_segments = [];
    for (const seg of parsed.path.split("/")) {
      if (seg) {
        path_segments.push(seg.toLowerCase());
      }
    }
    return contains("mcp", host_labels) || contains("mcp", path_segments);
  }
  /**
   * :param agent_url: The URL describing where to find the desired agent.
   * :return: A name that is suitable for using within agent toolkits (like langchain)
   * for internal tool reference.
   */
  static get_safe_agent_name(agent_url) {
    let safe_name = agent_url;
    if (ExternalAgentParsing.is_external_agent(agent_url)) {
      let agent_location = ExternalAgentParsing.parse_external_agent(agent_url);
      safe_name = "__" + string2.replace(dict.get(agent_location, "agent_name"), "/", "__");
    }
    return safe_name;
  }
}
exposeClassAttributes(ExternalAgentParsing);
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
class AgentNetworkProvider {
  /**
   * :return: AgentNetwork instance or null if no such AgentNetwork is available.
   */
  get_agent_network() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentNetworkProvider);
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
class AgentReservation extends Reservation {
  /**
   * Constructor
   *
   * :param lifetime_in_seconds: The number of seconds the reservation is allowed to exist.
   * :param prefix: A string prefix to prepend to the id so as to provide external context.
   */
  constructor(lifetime_in_seconds, prefix) {
    super(lifetime_in_seconds);
    this.id = String(uuid4());
    this.prefix = prefix;
    if (this.prefix == null) {
      this.prefix = "";
    }
    if (len(this.prefix) > 0) {
      this.prefix = `${this.prefix}-`;
    }
  }
  /**
   * :return: The id associated with the reservation instance
   */
  get_reservation_id() {
    return `${this.prefix}${this.id}`;
  }
  /**
   * :param agent_name: The name of an agent
   * :return: True if the name is in the format of a reservation id, False otherwise.
   */
  static is_reservation_name(agent_name) {
    if (!isinstance2(agent_name, String)) {
      return false;
    }
    let uuid_part = slice2(agent_name, -36, void 0);
    try {
      let u = new UUID(uuid_part);
      if (u.version == 4) {
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  /**
   * :return: The prefix assigned at construct time
   */
  get_prefix() {
    return this.prefix;
  }
  /**
   * :return: A url associated with the reservation.
   * Can be null if this is not an option for what we are reserving.
   */
  get_url() {
    let url = this.get_reservation_id();
    let external_url = dict.get(process.env, "AGENT_EXTERNAL_SERVER_URL");
    if (external_url != null) {
      while (external_url.endsWith("/")) {
        external_url = slice2(external_url, void 0, -1);
      }
      if (len(external_url) > 0) {
        url = `${external_url}/api/v1/${url}`;
      }
    }
    return url;
  }
  /**
   * Set the expiration time in seconds using the input as a basis for "now"..
   */
  set_expiration_from(use_now_in_seconds, max_lifetime_in_seconds) {
    let actual_lifetime = min2(this.get_lifetime_in_seconds(), max_lifetime_in_seconds);
    this.expiration_time_in_seconds = use_now_in_seconds + actual_lifetime;
  }
}
exposeClassAttributes(AgentReservation);
class AbstractAgentReservationist extends Reservationist {
  /**
   * Constructor
   *
   * :param reservations_storage: A Set of ReservationsStorage instances that manage
   * any temporary networks
   * :param max_lifetime_in_seconds: The maximum lifetime allowed for any Reservation.
   */
  constructor(reservations_storage, max_lifetime_in_seconds) {
    super();
    this.reservations_storage = reservations_storage;
    this.max_lifetime_in_seconds = max_lifetime_in_seconds;
  }
  /**
   * Creates a reservation for a specific time period.
   *
   * :param lifetime_in_seconds: The lifetime of the reservation
   * :param prefix: A string prefix to prepend to the id so as to provide external context.
   * :return: A new Reservation object corresponding to the request.
   */
  reserve(lifetime_in_seconds, prefix) {
    let actual_lifetime = min2(lifetime_in_seconds, this.max_lifetime_in_seconds);
    let reservation = new AgentReservation(actual_lifetime, { prefix });
    return reservation;
  }
  /**
   * Deploy multiple Reservations.
   *
   * :param deployment_dict: A dictionary whose keys are Reservation objects
   * previously obtained with reserve() and whose values are each an
   * object to deploy using the key as Reservation.
   * In this case, the object value to deploy is another dictionary where:
   * keys can be either a string or an asyncio.Event
   * values are a dictionary of AgentReservations -> agent_spec dictionaries
   * That is, these values are deployment_dicts from an AccumulatingAgentReservationist.
   * :param confirmation: When True, indicates a confirmation Event is desired.
   * When False (the default), no such confirmation is needed.
   * This is ignored on this instance
   * :return: Either a confiramtion Event object whose wait() method will confirm
   * that the deployment is complete, or null, depending on the value passed
   * for confirmation.
   * This instance always returns null.
   */
  async deploy(deployment_dict, confirmation) {
    throw Error("Method not implemented");
  }
  /**
   * :param event: The event to set
   */
  static set_event(event) {
    event.set();
  }
  /**
   * :param deployment_dict: A dictionary whose keys are AgentReservations
   * and whose values are agent network spec dictionaries.
   * :param source: A string describing where the deployment was coming from
   * :param max_lifetime_in_seconds: Longest a temp network can live
   */
  async deploy_together(deployment_dict, source, max_lifetime_in_seconds) {
    let use_now = time();
    let reservations_dict = {};
    for (const [reservation, agent_spec] of Object.entries(deployment_dict)) {
      reservation.set_expiration_from(use_now, max_lifetime_in_seconds);
      reservations_dict[reservation] = agent_spec;
    }
    for (const storage of this.reservations_storage) {
      await storage.add_reservations(reservations_dict, source);
    }
  }
}
exposeClassAttributes(AbstractAgentReservationist);
class DirectAgentReservationist extends AbstractAgentReservationist {
  /**
   * Deploy multiple Reservations.
   *
   * :param deployment_dict: A dictionary whose keys are Reservation objects
   * previously obtained with reserve() and whose values are each an
   * object to deploy using the key as Reservation.
   * In this case, the object value to deploy is another dictionary where:
   * keys can be either a string or an asyncio.Event
   * values are a dictionary of AgentReservations -> agent_spec dictionaries
   * That is, these values are deployment_dicts from an AccumulatingAgentReservationist.
   * :param confirmation: When True, indicates a confirmation Event is desired.
   * When False (the default), no such confirmation is needed.
   * This is ignored on this instance
   * :return: Either a confiramtion Event object whose wait() method will confirm
   * that the deployment is complete, or null, depending on the value passed
   * for confirmation.
   * This instance always returns null.
   */
  async deploy(deployment_dict, confirmation) {
    for (const storage of this.reservations_storage) {
      storage.expire_reservations();
    }
    if (!deployment_dict) {
      return null;
    }
    for (const [reservation, value] of Object.entries(deployment_dict)) {
      const to_deploy = value;
      for (const [key, value2] of Object.entries(to_deploy)) {
        const source = reservation.get_prefix();
        deployment_dict = value2;
        const max_lifetime_in_seconds = this.max_lifetime_in_seconds;
        await this.deploy_together(deployment_dict, source, max_lifetime_in_seconds);
        if (isinstance2(key, Event$1)) {
          const event = key;
          const event_loop = get_running_loop();
          run_coroutine_threadsafe(DirectAgentReservationist.set_event(event), event_loop);
        }
      }
    }
    return null;
  }
}
exposeClassAttributes(DirectAgentReservationist);
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
class HoconParseLock {
  static {
    this.lock = new Lock();
  }
  /**
   * Acquire the process-wide parse lock.
   * :return: this instance
   */
  __enter__() {
    HoconParseLock.lock.acquire();
    return self;
  }
  /**
   * Release the process-wide parse lock.
   *
   * :param exc_type: The type of any exception raised inside the with-block
   * :param exc_value: The exception instance, if any
   * :param traceback: The traceback, if any
   * :return: False, so any exception from the with-block propagates
   */
  __exit__(exc_type, exc_value, traceback) {
    HoconParseLock.lock.release();
    return false;
  }
}
exposeClassAttributes(HoconParseLock);
class AbstractAsyncConfigRestorer extends Restorer {
  /**
   * Constructor
   *
   * :param file_purpose: A string description of the file to be restored.
   * :param env_var: An optional environment variable name to get any file_reference from.
   * :param deprecated_env_var: An optional environment variable name to get any file_reference from
   * that is deprecated.
   * :param must_exist: True if the file must exist, False otherwise
   */
  constructor(file_purpose, env_var, must_exist, deprecated_env_var) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.file_purpose = file_purpose;
    this.env_var = env_var;
    this.deprecated_env_var = deprecated_env_var;
    this.must_exist = must_exist;
  }
  /**
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference should be looked
   * up by the environment variable for the instance.
   * :return: the file path to use. Could still be null
   */
  get_file_path(file_reference) {
    let file_path = file_reference;
    if ((file_path == null || len(file_path) == 0) && this.env_var) {
      file_path = dict.get(process.env, this.env_var);
      if ((file_path == null || len(file_path) == 0) && this.deprecated_env_var) {
        file_path = dict.get(process.env, this.deprecated_env_var);
        if (file_path != null) {
          this.logger.warning("Using deprecated env var %s for %s. Please use %s instead.", this.deprecated_env_var, this.file_purpose, this.env_var);
        }
      }
    }
    return file_path;
  }
  /**
   * Synchronous restore from the given file reference.
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: a dictionary. Note the return type is, unknown so subclasses can
   * override by returning an object. Without this, you get a dictionary.
   */
  restore(file_reference) {
    let config = null;
    let file_path = this.get_file_path(file_reference);
    if (!file_path) {
      return config;
    }
    let file_contents = null;
    try {
      const file_obj = open(file_path, "rb");
      try {
        file_contents = file_obj.read();
      } finally {
        file_obj.close?.();
      }
    } catch (exception) {
    }
    if (file_contents != null) {
      config = this.deserialize_file_contents(file_path, file_contents);
    }
    return this.filter_config(config, file_path);
  }
  /**
   * Asynchronous restore from the given file reference.
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: a dictionary. Note the return type is, unknown so subclasses can
   * override by returning an object. Without this, you get a dictionary.
   */
  async async_restore(file_reference) {
    let config = null;
    let file_path = this.get_file_path(file_reference);
    if (!file_path) {
      return config;
    }
    let file_contents = null;
    try {
      const file_obj = open$1(file_path, "rb");
      try {
        file_contents = await file_obj.read();
      } finally {
        await file_obj.close?.();
      }
    } catch (exception) {
    }
    if (file_contents != null) {
      config = this.deserialize_file_contents(file_path, file_contents);
    }
    return this.filter_config(config, file_path);
  }
  /**
   * :param file_path: The path to the file being restored
   * :param file_contents: The contents of the file as bytes
   * :return: a dictionary
   */
  deserialize_file_contents(file_path, file_contents) {
    let config = null;
    let bytes_file = new BytesIO(file_contents);
    let serialization = null;
    let parse_lock = nullcontext();
    if (file_path.endsWith(".hocon")) {
      serialization = new HoconSerializationFormat(null, null, null, true);
      parse_lock = new HoconParseLock();
    } else if (file_path.endsWith(".json")) {
      serialization = new JsonSerializationFormat();
    } else {
      throw new Error(`File reference ${file_path} must be a .json or .hocon file`);
    }
    try {
      const _resource = parse_lock;
      try {
        config = serialization.to_object(bytes_file);
      } finally {
        _resource.close?.();
      }
    } catch (exception) {
      let message = `There was an error loading ${this.file_purpose} file "${file_path}".
Underlying error (${type2(exception)}): ${exception}`;
      throw new Error(message);
    }
    return config;
  }
  /**
   * Filters the given basis config.
   *
   * Ideally this would be a Pure Function in that it would not
   * modify the caller's arguments so that the caller has a chance
   * to decide whether to take any changes returned.
   *
   * :param basis_config: The config dictionary to act as the basis for filtering
   * :param file_path: The path to the file being restored
   * :return: A config dictionary, potentially modified as per the
   * policy encapsulated by the implementation
   */
  filter_config(basis_config, file_path) {
    if (basis_config == null && this.must_exist) {
      let env_var_msg = "";
      if (this.env_var) {
        if (!this.deprecated_env_var) {
          env_var_msg = ` the value of the ${this.env_var} env var and`;
        } else {
          env_var_msg = ` the value of the ${this.env_var} and/or the deprecated ${this.deprecated_env_var} env vars and`;
        }
      }
      let message = `
Could not find ${this.file_purpose} file at path: ${file_path}.
Some common problems include:
    * The file itself simply does not exist.
    * Path is not an absolute path and you are invoking the server from a place
      where the path is not reachable.
    * The path has a typo in it.

Double-check${env_var_msg} your current working directory (pwd).
`;
      throw new Error(message);
    }
    return basis_config;
  }
}
exposeClassAttributes(AbstractAsyncConfigRestorer);
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
class JsonErrorFormatter extends ErrorFormatter {
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
    let error_dict = { "error": message, "tool": agent_name };
    if (details != null) {
      error_dict["details"] = `${details}`;
    }
    let pretty = dumps(error_dict, { sortKeys: true, indent: 4 });
    return `\`\`\`json
${pretty}
\`\`\``;
  }
}
exposeClassAttributes(JsonErrorFormatter);
class StringErrorFormatter extends ErrorFormatter {
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
    let error = `Error from ${agent_name}: ${message}`;
    if (details != null) {
      error = `${error} (${details})`;
    }
    return error;
  }
}
exposeClassAttributes(StringErrorFormatter);
class ErrorFormatterFactory {
  /**
   * Creates an ErrorFormatter given the name.
   *
   * :param name: The name of the error formatter to use
   * :return: An ErrorFormatter instance.
   */
  static create_formatter(name) {
    let formatter = new StringErrorFormatter();
    if (name == null) {
      return formatter;
    }
    if (name.toLowerCase() == "json") {
      formatter = new JsonErrorFormatter();
    }
    return formatter;
  }
}
exposeClassAttributes(ErrorFormatterFactory);
class ErrorDetector {
  /**
   * Constructor
   *
   * :param agent_name: The name of the agent
   * :param error_formatter_name: An optional name for which type of ErrorFormatter to use.
   * :param system_error_fragments: A list of strings that identify errors from the system.
   * By default this is null.
   * :param agent_error_fragments: A list of strings that identify errors from the agent.
   * By default this is null.
   */
  constructor(agent_name, error_formatter_name, system_error_fragments, agent_error_fragments) {
    this.agent_name = agent_name;
    this.error_formatter_name = error_formatter_name;
    this.error_fragments = set();
    if (system_error_fragments != null) {
      for (const one of system_error_fragments) {
        this.error_fragments.add(one);
      }
    }
    if (agent_error_fragments != null) {
      for (const one of agent_error_fragments) {
        this.error_fragments.add(one);
      }
    }
  }
  /**
   * Determines whether the output from the agent should be considered an error.
   *
   * :param output: String output from an agent
   * :return: True/False as to whether or not this output should be considered an error.
   */
  is_error(output) {
    if (output == null) {
      return false;
    }
    for (const fragment of this.error_fragments) {
      if (contains(fragment, output)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Handles potential error in agent output.
   *
   * :param output: String output from an agent
   * :param details: An optional details string to send to an ErrorFormatter if necessary.
   * :return: The same string if there was no error, or if there was an error
   * a properly formatted error per the choice in the error_formatter_name.
   */
  handle_error(output, details) {
    if (!this.is_error(output)) {
      return output;
    }
    let formatter = ErrorFormatterFactory.create_formatter(this.error_formatter_name);
    let error_output = strFormat2(formatter, this.agent_name, output, details);
    return error_output;
  }
}
exposeClassAttributes(ErrorDetector);
class Journal {
  /**
   * Writes a BaseMessage entry into the journal
   * :param message: The BaseMessage instance to write to the journal
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  async write_message(message, origin) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Journal);
class InterceptingJournal extends Journal {
  /**
   * Constructor
   *
   * :param wrapped_journal: The journal to forward messages to
   * :param origin: The origin dictionary to match for intercepts
   */
  constructor(wrapped_journal, origin) {
    super();
    this.wrapped_journal = wrapped_journal;
    this.origin = origin;
    this.messages = [];
  }
  /**
   * Writes a BaseMessage entry into the journal
   * :param message: The BaseMessage instance to write to the journal
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  async write_message(message, origin) {
    await this.wrapped_journal.write_message(message, origin);
    this.write_unwrapped_message(message, origin);
  }
  /**
   * Write a message to this journal without going through the wrapped journal.
   *
   * :param message: The BaseMessage instance to write to the journal
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  write_unwrapped_message(message, origin) {
    if (origin == this.origin) {
      let new_message = message;
      if (isinstance2(message, TracedMessage)) {
        new_message = new message.constructor({ trace_source: message });
      }
      this.messages.push(new_message);
    }
  }
  /**
   * :return: the intercepted messages
   */
  get_messages() {
    return this.messages;
  }
}
exposeClassAttributes(InterceptingJournal);
class OriginatingJournal extends Journal {
  /**
   * Constructor
   *
   * :param wrapped_journal: The Journal that this implementation wraps
   * :param origin: The origin that will be applied to all messages.
   * :param chat_history: The chat history list instance to store write_message() results in.
   * Can be null (the default).
   */
  constructor(wrapped_journal, origin, chat_history) {
    super();
    this.wrapped_journal = wrapped_journal;
    this.origin = origin;
    this.chat_history = chat_history;
    this.pending = null;
  }
  /**
   * :return: The origin associated with this Journal
   */
  get_origin() {
    return this.origin;
  }
  /**
   * Writes a BaseMessage entry into the wrapped_journal
   * and appends to the chat history.
   *
   * :param message: The BaseMessage instance to write to the wrapped_journal
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   * For this particular implementation we expect this to be null
   */
  async write_message(message, origin) {
    let use_origin = this.origin;
    if (origin != null) {
      use_origin = origin;
    }
    if (this.chat_history != null && BaseMessageDictionaryConverter.is_relevant_to_chat_history(message)) {
      let chat_history_message = null;
      if (isinstance2(message, AgentToolResultMessage) || isinstance2(message, AIMessage) && !isinstance2(message.content, String)) {
        chat_history_message = new AIMessage({ content: ContentUtils.history_safe_text(message) });
      } else {
        chat_history_message = message;
      }
      if (!isinstance2(chat_history_message, SystemMessage)) {
        this.chat_history.push(chat_history_message);
      }
    }
    if (this.pending != null) {
      if (!this._is_dupe_of_pending(message)) {
        await this.wrapped_journal.write_message(this.pending, use_origin);
      }
      this.pending = null;
    }
    await this.wrapped_journal.write_message(message, use_origin);
  }
  /**
   * Decide whether the held pending message carries the same visible text
   * as the incoming message, so that only one of the two reaches clients.
   *
   * Both contents are projected to text with ContentUtils.flatten_to_text
   * and compared ignoring leading and trailing whitespace. The whitespace
   * normalization is needed because the pending message's content was
   * stripped when it was captured (JournalingCallbackHandler's on_llm_end),
   * while the incoming message's content is not, so an exact comparison
   * would let a mere trailing newline defeat the suppression and send
   * clients both copies of the same text.
   *
   * Projecting both sides to text matters once an incoming message can
   * carry list content (block content preserved from the provider): the
   * held AGENT copy is always a flattened string, so a raw equality against
   * a block list could never match and clients would receive both copies.
   * flatten_to_text is an identity on string, so string-only traffic compares
   * exactly as it did before.
   *
   * Normalizing here, rather than stripping at either capture point, is
   * deliberate: both captured texts are client-visible and locked by
   * backward compatibility (the AGENT copy has always been journaled
   * stripped; the AI text reaches the wire and chat history unstripped),
   * so changing either producer would change client-visible output. The
   * dupe decision is internal, which makes this comparison the one place
   * that can reconcile the two without altering any payload.
   *
   * :param message: The incoming BaseMessage to compare against the held
   * pending message.
   * :return: True if the pending message carries the same visible text as
   * the incoming message.
   */
  _is_dupe_of_pending(message) {
    let pending_text = ContentUtils.flatten_to_text(this.pending);
    let incoming_text = ContentUtils.flatten_to_text(message);
    return pending_text.trim() == incoming_text.trim();
  }
  /**
   * :return: The chat history list of base messages associated with the instance.
   */
  get_chat_history() {
    return this.chat_history;
  }
  /**
   * Writes a BaseMessage entry into the wrapped_journal
   * and appends to the chat history as long as the next message does not have the same content.
   *
   * :param message: The BaseMessage instance to write to the wrapped_journal
   */
  async write_message_if_next_not_dupe(message) {
    if (this.pending != null) {
      await this.write_message(this.pending, null);
    }
    this.pending = message;
  }
}
exposeClassAttributes(OriginatingJournal);
class Origination {
  static {
    this.INSTANTIATION_START = 1;
  }
  static {
    this.NUM_INSTANTIATION_INDEX_DIGITS = 2;
  }
  /**
   * Constructor
   */
  constructor() {
    this.tool_to_index_map = {};
  }
  /**
   * Adds a single component origin dictionary to the given origin list.
   * :param origin: A new List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   * :param agent_name: The agent name to be added to the list.
   * :return: The new origin with the agent name at the end of the list
   */
  add_spec_name_to_origin(origin, agent_name) {
    if (origin == null || agent_name == null) {
      return [];
    }
    let new_origin = copy(origin);
    let instantiation_index = dict.get(this.tool_to_index_map, agent_name, Origination.INSTANTIATION_START);
    this.tool_to_index_map[agent_name] = instantiation_index + 1;
    let origin_dict = { "tool": agent_name, "instantiation_index": instantiation_index };
    new_origin.push(origin_dict);
    return new_origin;
  }
  /**
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   * :return: A single string name given an origin path/list
   */
  static get_full_name_from_origin(origin) {
    if (origin == null) {
      return null;
    }
    let origin_list = [];
    for (const origin_dict of iter2(origin)) {
      let instantiation_index = dict.get(origin_dict, "instantiation_index", Origination.INSTANTIATION_START);
      let tool = dict.get(origin_dict, "tool");
      if (tool == null) {
        throw new Error("tool name in origin_dict is null");
      }
      let index_str = "";
      if (instantiation_index > Origination.INSTANTIATION_START) {
        index_str = `-${string2.zFill(String(instantiation_index), Origination.NUM_INSTANTIATION_INDEX_DIGITS)}`;
      }
      let safe_tool = ExternalAgentParsing.get_safe_agent_name(tool);
      let origin_str = `${safe_tool}${index_str}`;
      origin_list.push(origin_str);
    }
    let full_path = origin_list.join(".");
    let use_full_path = string2.replace(full_path, "./", "/");
    return use_full_path;
  }
  /**
   * Resets the origination tracking
   */
  reset() {
    this.tool_to_index_map = {};
  }
}
exposeClassAttributes(Origination);
class ToolArgumentReporting {
  static {
    this.POLICY_OBJECT_KEYS = ["reservationist", "progress_reporter", "runtime"];
  }
  /**
   * Common code to prepare a tool start dictionary.
   *
   * :param tool_args: The arguments that will be passed to the tool
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * :return: A dictionary for a future journal entry
   */
  static prepare_tool_start_dict(tool_args, origin) {
    let modified_tool_args = [...tool_args];
    if (origin != null) {
      modified_tool_args["origin"] = origin;
      let full_name = Origination.get_full_name_from_origin(origin);
      modified_tool_args["origin_str"] = full_name;
    }
    for (const key of ToolArgumentReporting.POLICY_OBJECT_KEYS) {
      if (contains(key, modified_tool_args)) {
        delete modified_tool_args[key];
      }
    }
    let tool_start_dict = { "tool_start": true, "tool_args": modified_tool_args };
    return tool_start_dict;
  }
}
exposeClassAttributes(ToolArgumentReporting);
class MetadataUtil {
  /**
   * :param request_metadata: The raw request metadata dictionary that could easily contain
   * more keys than we want to send to the UsageLogger.
   * :param keys: The keys we want to send to the UsageLogger
   * This can either be a single string with space-delimited keys, or a list of keys
   * :return: A minimized dictionary that only sends the keys we need to the UsageLogger.
   * The idea is that this prevents the UsageLogger from getting potentially
   * sensitive information it shouldn't really have.
   *
   * If the requested keys in the metadata are not there, they will also not appear
   * in the returned minimized dictionary.
   */
  static minimize_metadata(request_metadata, keys) {
    let minimized = {};
    if (request_metadata == null) {
      return minimized;
    }
    if (!keys) {
      return minimized;
    }
    let keys_list = [];
    if (isinstance2(keys, String)) {
      keys_list = keys.split(" ");
    } else if (isinstance2(keys, Array)) {
      keys_list = keys;
    }
    for (const key of iter2(keys_list)) {
      if (!key) {
        continue;
      }
      let value = dict.get(request_metadata, key);
      if (value) {
        minimized[key] = value;
      }
    }
    return minimized;
  }
}
exposeClassAttributes(MetadataUtil);
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
class ProgressJournal extends AgentProgressReporter {
  /**
   * Constructor
   *
   * :param wrapped_journal: The Journal that this implementation wraps
   */
  constructor(wrapped_journal) {
    super();
    this.wrapped_journal = wrapped_journal;
  }
  /**
   * Reports the structure and optional message to the chat message stream returned to the client
   * To be used from within CodedTool.async_invoke().
   *
   * :param structure: The Dictionary instance to write as progress.
   * All keys and values must be JSON-serializable.
   * :param content: An optional message to send to the client
   */
  async async_report_progress(structure, content) {
    if (structure == null) {
      return;
    }
    if (!is_dict(structure)) {
      throw new Error(`Expected dictionary, got ${type2(structure)}`);
    }
    if (content == null) {
      content = "";
    }
    let message = new AgentProgressMessage(content, { structure });
    await this.wrapped_journal.write_message(message, null);
  }
}
exposeClassAttributes(ProgressJournal);
class AccumulatingAgentReservationist extends Reservationist {
  /**
   * Constructor
   *
   * :param supporting_reservationist: The supporting Reservationist that will do the real work
   * :param agent_name: The full name of the agent using this instance
   * :param max_lifetime_in_seconds: The maximum lifetime allowed for any Reservation.
   */
  constructor(supporting_reservationist, agent_name, max_lifetime_in_seconds) {
    super();
    this.max_lifetime_in_seconds = max_lifetime_in_seconds;
    this.agent_name = agent_name;
    this.deployments = {};
    this._supporting_reservationist = supporting_reservationist;
    this._supporting_reservation = null;
    this._external_networks = null;
    this._mcp_servers = null;
  }
  /**
   * Creates a reservation for a specific time period.
   *
   * :param lifetime_in_seconds: The lifetime of the reservation
   * :param prefix: A string prefix to prepend to the id so as to provide external context.
   * :return: A new Reservation object corresponding to the request.
   */
  reserve(lifetime_in_seconds, prefix) {
    let actual_lifetime = min2(lifetime_in_seconds, this.max_lifetime_in_seconds);
    if (prefix != null && len(prefix) > 0) {
      AccumulatingAgentReservationist.validate_id(prefix);
    }
    let reservation = new AgentReservation(actual_lifetime, prefix);
    return reservation;
  }
  /**
   * Allow passing of validation parameters when using a with-statement.
   * These get reset in __aexit__().
   *
   * :param external_networks: A list of external network names
   * :param mcp_servers: A list of MCP servers, as read in from a mcp_info.hocon file
   * :return: The instance
   */
  validate_with(external_networks, mcp_servers) {
    this._external_networks = external_networks;
    this._mcp_servers = mcp_servers;
    return this;
  }
  /**
   * Python context manager protocol entrypoint.
   * This is what gets called when you enter a with-statement.
   */
  async __aenter__() {
    this.deployments = {};
    this._supporting_reservation = await this._supporting_reservationist.reserve({ prefix: this.agent_name });
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
    if (!deployment_dict) {
      return null;
    }
    let errors = {};
    for (const [reservation, agent_network_spec] of Object.entries(deployment_dict)) {
      let key2 = reservation.get_reservation_id();
      AccumulatingAgentReservationist.validate_id(key2);
      let validator = new ManifestNetworkValidator({ external_network_names: this._external_networks, mcp_servers: this._mcp_servers, network_name: key2 });
      let new_errors = validator.validate(agent_network_spec);
      if (new_errors != null && len(new_errors) > 0) {
        errors[key2] = new_errors;
      }
    }
    if (errors) {
      throw new Error(`Found ${len(Object.keys(errors))} validation errors when attempting to deploy():
${dumps(errors, { indent: 4, sortKeys: true })}`);
    }
    let event = null;
    let key = null;
    if (confirmation) {
      event = new Event$1();
      key = event;
    } else {
      let first_res = Object.keys(deployment_dict)[0];
      key = first_res.get_reservation_id();
    }
    let entry = { [key]: deployment_dict };
    Object.assign(this.deployments, entry);
    return event;
  }
  /**
   * Python context manager protocol exit point.
   * This is what gets called when you exit a with-statement.
   * This triggers the initiation of the deployment.
   * :return: True to suppress exception. False or null to propagate exception.
   */
  async __aexit__(exc_type, exc_val, exc_tb) {
    await this._supporting_reservationist.deploy_one(this._supporting_reservation, this.deployments);
    this._supporting_reservation = null;
    this._external_networks = null;
    this._mcp_servers = null;
    this.deployments = {};
  }
  /**
   * :param test_id:  The id string to test
   *
   * Will assert if the given id is not valid for external consumption
   */
  static validate_id(test_id) {
    if (test_id == null) {
      throw new Error("Reservation id is null");
    }
    if (len(test_id) == 0) {
      throw new Error("Reservation id is empty");
    }
    let invalid_chars = "/: ";
    for (const invalid_char of iter2(invalid_chars)) {
      if (contains(invalid_char, test_id)) {
        throw new Error(`Reservation id ${test_id} cannot contain any of these characters: '${invalid_chars}'`);
      }
    }
  }
}
exposeClassAttributes(AccumulatingAgentReservationist);
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
class AsyncCollatingQueue {
  static {
    this["end"] = "end";
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
    await this.put(this.END_MESSAGE, synchronous, false);
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
class MessageJournal extends Journal {
  /**
   * Constructor
   *
   * :param hopper: A handle to an AsyncHopper implementation, onto which
   * any message will be put().
   */
  constructor(hopper) {
    super();
    this.hopper = hopper;
    this.message_filter = new MaximalMessageFilter();
    this.message_processor = null;
  }
  /**
   * Sets the message filter for this journal.
   */
  set_message_filter(message_filter) {
    this.message_filter = message_filter;
  }
  /**
   * Sets the message processor for this journal.
   */
  set_message_processor(message_processor) {
    this.message_processor = message_processor;
  }
  /**
   * Writes a BaseMessage entry into the journal
   * :param message: The BaseMessage instance to write to the journal
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  async write_message(message, origin) {
    let converter = new BaseMessageDictionaryConverter(origin, true);
    let message_dict = converter.to_dict(message);
    let message_type = dict.get(message_dict, "type");
    if (!this.message_filter.allow_message(message_dict, message_type)) {
      return;
    }
    if (this.message_processor != null) {
      await this.message_processor.async_process_message(message_dict, message_type);
    }
    let outgoing_dict = { "response": message_dict };
    await this.hopper.put(outgoing_dict, { synchronous: true });
  }
}
exposeClassAttributes(MessageJournal);
export {
  AbstractAsyncConfigRestorer,
  AccumulatingAgentReservationist,
  AgentSession,
  AgentSessionConstants,
  AgentToolFactory,
  AsyncAgentSession,
  AsyncAgentSessionFactory,
  AsyncCollatingQueue,
  CallableActivation,
  CodedTool,
  ConnectivityReporter,
  ContextTypeLlmFactory,
  ContextTypeToolboxFactory,
  ContextTypeTracingContextFactory,
  DataDrivenChatSession,
  DirectAgentReservationist,
  EnvironmentConfiguration,
  ErrorDetector,
  ExpiringAgentNetworkStorage,
  ExternalAgentParsing,
  InterceptingJournal,
  InvocationContext,
  LingeringResource,
  MessageJournal,
  MetadataUtil,
  OriginatingJournal,
  Origination,
  ProgressJournal,
  QueueFilter,
  StorageClass,
  ToolArgumentReporting,
  TracingContext
};
