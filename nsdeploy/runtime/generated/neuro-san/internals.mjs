import { process } from "../browser/process.mjs";
import { Lock, len, dict, open, open$1, BytesIO, nullcontext, contains, set, is_dict } from "./stubs.mjs";
import { getLogger, type2, string2, iter2, tuple2, fullMatch, urlparse, slice2, isinstance2, dumps, strFormat2, AIMessage, SystemMessage, copy } from "../vendor/libraries.mjs";
import { Restorer, HoconSerializationFormat, JsonSerializationFormat, StringFilter } from "./leaf_common.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
import { AgentSessionConstants, ErrorFormatter, AgentProgressReporter } from "./interfaces.mjs";
import { TracedMessage, BaseMessageDictionaryConverter, AgentToolResultMessage, ContentUtils, AgentProgressMessage, MaximalMessageFilter } from "./message.mjs";
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
class McpToolNameFilter extends StringFilter {
  static {
    this.NETWORK_SEPARATOR = "/";
  }
  static {
    this.NEURO_SAN_MCP_SEPARATOR = "__";
  }
  static {
    this.UNSAFE_REPLACEMENT = "_";
  }
  /**
   * Converts a neuro-san network name into a provider-safe tool name.
   *
   * Every NETWORK_SEPARATOR becomes NEURO_SAN_MCP_SEPARATOR and every
   * remaining character outside ASCII letters, digits, underscore and
   * hyphen becomes UNSAFE_REPLACEMENT. The mapping is idempotent, so a
   * name that has already been converted comes back unchanged.
   *
   * :param in_string: The network (or tool) name to convert. null and the
   * empty string are passed through untouched so callers
   * can feed optional values straight in.
   * :return: The provider-safe tool name, or the input itself when it is
   * null or empty.
   */
  filter(in_string) {
    if (in_string == null) {
      return null;
    }
    if (!in_string) {
      return "";
    }
    let separated = string2.replace(in_string, McpToolNameFilter.NETWORK_SEPARATOR, McpToolNameFilter.NEURO_SAN_MCP_SEPARATOR);
    let safe_chars = [];
    for (const char of iter2(separated)) {
      if (McpToolNameFilter.is_safe_char(char)) {
        safe_chars.push(char);
      } else {
        safe_chars.push(McpToolNameFilter.UNSAFE_REPLACEMENT);
      }
    }
    return safe_chars.join("");
  }
  /**
   * Tells whether a single character is allowed in a provider-safe tool name.
   *
   * :param char: A one-character string to test.
   * :return: True if the character is an ASCII letter, ASCII digit,
   * underscore or hyphen; False otherwise.
   */
  static is_safe_char(char) {
    if (!char.isascii()) {
      return false;
    }
    if (/^[a-zA-Z0-9]+$/.test(char)) {
      return true;
    }
    return contains(char, tuple2(McpToolNameFilter.UNSAFE_REPLACEMENT, "-"));
  }
}
exposeClassAttributes(McpToolNameFilter);
class McpToolNamePolicy extends StringFilter {
  static {
    this.TOOL_NAME_PATTERN = "^[a-zA-Z0-9_-]{1,128}$";
  }
  static {
    this.SOFT_MAX_LENGTH = 64;
  }
  /**
   * Constructor
   *
   * :param tool_name_filter: The StringFilter that maps a network name to a
   * provider-safe tool name. Defaults to McpToolNameFilter.
   */
  constructor(tool_name_filter) {
    super();
    this.tool_name_filter = tool_name_filter;
    if (this.tool_name_filter == null) {
      this.tool_name_filter = new McpToolNameFilter();
    }
  }
  /**
   * Converts a network (or tool) name into its provider-safe spelling,
   * using the tool-name filter this policy was constructed with.
   *
   * :param in_string: The network or tool name to convert. With the default
   * filter, null and the empty string come back unchanged.
   * :return: The provider-safe tool name.
   */
  filter(in_string) {
    return this.tool_name_filter.filter(in_string);
  }
  /**
   * Checks a name against the strictest common provider tool-name pattern.
   *
   * :param name: The tool name to validate.
   * :return: True if the name fully matches TOOL_NAME_PATTERN;
   * False for null, the empty string, or any non-matching name.
   */
  static is_valid_tool_name(name) {
    if (!name) {
      return false;
    }
    return fullMatch(McpToolNamePolicy.TOOL_NAME_PATTERN, name) != null;
  }
  /**
   * Tells whether a tool name exceeds the OpenAI 64-character cap.
   *
   * :param name: The tool name to measure.
   * :return: True if the name is not null and longer than SOFT_MAX_LENGTH;
   * False otherwise.
   */
  static is_over_soft_limit(name) {
    return name != null && len(name) > McpToolNamePolicy.SOFT_MAX_LENGTH;
  }
  /**
   * Tells whether one allow-list entry refers to the given original tool name,
   * accepting either the original spelling or the provider-safe spelling.
   *
   * :param entry: A single allow-list entry as written in a hocon file.
   * :param original_name: The tool name as advertised by the MCP server.
   * :return: True if the entry names the same tool under any accepted
   * spelling; False otherwise.
   */
  matches(entry, original_name) {
    if (entry == original_name) {
      return true;
    }
    let mangled_original = this.filter(original_name);
    if (entry == mangled_original) {
      return true;
    }
    return this.filter(entry) == mangled_original;
  }
  /**
   * Finds the one advertised tool an allow-list entry refers to.
   *
   * The exact spelling wins over the provider-safe equivalence. That matters
   * when a server offers both "a/b" and "a__b": the entry "a/b" then means
   * "a/b" alone and the entry "a__b" means "a__b" alone, so the caller is
   * never left choosing between two tools the author did not both ask for.
   *
   * :param entry: A single allow-list entry as written in a hocon file.
   * :param original_names: The tool names as advertised by the MCP server.
   * :return: The advertised name equal to entry when there is one; otherwise
   * the first advertised name that matches() the entry; null when
   * nothing matches or original_names is null or empty.
   */
  resolve(entry, original_names) {
    if (!original_names) {
      return null;
    }
    if (contains(entry, original_names)) {
      return entry;
    }
    for (const original_name of iter2(original_names)) {
      if (this.matches(entry, original_name)) {
        return original_name;
      }
    }
    return null;
  }
  /**
   * Picks the advertised tools an allow list permits, resolving each entry
   * to exactly one tool with resolve().
   *
   * :param allowed_names: The allow-list entries from configuration.
   * :param original_names: The tool names as advertised by the MCP server.
   * :return: The advertised names some entry resolves to, in the order the
   * server advertised them and without duplicates. Empty when
   * allowed_names is null or empty; callers decide for themselves
   * whether an absent allow list means "allow everything".
   */
  select_allowed(allowed_names, original_names) {
    let selected = set();
    if (allowed_names) {
      for (const entry of iter2(allowed_names)) {
        let chosen = this.resolve(entry, original_names);
        if (chosen != null) {
          selected.add(chosen);
        }
      }
    }
    let ordered = [];
    for (const original_name of original_names || []) {
      if (contains(original_name, selected)) {
        ordered.push(original_name);
      }
    }
    return ordered;
  }
  /**
   * Finds allow-list entries that do not correspond to any advertised tool,
   * so callers can warn about typos or renamed tools.
   *
   * :param allowed_names: The allow-list entries from configuration.
   * :param original_names: The tool names as advertised by the MCP server.
   * :return: The entries of allowed_names, in their original order, that
   * resolve() to none of original_names. Empty when allowed_names
   * is null or empty.
   */
  find_unmatched(allowed_names, original_names) {
    let unmatched = [];
    if (!allowed_names) {
      return unmatched;
    }
    for (const entry of iter2(allowed_names)) {
      if (this.resolve(entry, original_names) == null) {
        unmatched.push(entry);
      }
    }
    return unmatched;
  }
}
exposeClassAttributes(McpToolNamePolicy);
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
    let hostinfo = parse_result.netloc.slice(parse_result.netloc.lastIndexOf("@") + 1);
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
        port = parse_result.netloc.slice(parse_result.netloc.lastIndexOf(":") + 1);
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
  ErrorDetector,
  ExternalAgentParsing,
  InterceptingJournal,
  McpToolNamePolicy,
  MessageJournal,
  MetadataUtil,
  OriginatingJournal,
  Origination,
  ProgressJournal,
  ToolArgumentReporting
};
