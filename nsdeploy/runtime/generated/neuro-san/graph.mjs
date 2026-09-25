import { iter2, isinstance2, list3, enumerate2, slice2, getLogger, string2, copy, dumps, AIMessage, uuid4, at2, perfCounter, range2, Path } from "../vendor/libraries.mjs";
import { get_deep_size, contains, dict, len, deepcopy, is_dict, suppress, issubclass, format_exc, TOP_LEVEL_DIR } from "./stubs.mjs";
import { DictionaryExtractor, ConfigFilter, DictionaryOverlay, ConfigFilterChain, FieldExtractor, ResolverUtil, Resolver, ConfigUtil } from "./leaf_common.mjs";
import { AgentNetworkInspector, RunContextFactory } from "./run_context.mjs";
import { exposeClassAttributes, posix } from "../browser/shims.mjs";
import { process } from "../browser/process.mjs";
import { CallableActivation, ExternalAgentParsing, Origination, AccumulatingAgentReservationist, ProgressJournal, CodedTool, ToolArgumentReporting, AgentToolFactory } from "./internals.mjs";
import { MessageProcessor, BaseMessageDictionaryConverter, BasicMessageProcessor, AgentMessage, SlyDataRedactor, ChatMessageType, ContentUtils } from "./message.mjs";
class AgentNetwork extends AgentNetworkInspector {
  /**
   * Constructor
   *
   * :param config: The dictionary describing the entire agent network
   * :param name: The name of the registry
   */
  constructor(config, name) {
    super();
    this.config = config;
    this.name = name;
    this.agent_spec_map = {};
    this.is_mcp_network = false;
    this.mcp_tool_name = null;
    this.first_agent = null;
    let agent_specs = this.config["tools"];
    if (agent_specs != null) {
      let agent_spec = null;
      for (const agent_spec2 of iter2(agent_specs)) {
        this.register(agent_spec2);
      }
    }
    this.size_in_bytes = get_deep_size(this, "bytes");
  }
  /**
   * :return: The config dictionary passed into the constructor
   */
  get_config() {
    return this.config;
  }
  /**
   * Marks this agent network as being served as an MCP tool, under the given name.
   *
   * Examples, for a network loaded from registries/deep/math_guy.hocon
   * (this.name is "deep/math_guy"):
   *
   * network.set_as_mcp_tool()
   * is_mcp_tool() -> True, get_mcp_tool_name() -> "deep/math_guy"
   * (the historical behavior; OpenAI and Anthropic reject the "/")
   * network.set_as_mcp_tool(new McpToolNameFilter().filter(network.name))
   * get_mcp_tool_name() -> "deep__math_guy"
   * network.set_as_mcp_tool("calculator")
   * get_mcp_tool_name() -> "calculator"   (an explicit manifest "mcp_name")
   *
   * For a top-level network (this.name is "math_guy") the first two calls both
   * give "math_guy", since there is nothing to replace.
   *
   * :param tool_name: The name to advertise the tool under in tools/list and
   * tools/call. Normally this is the provider-safe spelling of
   * the network name from new McpToolNameFilter().filter()
   * ("deep/math_guy" gives "deep__math_guy"; a top-level
   * "math_guy" is already safe and stays "math_guy"), or an
   * explicit "mcp_name" from the network's manifest entry.
   * When null or empty (the default) the network name itself is
   * used unchanged, which preserves the historical behavior for
   * callers that do not care about provider-safe names. Note that
   * a nested network advertised that way keeps its "/", which
   * OpenAI and Anthropic reject in tool names.
   */
  set_as_mcp_tool(tool_name) {
    this.is_mcp_network = true;
    if (tool_name) {
      this.mcp_tool_name = tool_name;
    } else {
      this.mcp_tool_name = this.name;
    }
  }
  /**
   * :return: True if this agent network is set to be served as an MCP tool;
   * False otherwise.
   */
  is_mcp_tool() {
    return this.is_mcp_network;
  }
  /**
   * Gets the name this network is advertised under as an MCP tool.
   *
   * :return: The advertised MCP tool name, or null if it is not served as an MCP tool.
   */
  get_mcp_tool_name() {
    return this.mcp_tool_name;
  }
  /**
   * Withdraws this agent network from being served as an MCP tool.
   *
   * Used when two networks would otherwise advertise the same tool name and
   * one of them has to give way. The network itself stays served over the
   * regular (non-MCP) APIs: it remains in network storage, so it can still be
   * reached at /api/v1/{name}/... over http and as a same-server "/{name}"
   * external agent. It only disappears from MCP tools/list and tools/call.
   *
   * Example: registries/a/b.hocon (network "a/b") and registries/a__b.hocon
   * (network "a__b") both derive the MCP tool name "a__b". The network whose
   * own name already is that tool name keeps it, so the other one is cleared:
   *
   * a_slash_b.clear_mcp_tool()
   * a_slash_b.is_mcp_tool() -> False, a_slash_b.get_mcp_tool_name() -> null
   * tools/list then shows a single "a__b" tool, backed by network "a__b"
   *
   * Calling set_as_mcp_tool() again makes the network an MCP tool once more.
   */
  clear_mcp_tool() {
    this.is_mcp_network = false;
    this.mcp_tool_name = null;
  }
  /**
   * :param agent_spec: A single agent to register
   */
  register(agent_spec) {
    if (agent_spec == null) {
      return;
    }
    let name = this.get_name_from_spec(agent_spec);
    if (this.first_agent == null) {
      this.first_agent = name;
    }
    if (contains(name, Object.keys(this.agent_spec_map))) {
      let message = `
The agent named "${name}" appears to have a duplicate entry in its hocon file for ${this.name}.
Agent names must be unique within the scope of a single hocon file.

Some things to try:
1. Rename one of the agents named "${name}". Don't forget to scrutinize all the
   tools references from other agents connecting to it.
2. If one definition is an alternate implementation, consider commenting out
   one of them with "#"-style comments.  (Yes, you can do that in a hocon file).
`;
      throw new Error(message);
    }
    this.agent_spec_map[name] = agent_spec;
  }
  /**
   * :param agent_spec: A single agent to register
   * :return: The agent name as per the spec
   */
  get_name_from_spec(agent_spec) {
    let extractor = new DictionaryExtractor(agent_spec, ".");
    let name = extractor.get("function.name", null);
    if (name == null) {
      name = dict.get(agent_spec, "name");
    }
    return name;
  }
  /**
   * :param name: The name of the agent tool to get out of the registry
   * :return: The dictionary representing the spec registered agent
   */
  get_agent_tool_spec(name) {
    if (name == null || !isinstance2(name, String)) {
      return null;
    }
    return this.agent_spec_map[name];
  }
  /**
   * :return: A single tool name to use as the root of the chat agent.
   * This guy will be user facing. If there are none,
   * an exception will be raised.
   */
  find_front_man() {
    let front_man = null;
    let agent_list = list3(Object.keys(this.agent_spec_map));
    let is_front_man_valid = true;
    if (len(agent_list) > 0) {
      front_man = agent_list[0];
      let agent_spec = this.get_agent_tool_spec(front_man);
      if (dict.get(agent_spec, "class") != null) {
        is_front_man_valid = false;
      } else if (dict.get(agent_spec, "toolbox") != null) {
        is_front_man_valid = false;
      }
    } else {
      is_front_man_valid = false;
    }
    if (is_front_man_valid === false) {
      throw new Error(`
No valid front man found for the ${this.name} agent network.

The front man is the first agent listed under the "tools" section of your agent HOCON file.
However, the front man must not be:
* A CodedTool (i.e., an agent defined with a "class" field)
* A toolbox agent (i.e., defined with a "toolbox" field)
`);
    }
    return front_man;
  }
  /**
   * :return: The network name of this AgentNetwork
   */
  get_network_name() {
    return this.name;
  }
  /**
   * :return: The request timeout in seconds for this AgentNetwork;
   * if not defined, returns 0.0
   */
  get_request_timeout_seconds() {
    let extractor = new DictionaryExtractor(this.config, ".");
    let timeout = extractor.get("request_timeout_seconds", null);
    if (timeout == null) {
      return 0;
    }
    return Number(timeout);
  }
  /**
   * :return: The size in Uint8Array of this AgentNetwork
   */
  get_size_in_bytes() {
    return this.size_in_bytes;
  }
}
exposeClassAttributes(AgentNetwork);
class DefaultsConfigFilter extends ConfigFilter {
  static {
    this.DEFAULTS_MAPPING = { "llm_config": null, "llm_config.verbose": { "dest_key": "verbose" }, "verbose": null, "max_steps": null, "max_iterations": null, "max_execution_seconds": null, "max_attempts": null, "error_formatter": null, "error_fragments": null, "sly_data_schema": { "dest_key": "function.sly_data_schema", "front_man_only": true, "union_fields": ["required"] } };
  }
  /**
   * Constructor
   */
  constructor() {
    super();
    this.overlayer = new DictionaryOverlay();
  }
  /**
   * Filters the given basis config.
   *
   * Ideally this would be a Pure Function in that it would not
   * modify the caller's arguments so that the caller has a chance
   * to decide whether to take any changes returned.
   *
   * :param basis_config: The config dictionary to act as the basis
   * for filtering
   * :return: A config dictionary, potentially modified as per the
   * policy encapsulated by the implementation
   */
  filter_config(basis_config) {
    if (basis_config == null) {
      return basis_config;
    }
    let tools = dict.get(basis_config, "tools");
    if (tools == null || len(tools) == 0) {
      return basis_config;
    }
    let result_config = deepcopy(basis_config);
    let basis_extractor = new DictionaryExtractor(result_config, ".");
    let use_tools = dict.get(result_config, "tools");
    let idx = 0;
    let tool = null;
    for (const [idx2, tool2] of enumerate2(use_tools)) {
      let tool_extractor = new DictionaryExtractor(tool2, ".");
      let is_front_man = idx2 == 0;
      let basis_source_key = null;
      let tool_dest_dict = null;
      for (const [basis_source_key2, tool_dest_dict2] of Object.entries(DefaultsConfigFilter.DEFAULTS_MAPPING)) {
        let basis_value = basis_extractor.get(basis_source_key2, null);
        if (basis_value == null) {
          continue;
        }
        let use_tool_dest_dict = tool_dest_dict2;
        if (use_tool_dest_dict == null) {
          use_tool_dest_dict = { "dest_key": basis_source_key2, "front_man_only": false, "union_fields": null };
        }
        let tool_dest_key = dict.get(use_tool_dest_dict, "dest_key", basis_source_key2);
        let tool_front_man_only = dict.get(use_tool_dest_dict, "front_man_only", false);
        if (tool_front_man_only && !is_front_man) {
          continue;
        }
        let tool_value = tool_extractor.get(tool_dest_key, null);
        if (tool_value == null) {
          this.set_tool_value(tool2, tool_dest_key, deepcopy(basis_value));
        } else if (is_dict(tool_value) && is_dict(basis_value)) {
          let union_fields = dict.get(use_tool_dest_dict, "union_fields");
          this.merge_dictionaries(tool2, tool_dest_key, basis_value, tool_value, union_fields);
        }
      }
    }
    return result_config;
  }
  /**
   * Merges the basis and tool dictionaries
   * :param tool: The tool dictionary itself
   * :param tool_dest_key: The destination key in the tool dictionary
   * :param basis_value: The dictionary value from the global basis
   * :param tool_value: The dictionary value from the tool
   * :param union_fields: The fields to union. Currently can not be a multi-part key.
   */
  merge_dictionaries(tool, tool_dest_key, basis_value, tool_value, union_fields = null) {
    this.set_tool_value(tool, tool_dest_key, this.overlayer.overlay(basis_value, tool_value));
    if (union_fields != null) {
      if (isinstance2(union_fields, String)) {
        let union_fields_string = union_fields;
        union_fields = [union_fields_string];
      }
      let one_field = null;
      for (const one_field2 of iter2(union_fields)) {
        let basis_field = dict.get(basis_value, one_field2, []);
        let tool_field = dict.get(tool_value, one_field2, []);
        let one_field_key = `${tool_dest_key}.${one_field2}`;
        let merged_lists = [...basis_field, ...tool_field];
        let merged_dict = dict.fromKeys(merged_lists);
        let merged_field = list3(Object.keys(merged_dict));
        this.set_tool_value(tool, one_field_key, merged_field);
      }
    }
  }
  /**
   * Sets the value of a key in the tool dictionary
   *
   * :param target: The dictionary to set the value in
   * :param key: The key to set the value for. This can be a multi-part key delimited by "."
   * :param value: The value to set
   */
  set_tool_value(target, key, value) {
    let delimiter = ".";
    if (!contains(delimiter, key)) {
      target[key] = value;
      return;
    }
    let parts = key.split(delimiter);
    let first_part = parts[0];
    let part_value = dict.get(target, first_part);
    if (part_value == null) {
      target[first_part] = {};
      part_value = target[first_part];
    } else if (!is_dict(part_value)) {
      return;
    }
    let remaining_parts_list = slice2(parts, 1, void 0);
    let remaining_parts = remaining_parts_list.join(".");
    this.set_tool_value(part_value, remaining_parts, value);
  }
}
exposeClassAttributes(DefaultsConfigFilter);
class AbstractCommonDefsConfigFilter extends ConfigFilter {
  /**
   * Constructor
   *
   * :param commondefs_key: The string key in the commondefs section
   * that contains the replacement dictionary.
   * :param replacements: An initial replacements dictionary to start out with
   * whose (copied) contents will be updated with commondefs definitions
   * in the basis_config during the filter_config() entry point.
   * Default is null, indicating everything needed comes from the config.
   */
  constructor(commondefs_key, replacements) {
    super();
    this.commondefs_key = commondefs_key;
    this.starting_replacements = replacements;
    if (replacements == null) {
      this.starting_replacements = {};
    }
  }
  /**
   * Filters the given basis config.
   *
   * Ideally this would be a Pure Function in that it would not
   * modify the caller's arguments so that the caller has a chance
   * to decide whether to take any changes returned.
   *
   * :param basis_config: The config dictionary to act as the basis
   * for filtering
   * :return: A config dictionary, potentially modified as per the
   * policy encapsulated by the implementation
   */
  filter_config(basis_config) {
    if (basis_config == null || !basis_config) {
      return basis_config;
    }
    let replacements = deepcopy(this.starting_replacements);
    let empty = {};
    let commondefs = dict.get(basis_config, "commondefs", empty);
    if (commondefs) {
      let new_replacements2 = deepcopy(dict.get(commondefs, this.commondefs_key, empty));
      Object.assign(replacements, new_replacements2);
    }
    if (!replacements || Object.keys(replacements).length === 0) {
      return basis_config;
    }
    let new_config = deepcopy(basis_config);
    let new_replacements = this.filter_one_dict(replacements, replacements);
    let tools = dict.get(basis_config, "tools");
    new_config["tools"] = this.filter_one_list(tools, new_replacements);
    return new_config;
  }
  /**
   * Performs the filter on the values of a dictionary
   *
   * :param source: The dictionary to filter
   * :param replacements: A dictionary of string keys to their replacements
   * :return: A new dictionary whose value are (maybe) replaced per the
   * replacements dictionary
   */
  filter_one_dict(source, replacements) {
    let new_dict = deepcopy(source);
    for (const [key, value] of Object.entries(source)) {
      let replacement_value = null;
      if (is_dict(value)) {
        replacement_value = this.filter_one_dict(value, replacements);
      } else if (isinstance2(value, Array)) {
        replacement_value = this.filter_one_list(value, replacements);
      } else {
        replacement_value = this.make_replacements(value, replacements);
      }
      if (replacement_value != null) {
        new_dict[key] = replacement_value;
      }
    }
    return new_dict;
  }
  /**
   * Performs the filter on the elements of a list
   *
   * :param source: The list to filter
   * :param replacements: A dictionary of string keys to their replacements
   * :return: A new List whose components are (maybe) replaced per the
   * replacements dictionary
   */
  filter_one_list(source, replacements) {
    let new_list = [];
    for (const component of iter2(source)) {
      let replacement_value = component;
      if (is_dict(component)) {
        replacement_value = this.filter_one_dict(component, replacements);
      } else if (isinstance2(component, Array)) {
        replacement_value = this.filter_one_list(component, replacements);
      } else {
        replacement_value = this.make_replacements(component, replacements);
      }
      new_list.push(replacement_value);
    }
    return new_list;
  }
  /**
   * Make replacements per the keys and values in the replacements dictionary
   *
   * :param source_value: The value to potentially do replacements on
   * :param replacements: A dictionary of string keys to their replacements
   * :return: A potentially new value if some key in the replacements dictionary
   * is found to trigger a replacement, otherwise, the same source_value
   * that came in.
   */
  make_replacements(source_value, replacements) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AbstractCommonDefsConfigFilter);
class DictionaryCommonDefsConfigFilter extends AbstractCommonDefsConfigFilter {
  /**
   * Constructor
   *
   * :param replacements: An initial replacements dictionary to start out with
   * whose (copied) contents will be updated with commondefs definitions
   * in the basis_config during the filter_config() entry point.
   * Default is null, indicating everything needed comes from the config.
   */
  constructor(replacements) {
    super("replacement_values", replacements);
  }
  /**
   * Make replacements per the keys and values in the replacements dictionary
   *
   * :param source_value: The value to potentially do replacements on
   * :param replacements: A dictionary of string keys to their replacements
   * :return: A potentially new value if some key in the replacements dictionary
   * is found to trigger a replacement, otherwise, the same source_value
   * that came in.
   */
  make_replacements(source_value, replacements) {
    if (!isinstance2(source_value, String)) {
      return source_value;
    }
    let replacement_value = dict.get(replacements, source_value);
    if (replacement_value == null) {
      return source_value;
    }
    let replacement_value_copy = deepcopy(replacement_value);
    return replacement_value_copy;
  }
}
exposeClassAttributes(DictionaryCommonDefsConfigFilter);
`
See class comment for details
`;
class NameCorrectionConfigFilter extends ConfigFilter {
  /**
   * Filters the given basis config.
   *
   * Ideally this would be a Pure Function in that it would not
   * modify the caller's arguments so that the caller has a chance
   * to decide whether to take any changes returned.
   *
   * :param basis_config: The config dictionary to act as the basis
   * for filtering
   * :return: A config dictionary, potentially modified as per the
   * policy encapsulated by the implementation
   */
  filter_config(basis_config) {
    if (basis_config == null) {
      return basis_config;
    }
    let tools = dict.get(basis_config, "tools");
    if (tools == null || len(tools) == 0) {
      return basis_config;
    }
    let corrections = {};
    let errors = [];
    let tool = null;
    for (const tool2 of iter2(tools)) {
      let use_tool = tool2;
      let name = dict.get(use_tool, "name");
      let new_name = this.validate_name(name);
      if (new_name.startsWith("Error: ")) {
        errors.push(new_name);
      } else if (new_name != name) {
        use_tool["name"] = new_name;
        corrections[name] = new_name;
      }
    }
    for (const tool2 of iter2(tools)) {
      let use_tool = tool2;
      let agent_tools = [];
      agent_tools = dict.get(use_tool, "tools", agent_tools);
      if (isinstance2(agent_tools, Array) && len(agent_tools) > 0) {
        let new_agent_tools = [];
        for (const agent_tool of iter2(agent_tools)) {
          if (isinstance2(agent_tool, String)) {
            new_agent_tools.push(dict.get(corrections, agent_tool, agent_tool));
          } else {
            new_agent_tools.push(agent_tool);
          }
        }
        tool2["tools"] = new_agent_tools;
      }
      NameCorrectionConfigFilter.correct_args_tools(use_tool, corrections);
    }
    let logger = getLogger(this.constructor.name);
    for (const error of iter2(errors)) {
      logger.error(error);
    }
    for (const [original, correction] of Object.entries(corrections)) {
      logger.info("Correcting %s to %s", String(original), String(correction));
    }
    return basis_config;
  }
  /**
   * Rewrites, in place, the agent-name references a tool holds in its args.tools
   * using the given corrections table.
   *
   * args.tools is accepted in the same two shapes ToolsShapeValidator.validate_args_tools
   * and AbstractNetworkValidator.coerce_args_tools understand: a list of agent-name
   * strings, or a dict of label -> agent-name string. Only string entries (list elements,
   * dict values) are rewritten. Dict keys, non-string entries and any other shape are left
   * untouched, since ToolsShapeValidator is the place that reports malformed shapes.
   * Neither "args" nor "args.tools" is created where absent.
   *
   * :param tool: The agent/tool spec dictionary whose args.tools is corrected in place
   * :param corrections: A dictionary of original agent name -> corrected agent name
   */
  static correct_args_tools(tool, corrections) {
    let args = dict.get(tool, "args");
    if (!is_dict(args)) {
      return;
    }
    let args_dict = args;
    if (!contains("tools", Object.keys(args_dict))) {
      return;
    }
    let args_tools = dict.get(args_dict, "tools");
    if (isinstance2(args_tools, Array)) {
      let args_tools_list = args_tools;
      let index = 0;
      let agent_tool = null;
      for (const [index2, agent_tool2] of enumerate2(args_tools_list)) {
        if (isinstance2(agent_tool2, String)) {
          let agent_tool_string = agent_tool2;
          args_tools_list[index2] = dict.get(corrections, agent_tool_string, agent_tool_string);
        }
      }
    } else if (is_dict(args_tools)) {
      let args_tools_dict = args_tools;
      let label = null;
      let agent_tool = null;
      for (const [label2, agent_tool2] of Object.entries(args_tools_dict)) {
        if (isinstance2(agent_tool2, String)) {
          let agent_tool_string = agent_tool2;
          args_tools_dict[label2] = dict.get(corrections, agent_tool_string, agent_tool_string);
        }
      }
    }
  }
  /**
   * :param name: The name of an agent/tool as given in the hocon file.
   * :return: If the name itself is valid, simply return the input.
   * If the given name is invalid, attempt to correct it and return
   * a new string.  If it is not correctable, return a string that starts
   * with "Error: " that describes the problem..
   */
  validate_name(name) {
    if (name == null) {
      return "Error: no name for agent/tool";
    }
    if (!isinstance2(name, String)) {
      return `Error: agent/tool name must be a string ${name}`;
    }
    if (len(name) == 0) {
      return "Error: agent/tool name cannot be empty";
    }
    let new_name = name;
    if (contains("/", new_name)) {
      new_name = string2.replace(new_name, "/", "_");
    }
    return new_name;
  }
}
exposeClassAttributes(NameCorrectionConfigFilter);
class StringCommonDefsConfigFilter extends AbstractCommonDefsConfigFilter {
  /**
   * Constructor
   *
   * :param replacements: An initial replacements dictionary to start out with
   * whose (copied) contents will be updated with commondefs definitions
   * in the basis_config during the filter_config() entry point.
   * Default is null, indicating everything needed comes from the config.
   */
  constructor(replacements) {
    super("replacement_strings", replacements);
  }
  /**
   * Make replacements per the keys and values in the replacements dictionary
   *
   * :param source_value: The value to potentially do replacements on
   * :param replacements: A dictionary of string keys to their replacements
   * :return: A potentially new value if some key in the replacements dictionary
   * is found to trigger a replacement, otherwise, the same source_value
   * that came in.
   */
  make_replacements(source_value, replacements) {
    if (!isinstance2(source_value, String)) {
      return source_value;
    }
    let replacement_value = source_value;
    let search = null;
    let replace = null;
    for (const [search2, replace2] of Object.entries(replacements)) {
      if (replace2 == null) {
        continue;
      }
      if (!isinstance2(replace2, String) || !isinstance2(search2, String)) {
        continue;
      }
      let replace_string = replace2;
      if (len(replace_string) == 0) {
        continue;
      }
      if (!contains(search2, replacement_value)) {
        continue;
      }
      replacement_value = string2.replace(replacement_value, `{${search2}}`, replace_string);
    }
    return replacement_value;
  }
}
exposeClassAttributes(StringCommonDefsConfigFilter);
class NetworkConfigFilterChain extends ConfigFilter {
  /**
   * :param basis_config: Raw agent network config dictionary
   * :return: A fully resolved config dictionary
   */
  filter_config(basis_config) {
    let filter_chain = new ConfigFilterChain();
    filter_chain.register(new DictionaryCommonDefsConfigFilter());
    filter_chain.register(new StringCommonDefsConfigFilter());
    filter_chain.register(new DefaultsConfigFilter());
    filter_chain.register(new NameCorrectionConfigFilter());
    let config = filter_chain.filter_config(basis_config);
    return config;
  }
}
exposeClassAttributes(NetworkConfigFilterChain);
class ResolvedNetworkConfigFilter extends ConfigFilter {
  /**
   * Constructor
   */
  constructor() {
    super();
    this.filter_chain = new NetworkConfigFilterChain();
  }
  /**
   * Resolves the given agent network spec.
   *
   * :param basis_config: The agent network spec dictionary as deployed.
   * Never modified.
   * :return: A new, fully resolved spec dictionary with the "commondefs"
   * block removed.  null if basis_config is null.
   */
  filter_config(basis_config) {
    if (basis_config == null) {
      return null;
    }
    let resolved = this.filter_chain.filter_config(basis_config);
    if (resolved === basis_config) {
      resolved = deepcopy(basis_config);
    }
    if (!is_dict(resolved)) {
      return resolved;
    }
    let resolved_dict = resolved;
    if (contains("commondefs", Object.keys(resolved_dict))) {
      delete resolved_dict["commondefs"];
    }
    return resolved_dict;
  }
}
exposeClassAttributes(ResolvedNetworkConfigFilter);
class AbstractCallableActivation extends CallableActivation {
  /**
   * Constructor
   *
   * :param factory: The factory for Agent Tools.
   * :param agent_tool_spec: The dictionary describing the JSON agent tool
   * to be used by the instance
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   */
  constructor(factory, agent_tool_spec, sly_data) {
    super();
    this.factory = factory;
    this.agent_tool_spec = agent_tool_spec;
    this.sly_data = sly_data;
    this.run_context = null;
  }
  /**
   * :return: the dictionary describing the data-driven agent
   */
  get_agent_tool_spec() {
    return this.agent_tool_spec;
  }
  /**
   * :return: the name of the data-driven agent as it comes from the spec
   */
  get_name() {
    let agent_spec = this.get_agent_tool_spec();
    let agent_name = this.factory.get_name_from_spec(agent_spec);
    return agent_name;
  }
  /**
   * :return: The factory containing all the tool specs
   */
  get_inspector() {
    return this.factory;
  }
  /**
   * :return: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   */
  get_sly_data() {
    return this.sly_data;
  }
  /**
   * :return: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  get_origin() {
    return this.run_context.get_origin();
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any. Expected to be the
   * RunContext which contains the scope of operation of this CallableActivation
   */
  async close_of_work(parent_resource) {
    if (this.run_context != null) {
      await this.run_context.close_of_work(parent_resource);
      this.run_context = null;
    }
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AbstractCallableActivation);
class CallingActivation extends AbstractCallableActivation {
  /**
   * Constructor
   *
   * :param parent_run_context: The parent RunContext (if any) to pass
   * down its resources to a new RunContext created by
   * this call.
   * :param factory: The factory for Agent Tools.
   * :param agent_tool_spec: The dictionary describing the JSON agent tool
   * to be used by the instance
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   */
  constructor(parent_run_context, factory, agent_tool_spec, sly_data) {
    super(factory, agent_tool_spec, sly_data);
    let agent_network_config = this.factory.get_config();
    let spec_llm_config = dict.get(this.agent_tool_spec, "llm_config");
    let run_context_config = CallingActivation.prepare_run_context_config(agent_network_config, this.agent_tool_spec, spec_llm_config);
    this.run_context = RunContextFactory.create_run_context(parent_run_context, this, null, null, run_context_config);
    this.journal = this.run_context.get_journal();
  }
  /**
   * Get the llm config as a combination of defaults from different places in the config
   *
   * :param agent_network_config: The entirety of the agent network's config
   * :param agent_tool_spec: The agent tool spec
   * :param spec_llm_config: The llm config for the agent spec
   * :return: A merged llm config to use for a RunContext
   */
  static prepare_run_context_config(agent_network_config, agent_tool_spec, spec_llm_config) {
    let empty = {};
    if (spec_llm_config == null) {
      spec_llm_config = empty;
    }
    let overlayer = new DictionaryOverlay();
    let llm_config = dict.get(agent_network_config, "llm_config", empty);
    let use_llm_config = overlayer.overlay(llm_config, spec_llm_config);
    let middleware_config = dict.get(agent_tool_spec, "middleware");
    let run_context_config = { "context_type": dict.get(agent_network_config, "context_type"), "llm_config": use_llm_config, "middleware_config": middleware_config };
    return run_context_config;
  }
  /**
   * :return: The string prompt for framing the problem in terms of purpose.
   */
  get_instructions() {
    let instructions = dict.get(this.agent_tool_spec, "instructions");
    if (instructions == null) {
      let agent_name = this.get_name();
      let message = `
The agent named "${agent_name}" has no instructions specified for it.

Every agent must have instructions providing the natural-language
context with which it will proces input, essentially telling it what to do.
`;
      throw new Error(message);
    }
    return instructions;
  }
  /**
   * Creates resources that will be used throughout the lifetime of the component.
   * :param component_name: Optional string for labelling the component.
   * Defaults to the agent name if not set.
   * :param instructions: Optional string for setting more fine-grained instructions.
   * Defaults to agent instructions if not set.
   * :param assignments: Optional string for assigning agent functional arguments.
   * Defaults to an empty string if not set.
   */
  async create_resources(component_name, instructions, assignments) {
    let name = component_name;
    if (name == null) {
      name = this.get_name();
    }
    let use_instructions = instructions;
    if (instructions == null) {
      use_instructions = this.get_instructions();
    }
    let tool_names = CallingActivation.get_callable_tool_names(this.agent_tool_spec);
    await this.run_context.create_resources(name, use_instructions, assignments, { tool_names });
  }
  /**
   * :return: The names of the callable tools this instance will call
   * Can return null if the instance will not call any tools.
   */
  static get_callable_tool_names(agent_tool_spec) {
    let tool_list = dict.get(agent_tool_spec, "tools");
    if (tool_list == null || len(tool_list) == 0) {
      return null;
    }
    return tool_list;
  }
  /**
   * :return: A dictionary of name -> name, where the keys are what the tool has been
   * called in the framework (e.g. langchain) and the value is what the tool
   * has been called in the agent_spec itself.  This is often a reflexive
   * mapping, except in the case of external tools where a safer name is
   * needed for internal framework reference.
   */
  get_callable_tool_dict() {
    let tool_dict = {};
    let tool_list = CallingActivation.get_callable_tool_names(this.agent_tool_spec);
    if (tool_list == null) {
      return tool_dict;
    }
    for (const tool of iter2(tool_list)) {
      let safe_name = ExternalAgentParsing.get_safe_agent_name(tool);
      tool_dict[safe_name] = tool;
    }
    return tool_dict;
  }
  /**
   * Calls all of the callable_components' functions
   *
   * :param component_run: The Run which the component is operating under
   * :return: A potentially updated Run for the component
   */
  async make_tool_function_calls(component_run) {
    let component_tool_calls = component_run.get_tool_calls();
    let tool_outputs = [];
    for (const component_tool_call of iter2(component_tool_calls)) {
      let tool_output = await this.make_one_tool_function_call(component_tool_call);
      tool_outputs.push(tool_output);
    }
    let new_component_run = await this.run_context.submit_tool_outputs(component_run, tool_outputs);
    return new_component_run;
  }
  /**
   * Calls a single callable_component's function
   *
   * :param component_tool_call: A ToolCall instance to get the function
   * arguments from
   * :return: A dictionary with keys:
   * "tool_call_id" a string id representing the call to the tool itself
   * "output" a JSON string representing the output of the tool's function
   */
  async make_one_tool_function_call(component_tool_call) {
    let tool_name = component_tool_call.get_function_name();
    let tool_arguments = component_tool_call.get_function_arguments();
    let invocation = component_tool_call.get_invocation();
    let callable_tool_dict = this.get_callable_tool_dict();
    let use_tool_name = dict.get(callable_tool_dict, tool_name);
    if (use_tool_name == null) {
      throw new Error(`${tool_name} is not in tools ${list3(Object.keys(callable_tool_dict))}`);
    }
    let our_agent_spec = this.get_agent_tool_spec();
    let callable_component = this.factory.create_agent_activation(this.run_context, our_agent_spec, use_tool_name, this.sly_data, tool_arguments, null, { invocation });
    try {
      let message = await callable_component.build();
      let tool_output = { "origin": callable_component.get_origin(), "tool_call_id": component_tool_call.get_id(), "output": message, "sly_data": callable_component.sly_data };
      return tool_output;
    } finally {
      const _resource = suppress(Error);
      try {
        await callable_component.close_of_work(this.run_context);
      } finally {
        _resource.close?.();
      }
    }
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(CallingActivation);
class FrontManActivation extends CallingActivation {
  /**
   * Creates resources that will be used throughout the lifetime of the component.
   */
  async create_any_resources() {
    await this.create_resources();
  }
  /**
   * Entry-point method for callers of the root of the Activation tree.
   *
   * :param user_input: An input string from the user.
   * :return: A list of response messages for the run
   */
  async submit_message(user_input) {
    let messages = [];
    let current_run = await this.run_context.submit_message(user_input);
    let terminate = false;
    while (!terminate) {
      if (this.run_context == null) {
        break;
      }
      current_run = await this.run_context.wait_on_run(current_run, this.journal);
      if (current_run.requires_action()) {
        current_run = await this.make_tool_function_calls(current_run);
      } else {
        if (this.run_context == null) {
          break;
        }
        messages = await this.run_context.get_response();
        terminate = true;
      }
    }
    return messages;
  }
  /**
   * Update internal state based on the InvocationContext instance passed in.
   * :param invocation_context: The context policy container that pertains to the invocation
   */
  update_invocation_context(invocation_context) {
    this.journal = invocation_context.get_journal();
    if (this.run_context != null) {
      this.run_context.update_invocation_context(invocation_context);
    }
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(FrontManActivation);
class ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    throw Error("Method not implemented");
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    throw Error("Method not implemented");
  }
  /**
   * Merges the args specified by the llm with "hard-coded" args specified in the agent spec.
   * Hard-coded args win over llm-specified args if both are defined.
   * If you want the llm args to win out over the hard-coded args, use a default for
   * the function spec instead of the hard-coded args.
   *
   * :param llm_args: argument dictionary that the LLM wants
   * :param agent_tool_spec: The dictionary representing the spec registered agent
   */
  merge_args(llm_args, agent_tool_spec) {
    let config_args = dict.get(agent_tool_spec, "args");
    if (config_args == null) {
      return llm_args;
    }
    let overlay = new DictionaryOverlay();
    let merged_args = overlay.overlay(llm_args, config_args);
    return merged_args;
  }
}
exposeClassAttributes(ActivationPrepper);
class ExternalMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param journal: The OriginatingJournal through which messages from
   * the external agent are passed.
   */
  constructor(journal) {
    super();
    this.journal = journal;
  }
  /**
   * Process the message asynchronously.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  async async_process_message(chat_message_dict, message_type) {
    let message_origin = dict.get(chat_message_dict, "origin");
    if (message_origin == null) {
      return;
    }
    let origin = copy(this.journal.get_origin());
    origin.push(...message_origin);
    let converter = new BaseMessageDictionaryConverter(null, false);
    let message = converter.from_dict(chat_message_dict);
    await this.journal.write_message(message, { origin });
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ExternalMessageProcessor);
class ExternalActivation extends AbstractCallableActivation {
  /**
   * Constructor
   *
   * :param parent_run_context: The parent RunContext (if any) to pass
   * down its resources to a new RunContext created by
   * this call.
   * :param factory: The factory for Agent Tools.
   * :param agent_url: The string url to find the external agent.
   * Theoretically this has already been verified by use of an
   * ExternalAgentParsing method.
   * :param args: A dictionary of the tool function arguments passed in
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   * This gets passed along as a distinct argument to the referenced python class's
   * invoke() method.
   * :param allow_from_downstream: A dictionary describing how to handle information
   * coming in from the downstream external agent
   * :param invocation: The style of the invocation
   */
  constructor(parent_run_context, factory, agent_url, args, sly_data, allow_from_downstream, invocation) {
    super(factory, null, sly_data);
    this.agent_url = agent_url;
    this.run_context = RunContextFactory.create_run_context(parent_run_context, this);
    this.journal = this.run_context.get_journal();
    this.arguments = args;
    this.allow_from_downstream = allow_from_downstream;
    this.session = null;
    this.chat_context = null;
    this.processor = new BasicMessageProcessor();
    this.invocation = invocation;
    let extractor = new DictionaryExtractor(this.allow_from_downstream, ".");
    let raw_reporting = false;
    for (const key of ["reporting", "messages"]) {
      raw_reporting = extractor.get(key, raw_reporting);
    }
    this.report = ExternalActivation.bool_from_multi_value(raw_reporting, this.agent_url);
    if (this.report) {
      this.processor.add_processor(new ExternalMessageProcessor(this.journal));
    }
  }
  /**
   * :param source: The source against which we will check the value.
   * Can be boolean, string, list, or dictionary.
   * :param value: The string value to check for
   * :return: True if the value is considered to be "true" in the source.
   * False otherwise
   */
  static bool_from_multi_value(source, value) {
    let bool_value = false;
    if (isinstance2(source, Boolean)) {
      bool_value = Boolean(source);
    } else if (isinstance2(source, String)) {
      bool_value = value == source;
    } else if (isinstance2(source, Array)) {
      bool_value = contains(value, source);
    } else if (is_dict(source)) {
      bool_value = Boolean(dict.get(source, value));
    }
    return bool_value;
  }
  /**
   * :return: the name of the data-driven agent as it comes from the spec
   */
  get_name() {
    return this.agent_url;
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    let arguments_dict = { "tool_start": true, "tool_args": this.arguments };
    let message = new AgentMessage("Received arguments:", arguments_dict, null);
    await this.journal.write_message(message, null);
    if (this.session == null) {
      let invocation_context = this.run_context.get_invocation_context();
      let factory = invocation_context.get_async_session_factory();
      this.session = factory.create_session(this.agent_url, invocation_context, this.invocation);
    }
    let chat_request = this.gather_input(`\`\`\`json
${dumps(this.arguments)}\`\`\``, this.sly_data);
    let full_name = Origination.get_full_name_from_origin(this.run_context.get_origin());
    let logger = getLogger(full_name);
    let chat_responses = null;
    let error_str = null;
    let retries_remaining = 2;
    while (chat_responses == null && retries_remaining > 0) {
      try {
        chat_responses = this.session.streaming_chat(chat_request);
      } catch (e) {
        if (e instanceof Error) {
          retries_remaining -= 1;
          if (retries_remaining == 0) {
            error_str = `Agent/tool ${this.agent_url} was unreachable due to ClientPayloadError. Cannot rely on results from it as a tool.`;
          } else {
            logger.warning("Agent/tool %s was unreachable due to ClientPayloadError. Retrying.", this.agent_url);
          }
        } else if (e instanceof Error) {
          error_str = `Agent/tool ${this.agent_url} was unreachable. Cannot rely on results from it as a tool.`;
        }
      }
      if (error_str != null) {
        logger.info(error_str);
        let ai_message2 = new AIMessage({ content: error_str });
        return ai_message2;
      }
    }
    let empty = {};
    try {
      for await (const chat_response of chat_responses) {
        let response = dict.get(chat_response, "response", empty);
        await this.processor.async_process_message(response);
      }
    } finally {
      if (chat_responses != null) {
        const _resource = suppress(Error);
        try {
          await chat_responses.return?.().catch?.(() => {
          });
        } finally {
          _resource.close?.();
        }
      }
    }
    let answer = this.processor.get_compiled_answer();
    this.chat_context = this.processor.get_chat_context();
    let returned_sly_data = this.processor.get_sly_data();
    let redactor = new SlyDataRedactor(this.allow_from_downstream, ["sly_data"], true);
    this.sly_data = redactor.filter_config(returned_sly_data);
    let answer_dict = { "tool_end": true, "tool_output": answer };
    let agent_message = new AgentMessage("Got result:", answer_dict, null);
    await this.journal.write_message(agent_message, null);
    if (answer == null) {
      answer = "";
    }
    let ai_message = new AIMessage({ content: answer });
    return ai_message;
  }
  /**
   * Send input to the external agent
   * :param agent_input: A single string to send as input to the agent
   * :param sly_data: unknown private sly_data to accompany the input.
   * sly_data is intended not to be inserted into the chat stream.
   * :return: The ChatRequest dictionary
   */
  gather_input(agent_input, sly_data) {
    let chat_request = { "user_message": { "type": ChatMessageType.HUMAN, "text": agent_input } };
    if (Boolean(this.chat_context)) {
      chat_request["chat_context"] = this.chat_context;
    }
    if (sly_data != null && len(Object.keys(sly_data)) > 0) {
      chat_request["sly_data"] = sly_data;
    }
    if (this.report) {
      chat_request["chat_filter"] = { "chat_filter_type": "MAXIMAL" };
    }
    return chat_request;
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any. Expected to be the
   * RunContext which contains the scope of operation of this CallableActivation
   */
  async close_of_work(parent_resource) {
    await super.close_of_work(parent_resource);
    this.session = null;
  }
}
exposeClassAttributes(ExternalActivation);
class ExternalActivationPrepper extends ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    let applicable = agent_tool_spec == null;
    return applicable;
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    if (!ExternalAgentParsing.is_external_agent(name)) {
      throw new Error(`No agent_tool_spec for ${name}`);
    }
    let redacted_sly_data = this._redact_sly_data(parent_run_context, sly_data);
    let extractor = new DictionaryExtractor(parent_agent_spec, ".");
    let empty = {};
    let allow_from_downstream = extractor.get("allow.from_downstream", empty);
    let agent_activation = new ExternalActivation(parent_run_context, factory, name, args, redacted_sly_data, allow_from_downstream, invocation);
    return agent_activation;
  }
  /**
   * Redact the sly_data based on the agent spec associated with the parent run context
   *
   * :param parent_run_context: The parent run context of the tool to be created.
   * :param sly_data: The internal representation of the sly_data to be redacted
   * :return: A new sly_data dictionary, redacted as per the parent spec
   */
  _redact_sly_data(parent_run_context, sly_data) {
    let parent_spec = null;
    if (parent_run_context != null) {
      parent_spec = parent_run_context.get_agent_tool_spec();
    }
    let redactor = new SlyDataRedactor(parent_spec, ["allow.sly_data", "allow.to_downstream.sly_data"], true);
    let redacted = redactor.filter_config(sly_data);
    return redacted;
  }
}
exposeClassAttributes(ExternalActivationPrepper);
class ArgumentAssigner {
  /**
   * Constructor
   *
   * :param properties: The dictionary of function properties to fulfill,
   * as described in the callee agent spec.
   */
  constructor(properties) {
    this.properties = properties;
  }
  /**
   * :param args: The arguments dictionary with the values as determined
   * by the calling agent.
   * :return: A List of text that describes the values of each argument,
   * suitable for transmitting to the chat stream of another agent.
   */
  assign(args) {
    let assignments = [];
    for (const [args_name, args_value] of Object.entries(args)) {
      if (args_value == null) {
        continue;
      }
      let args_value_type = null;
      if (this.properties) {
        let atttribute = dict.get(this.properties, args_name);
        if (!atttribute) {
          continue;
        }
        args_value_type = dict.get(atttribute, "type");
      }
      let args_value_str = this.get_args_value_as_string(args_value, args_value_type);
      let assignment_verb = "is";
      if (args_value_type == "array" || isinstance2(args_value, Array)) {
        assignment_verb = "are";
      }
      let assignment = `The ${args_name} ${assignment_verb} ${args_value_str}.`;
      assignments.push(assignment);
    }
    return assignments;
  }
  /**
   * Get the string value of the value provided in the arguments
   */
  get_args_value_as_string(args_value, value_type) {
    let args_value_str = null;
    if (value_type == "dict" || is_dict(args_value)) {
      args_value_str = dumps(args_value);
      args_value_str = slice2(args_value_str, 1, -1);
    } else if (value_type == "array" || isinstance2(args_value, Array)) {
      let str_values = [];
      for (const item of iter2(args_value)) {
        let item_str = this.get_args_value_as_string(item);
        str_values.push(item_str);
      }
      args_value_str = str_values.join(", ");
    } else if (value_type == "string") {
      args_value_str = `'${args_value}'`;
      args_value_str = string2.replace(args_value_str, "{", "{{");
      args_value_str = string2.replace(args_value_str, "}", "}}");
    } else {
      args_value_str = String(args_value);
    }
    return args_value_str;
  }
}
exposeClassAttributes(ArgumentAssigner);
class BranchActivation extends CallingActivation {
  /**
   * Constructor
   *
   * :param parent_run_context: The parent RunContext (if any) to pass
   * down its resources to a new RunContext created by
   * this call.
   * :param factory: The AgentToolFactory used to create tools
   * :param args: A dictionary of the tool function arguments passed in
   * :param agent_tool_spec: The dictionary describing the JSON agent tool
   * to be used by the instance
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   */
  constructor(parent_run_context, factory, args, agent_tool_spec, sly_data) {
    super(parent_run_context, factory, agent_tool_spec, sly_data);
    this.arguments = args;
  }
  /**
   * :return: The string prompt for assigning values to the arguments to the agent.
   */
  get_assignments() {
    let extractor = new FieldExtractor();
    let empty = {};
    let agent_spec = this.get_agent_tool_spec();
    let properties = extractor.get_field(agent_spec, "function.parameters.properties", empty);
    let assigner = new ArgumentAssigner(properties);
    let assignments = assigner.assign(this.arguments);
    let assignments_str = assignments.join("\n");
    return assignments_str;
  }
  /**
   * :return: A string describing the objective of the component.
   */
  get_command() {
    let agent_spec = this.get_agent_tool_spec();
    return dict.get(agent_spec, "command");
  }
  /**
   * :param run: The Run for the prescriptor (if any)
   * :param messages: A current list of messages for the component.
   * :return: An updated list of messages after this operation is done.
   * This default implementation is just a pass-through of the messages argument.
   */
  async integrate_callable_response(run, messages) {
    let new_messages = messages;
    let callable_tool_names = BranchActivation.get_callable_tool_names(this.agent_tool_spec);
    if (callable_tool_names == null) {
      return new_messages;
    }
    while (run.requires_action()) {
      run = await this.make_tool_function_calls(run);
      run = await this.run_context.wait_on_run(run, this.journal);
      new_messages = await this.run_context.get_response();
    }
    return new_messages;
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    let assignments = this.get_assignments();
    let instructions = this.get_instructions();
    let uuid_str = String(uuid4());
    let component_name = this.get_name();
    let unique_name = `${uuid_str}_${component_name}`;
    await this.create_resources(unique_name, instructions, null);
    let command = this.get_command();
    if (command) {
      assignments = assignments + "\n" + command;
    }
    let run = await this.run_context.submit_message(assignments);
    let use_run = await this.run_context.wait_on_run(run, this.journal);
    let messages = await this.run_context.get_response();
    let use_messages = await this.integrate_callable_response(use_run, messages);
    return at2(use_messages, -1);
  }
  /**
   * :return: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   */
  get_origin() {
    return this.run_context.get_origin();
  }
  /**
   * Experimental method to call a tool more directly from a subclass.
   *
   * NOTE: This method is not correctly reporting history or anything like that just yet.
   *
   * :param tool_name: The name of the tool to invoke
   * :param tool_args: A dictionary of arguments to send to the tool.
   * :param sly_data: private data dictionary to send to the tool.
   * :return: A string representing the last received content text of the last message.
   */
  async use_tool(tool_name, tool_args, sly_data) {
    let our_agent_spec = this.get_agent_tool_spec();
    let callable_activation = this.factory.create_agent_activation(this.run_context, our_agent_spec, tool_name, sly_data, tool_args);
    let message = null;
    try {
      message = await callable_activation.build();
    } catch (exception) {
      let invocation_context = this.run_context.get_invocation_context();
      let async_factory = invocation_context.get_async_session_factory();
      if (!async_factory.is_use_direct() && tool_name.startsWith("/")) {
        throw new Error(`
Attempt to call ${tool_name} as an external agent network over http failed.
If you are getting this from the agent_cli command line, consider adding the --local_externals_direct
flag to your invocation.
`);
      }
      throw exception;
    } finally {
      await callable_activation.close_of_work(this.run_context);
    }
    return ContentUtils.flatten_to_text(message);
  }
  /**
   * Experimental method to call a reserved temporary network more directly from a subclass.
   *
   * NOTE: This method is not correctly reporting history or anything like that just yet.
   *
   * :param reservation_id: The string id of the reservation to invoke
   * :param args: A dictionary of arguments to send to the reserved temporary network.
   * :param sly_data: private data dictionary to send to the reserved temporary network.
   * :return: A string representing the last received content text of the last message.
   */
  async use_reservation(reservation_id, args, sly_data) {
    let result = await this.use_tool(`/${reservation_id}`, args, sly_data);
    return result;
  }
}
exposeClassAttributes(BranchActivation);
class AbstractClassActivation extends AbstractCallableActivation {
  static {
    this._unrestricted_notice_logged = false;
  }
  /**
   * Constructor
   *
   * :param parent_run_context: The parent RunContext (if any) to pass
   * down its resources to a new RunContext created by
   * this call.
   * :param factory: The AgentToolFactory used to create tools
   * :param args: A dictionary of the tool function arguments passed in by the LLM
   * :param agent_tool_spec: The dictionary describing the JSON agent tool
   * to be used by the instance
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   * This gets passed along as a distinct argument to the referenced python class's
   * invoke() method.
   */
  constructor(parent_run_context, factory, args, agent_tool_spec, sly_data) {
    super(factory, agent_tool_spec, sly_data);
    this.run_context = RunContextFactory.create_run_context(parent_run_context, this);
    this.journal = this.run_context.get_journal();
    this.full_name = Origination.get_full_name_from_origin(this.run_context.get_origin());
    this.logger = getLogger(this.full_name);
    this.reservationist = null;
    let spec_extractor = new DictionaryExtractor(this.agent_tool_spec, ".");
    if (spec_extractor.get("allow.reservations")) {
      let invocation_context = this.run_context.get_invocation_context();
      let real_reservationist = invocation_context.get_reservationist();
      if (real_reservationist != null) {
        this.reservationist = new AccumulatingAgentReservationist(real_reservationist, this.full_name);
      }
    }
    this.arguments = {};
    if (args != null) {
      this.arguments = args;
    }
    if (dict.get(this.arguments, "origin") == null) {
      this.arguments["origin"] = deepcopy(this.run_context.get_origin());
    }
    if (dict.get(this.arguments, "origin_str") == null) {
      this.arguments["origin_str"] = this.full_name;
    }
    if (dict.get(this.arguments, "progress_reporter") == null) {
      this.arguments["progress_reporter"] = new ProgressJournal(this.journal);
    }
    if (dict.get(this.arguments, "reservationist") == null && this.reservationist) {
      this.arguments["reservationist"] = this.reservationist;
    }
  }
  /**
   * Returns the full class reference path of the target tool to be invoked.
   *
   * This method must be implemented by subclasses to provide the fully qualified
   * class name (e.g., "my_module.MyToolClass") of the CodedTool that should
   * be instantiated and invoked. This string will be used for dynamic instantiation
   * of the tool class.
   *
   * :return: A dot-separated string representing the full class path.
   */
  get_full_class_ref() {
    throw Error("Method not implemented");
  }
  /**
   * Main entry point to the class.
   *
   * :return: A BaseMessage produced during this process.
   */
  async build() {
    let full_class_ref = this.get_full_class_ref();
    this.logger.info("Calling class %s", full_class_ref);
    let class_split = full_class_ref.split(".");
    let class_name = at2(class_split, -1);
    let module_name = slice2(full_class_ref, void 0, -len(class_name));
    while (module_name.endsWith(".")) {
      module_name = slice2(module_name, void 0, -1);
    }
    let start = perfCounter();
    let python_class = this.resolve_class(class_name, module_name);
    let coded_tool = this.instantiate_coded_tool(python_class);
    let retval = null;
    if (isinstance2(coded_tool, CodedTool)) {
      retval = await this.attempt_invoke(coded_tool, this.arguments, this.sly_data);
    } else {
      retval = `Error: ${full_class_ref} is not a CodedTool`;
    }
    let stop = perfCounter();
    let duration = stop - start;
    let threshold_str = dict.get(process.env, "AGENT_TOOL_EXECUTION_LOG_THRESHOLD_SECONDS", "0");
    let threshold = 0;
    try {
      threshold = Number(threshold_str);
    } catch (e) {
    }
    if (duration > threshold && threshold > 0) {
      this.logger.info("Execution of %s took %f seconds", full_class_ref, duration);
    }
    let retval_str = `${retval}`;
    let message = new AIMessage({ content: retval_str });
    return message;
  }
  /**
   * Resolve the class by trying progressively higher levels in the agent network hierarchy.
   *
   * :param class_name: The name of the class to resolve
   * :param module_name: The module name containing the class
   * :return: The resolved Python class
   */
  resolve_class(class_name, module_name) {
    let this_agent_tool_path = this.factory.get_agent_tool_path();
    let agent_network_name = this.factory.agent_network.get_network_name();
    let agent_network_name_parts = agent_network_name.split("/");
    let this_agent_tool_path_parts = this_agent_tool_path.split(".");
    let python_class = null;
    let last_exception = null;
    this.logger.debug("Attempting to resolve class `%s` in module `%s`", class_name, module_name);
    try {
      python_class = this._attempt_resolve(class_name, module_name, this_agent_tool_path, this_agent_tool_path_parts, agent_network_name_parts);
    } catch (e) {
      last_exception = e;
    }
    if (python_class != null) {
      this.logger.debug("Successfully resolved class `%s` in module `%s`", class_name, module_name);
      return python_class;
    }
    let agent_name = this.factory.get_name_from_spec(this.agent_tool_spec);
    let agent_tool_path = slice2(this_agent_tool_path_parts, void 0, -len(agent_network_name_parts)).join(".");
    let strict_note = "";
    if (AbstractClassActivation.is_agent_tool_path_only()) {
      strict_note = `
Note: AGENT_TOOL_PATH_ONLY is enabled, so fully-qualified class references are
not resolved at all — even ones that point inside AGENT_TOOL_PATH. Reference the
export class as "<module>.<ClassName>" relative to AGENT_TOOL_PATH, not by its full
package path: resolution searches the agent network's own directory first and
then walks up to the shared AGENT_TOOL_PATH root, so the agent network name does
not belong in the reference.
`;
    }
    let message = `
Could not find class "${class_name}"
in module "${module_name}"
under AGENT_TOOL_PATH "${agent_tool_path}"
for the agent called "${agent_name}"
in the agent network "${agent_network_name}".

Check these things:
1.  Is there a typo in your AGENT_TOOL_PATH?
2.  Expected to find a specific CodedTool for the given agent network in:
    <AGENT_TOOL_PATH>/<agent_network>/<coded_tool_name>.py
    Global CodedTools (shared across networks) should be located at:
    <AGENT_TOOL_PATH>/<coded_tool_name>.py
    a)  Does your AGENT_TOOL_PATH point to the correct directory?
    b)  Does your CodedTool actually live in a module appropriately
        named for your agent network?
    c)  Does the module in the "class" designation for the agent ${agent_name}
        match what is in the filesystem?
    d)  Does the specified class name match what is actually implemented in the file?
    e)  If an agent network contains both specific and global CodedTools,
        the global module must not have the same name as the agent network.
3. Is AGENT_TOOL_PATH findable from what is set for your PYTHONPATH?
${strict_note}`;
    this.logger.error(message);
    throw new Error(message);
  }
  /**
   * Try to resolve the class through progressive resolution strategies.
   *
   * :param class_name: The name of the class to resolve
   * :param module_name: The module name containing the class
   * :param this_agent_tool_path: The root path from AGENT_TOOL_PATH plus the agent network name
   * :param this_agent_tool_path_parts: The agent tool path split into parts
   * :param agent_network_name_parts: The agent network name split into parts
   * :return: The resolved Python class
   */
  _attempt_resolve(class_name, module_name, this_agent_tool_path, this_agent_tool_path_parts, agent_network_name_parts) {
    if (!AbstractClassActivation.is_agent_tool_path_only()) {
      this._log_unrestricted_resolution_notice_once();
      let phase1_class = ResolverUtil.create_type(`${module_name}.${class_name}`, { raise_if_not_found: false });
      if (phase1_class != null) {
        return phase1_class;
      }
    }
    let python_class = null;
    let packages = [];
    let last_exception = null;
    for (const i of range2(len(agent_network_name_parts) + 1)) {
      if (i == 0) {
        packages = [this_agent_tool_path];
      } else {
        let path_parts = slice2(this_agent_tool_path_parts, void 0, -i);
        let current_path = path_parts.join(".");
        packages = [current_path];
      }
      let resolver = new Resolver(packages);
      try {
        python_class = resolver.resolve_class_in_module(class_name, module_name);
        if (python_class != null) {
          return python_class;
        }
      } catch (e) {
        last_exception = e;
      }
    }
    if (last_exception != null) {
      throw last_exception;
    }
    throw new Error(`Could not resolve class "${class_name}" in module "${module_name}".`);
  }
  /**
   * :return: True if the AGENT_TOOL_PATH_ONLY environment variable restricts
   * CodedTool class resolution to the AGENT_TOOL_PATH hierarchy only.
   * Defaults to False for backwards compatibility, where fully-qualified
   * references can resolve to any class on the server's PYTHONPATH.
   */
  static is_agent_tool_path_only() {
    return ConfigUtil.get_bool(process.env, "AGENT_TOOL_PATH_ONLY", { default: false });
  }
  /**
   * Logs a one-time notice that CodedTool class resolution is unrestricted.
   */
  _log_unrestricted_resolution_notice_once() {
    if (!AbstractClassActivation._unrestricted_notice_logged) {
      AbstractClassActivation._unrestricted_notice_logged = true;
      this.logger.info("AGENT_TOOL_PATH_ONLY is not enabled: CodedTool 'class' references can resolve via fully-qualified import from anywhere on the PYTHONPATH. Set AGENT_TOOL_PATH_ONLY=true to restrict resolution to the AGENT_TOOL_PATH hierarchy.");
    }
  }
  /**
   * Instantiate the CodedTool from the resolved class.
   *
   * :param python_class: The Python class to instantiate
   * :return: An instance of the CodedTool
   */
  instantiate_coded_tool(python_class) {
    let coded_tool = null;
    try {
      if (issubclass(python_class, BranchActivation)) {
        coded_tool = python_class(this.run_context, this.factory, this.arguments, this.agent_tool_spec, this.sly_data);
      } else {
        coded_tool = python_class();
      }
    } catch (exception) {
      let message = `
Coded tool class ${python_class} must take no arguments to its constructor.
The standard pattern for CodedTools is to not have a constructor at all.

Some hints:
1)  If you are attempting to re-use/re-purpose your CodedTool implementation,
    consider adding an "args" block to your specific agents. This will pass
    whatever dictionary you specify there as extra key/value pairs to your
    CodedTool's invoke()/async_invoke() method's args parameter in addition
    to those provided by any calling LLM.
2)  If you need something more dynamic that is shared amongst the CodedTools
    of your agent network to handle a single request, consider lazy instantiation
    of the object in question, and share a reference to that object in the
    sly_data dictionary. The lifetime of that object will last as long
    as the request itself is in motion.
3)  Try very very hard to *not* use global variables/singletons to bypass this limitation.
    Your CodedTool implementation is working in a multi-threaded, asynchronous
    environment. If your first instinct is to reach for a global variable,
    you are highly likely to diminish the performance for all other requests
    on any server running your agent with your CodedTool.
`;
      throw new Error(message);
    }
    return coded_tool;
  }
  /**
   * Attempt to invoke the coded tool.
   *
   * :param coded_tool: The CodedTool instance to invoke
   * :param args: The arguments dictionary to pass as input to the coded_tool
   * :param sly_data: The sly_data dictionary to pass as input to the coded_tool
   * :return: The result of the coded_tool, whatever that is.
   */
  async attempt_invoke(coded_tool, args, sly_data) {
    let retval = null;
    let arguments_dict = ToolArgumentReporting.prepare_tool_start_dict(args);
    let message = new AgentMessage("Received arguments:", arguments_dict, null);
    await this.journal.write_message(message, null);
    let tool_error = false;
    try {
      try {
        retval = await coded_tool.async_invoke(this.arguments, this.sly_data);
      } catch (e) {
        let info_message = `
Running CodedTool class ${coded_tool.constructor.name}.invoke() synchronously in an asynchronous environment.
This can lead to performance problems when running within a server. Consider porting to the async_invoke() method.
`;
        this.logger.info(info_message);
        await this.journal.write_message(new AgentMessage(info_message, {}, null));
        let invocation_context = this.run_context.get_invocation_context();
        let executor = invocation_context.get_asyncio_executor();
        let loop = executor.get_event_loop();
        retval = await loop.run_in_executor(null, coded_tool.invoke, args, sly_data);
      }
    } catch (exception) {
      tool_error = true;
      retval = `Error: ${String(exception)}`;
      this.logger.error("Error invoking CodedTool %s: %s", coded_tool.constructor.name, String(exception));
      this.logger.error(format_exc());
    }
    let retval_dict = { "tool_end": true, "tool_error": tool_error, "tool_output": retval };
    let result_message = new AgentMessage("Got result:", retval_dict, null);
    await this.journal.write_message(result_message, null);
    return retval;
  }
}
exposeClassAttributes(AbstractClassActivation);
class ToolboxActivation extends AbstractClassActivation {
  /**
   * Returns the full class reference path from a predefined toolbox.
   *
   * This implementation looks up the tool by name in a toolbox, using the
   * "toolbox" field in `agent_tool_spec`, then determine the class of that
   * coded tool.
   *
   * :return: A dot-separated string representing the full class path.
   */
  get_full_class_ref() {
    let tool_name = dict.get(this.agent_tool_spec, "toolbox");
    let invocation_context = this.run_context.get_invocation_context();
    let toolbox_factory = invocation_context.get_toolbox_factory();
    return toolbox_factory.get_shared_coded_tool_class(tool_name);
  }
}
exposeClassAttributes(ToolboxActivation);
class ToolboxActivationPrepper extends ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    return dict.get(agent_tool_spec, "toolbox") != null;
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    let use_args = this.merge_args(args, agent_tool_spec);
    return new ToolboxActivation(parent_run_context, factory, use_args, agent_tool_spec, sly_data);
  }
}
exposeClassAttributes(ToolboxActivationPrepper);
class ClassActivation extends AbstractClassActivation {
  /**
   * Returns the full class reference path directly from the class specification.
   *
   * This implementation expects the fully qualified class name to be provided
   * in the "class" field of the `agent_tool_spec` dictionary.
   *
   * :return: A dot-separated string representing the full class path.
   */
  get_full_class_ref() {
    return dict.get(this.agent_tool_spec, "class");
  }
}
exposeClassAttributes(ClassActivation);
class ClassActivationPrepper extends ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    return dict.get(agent_tool_spec, "function") != null && dict.get(agent_tool_spec, "class") != null;
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    let use_args = this.merge_args(args, agent_tool_spec);
    return new ClassActivation(parent_run_context, factory, use_args, agent_tool_spec, sly_data);
  }
}
exposeClassAttributes(ClassActivationPrepper);
class BranchActivationPrepper extends ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    return dict.get(agent_tool_spec, "function") != null && dict.get(agent_tool_spec, "class") == null;
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    let use_args = this.merge_args(args, agent_tool_spec);
    return new BranchActivation(parent_run_context, factory, use_args, agent_tool_spec, sly_data);
  }
}
exposeClassAttributes(BranchActivationPrepper);
class FrontManActivationPrepper extends ActivationPrepper {
  /**
   * :param agent_tool_spec: the agent tool spec dictionary. Can be null for external agents.
   * :return: True if this ActivationPrepper is applicable to the given agent tool spec
   */
  is_applicable(agent_tool_spec) {
    return dict.get(agent_tool_spec, "function") == null;
  }
  /**
   * Assuming that is_applicable() has already been vetted, this method prepares a CallableActivation
   * object for the given agent tool spec.
   *
   * :param name: the name of the agent tool
   * :param agent_tool_spec: the agent tool spec dictionary
   * :param parent_agent_spec: the parent agent spec dictionary
   * :param args: the arguments dictionary
   * :param sly_data: the sly data dictionary
   * :param parent_run_context: the parent run context
   * :param factory: the agent tool factory
   * :param invocation: the invocation string ("chatbot" or "event")
   * :return: a CallableActivation
   */
  prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation) {
    return new FrontManActivation(parent_run_context, factory, agent_tool_spec, sly_data);
  }
}
exposeClassAttributes(FrontManActivationPrepper);
var os_separator = posix.sep;
var os_path_separator = posix.delimiter;
class ActivationFactory extends AgentToolFactory {
  static {
    this.BASE_PREPPERS = [new ExternalActivationPrepper(), new ToolboxActivationPrepper(), new ClassActivationPrepper(), new BranchActivationPrepper(), new FrontManActivationPrepper()];
  }
  /**
   * Constructor
   *
   * :param agent_network: The AgentNetwork this factory will be basing its information on
   */
  constructor(agent_network) {
    super();
    this.agent_network = agent_network;
    this.agent_tool_path = this._determine_agent_tool_path();
    this.preppers = this._create_preppers();
  }
  /**
   * Policy for determining where tool source should be looked for
   * when resolving references to coded tools.
   *
   * :return: the agent tool path to use for source resolution.
   */
  _determine_agent_tool_path() {
    let agent_tool_path = dict.get(process.env, "AGENT_TOOL_PATH");
    if (agent_tool_path == null) {
      agent_tool_path = TOP_LEVEL_DIR.get_file_in_basis("coded_tools");
    }
    if (agent_tool_path.indexOf(os_separator) >= 0) {
      let resolved_tool_path = String(new Path(agent_tool_path).resolve());
      let best_path = "";
      let pythonpath = dict.get(process.env, "PYTHONPATH");
      if (pythonpath == null) {
        best_path = agent_tool_path;
      } else {
        let pythonpath_split = pythonpath.split(os_path_separator);
        for (const one_path of iter2(pythonpath_split)) {
          let resolved_path = String(new Path(one_path).resolve());
          if (resolved_tool_path.startsWith(resolved_path) && len(resolved_path) > len(best_path)) {
            best_path = resolved_path;
          }
        }
      }
      if (len(best_path) == 0) {
        throw new Error(`No reasonable agent tool path found in PYTHONPATH for ${agent_tool_path}`);
      }
      let path_split = resolved_tool_path.split(best_path);
      if (len(path_split) < 2) {
        throw new Error(`
Cannot find tool path for {agent_tool_path} in PYTHONPATH.
Check to be sure your value for PYTHONPATH includes where you expect where your coded tools live.
`);
      }
      let resolve_path = path_split[1];
      agent_tool_path = string2.replace(resolve_path, os_separator, ".");
      while (agent_tool_path.startsWith(".")) {
        agent_tool_path = slice2(agent_tool_path, 1, void 0);
      }
    }
    let agent_network_path = string2.replace(this.agent_network.get_network_name(), "/", ".");
    if (!agent_tool_path.endsWith(agent_network_path)) {
      agent_tool_path = `${agent_tool_path}.${agent_network_path}`;
    }
    return agent_tool_path;
  }
  /**
   * Create a list of ActivationPrepper instances to use using BASE_PREPPERS as a basis,
   * then add any externally defined preppers.
   *
   * :return: A list of ActivationPrepper instances
   */
  _create_preppers() {
    let preppers = copy(this.BASE_PREPPERS);
    let external_preppers = [];
    let prepper_class_name = null;
    let agent_prepper_classes = dict.get(process.env, "AGENT_ACTIVATION_PREPPER_CLASSES") || "";
    for (const prepper_class_name2 of agent_prepper_classes.split(/\s+/)) {
      let use_prepper_class_name = prepper_class_name2.trim();
      let prepper = ResolverUtil.create_instance(use_prepper_class_name, "AGENT_ACTIVATION_PREPPER_CLASSES env var", ActivationPrepper);
      if (prepper != null) {
        external_preppers.push(prepper);
      }
    }
    if (len(external_preppers) > 0) {
      list3.sliceAssign(preppers, 1, 1, void 0, external_preppers);
    }
    return preppers;
  }
  /**
   * :return: The path under which tools for this registry should be looked for.
   */
  get_agent_tool_path() {
    return this.agent_tool_path;
  }
  /**
   * Create an active node for an agent from its spec.
   * This is how CallableActivations create other CallableActivations.
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
    if (factory == null) {
      factory = this;
    }
    let agent_tool_spec = this.agent_network.get_agent_tool_spec(name);
    let prepper = null;
    for (const candidate of this.preppers) {
      if (candidate.is_applicable(agent_tool_spec)) {
        prepper = candidate;
        break;
      }
    }
    if (prepper == null) {
      throw new Error(`No activation handler found for ${name} (tool spec: ${agent_tool_spec})`);
    }
    let agent_activation = prepper.prepare_activation(name, agent_tool_spec, parent_agent_spec, args, sly_data, parent_run_context, factory, invocation);
    return agent_activation;
  }
  /**
   * Find and create the FrontMan for DataDrivenChat
   *
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   * :param parent_run_context: A RunContext instance
   * :param factory: An optional extra parameter at this ActivationFactory level to provide
   * the correct object reference for factory scope/lifetime issues.
   */
  create_front_man(sly_data, parent_run_context, factory) {
    if (factory == null) {
      factory = this;
    }
    let front_man_name = this.agent_network.find_front_man();
    let agent_tool_spec = this.agent_network.get_agent_tool_spec(front_man_name);
    let front_man = new FrontManActivation(parent_run_context, factory, agent_tool_spec, sly_data);
    return front_man;
  }
  /**
   * :return: The entire config dictionary given to the instance.
   */
  get_config() {
    return this.agent_network.get_config();
  }
  /**
   * :param agent_spec: A single agent to register
   * :return: The agent name as per the spec
   */
  get_name_from_spec(agent_spec) {
    return this.agent_network.get_name_from_spec(agent_spec);
  }
}
exposeClassAttributes(ActivationFactory);
class AgentToolRegistry extends AgentNetworkInspector {
  /**
   * Constructor
   *
   * :param agent_network: The AgentNetwork configuration to base all our info on
   */
  constructor(agent_network) {
    super();
    this.agent_network = agent_network;
    this.factory = new ActivationFactory(this.agent_network);
  }
  /**
   * Create an active node for an agent from its spec.
   * This is how CallableActivations create other CallableActivations.
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
    return this.factory.create_agent_activation(parent_run_context, parent_agent_spec, name, sly_data, args, this, invocation);
  }
  /**
   * Find and create the FrontMan for DataDrivenChat.
   *
   * :param sly_data: A mapping whose keys might be referenceable by agents, but whose
   * values should not appear in agent chat text. Can be an empty dictionary.
   * :param parent_run_context: A RunContext instance
   */
  create_front_man(sly_data, parent_run_context) {
    return this.factory.create_front_man(sly_data, parent_run_context, this);
  }
  /**
   * :return: The path under which tools for this registry should be looked for.
   */
  get_agent_tool_path() {
    return this.factory.get_agent_tool_path();
  }
  /**
   * :return: The entire config dictionary given to the instance.
   */
  get_config() {
    return this.agent_network.get_config();
  }
  /**
   * :param name: The name of the agent tool to get out of the registry
   * :return: The dictionary representing the spec registered agent
   */
  get_agent_tool_spec(name) {
    return this.agent_network.get_agent_tool_spec(name);
  }
  /**
   * :param agent_spec: A single agent to register
   * :return: The agent name as per the spec
   */
  get_name_from_spec(agent_spec) {
    return this.agent_network.get_name_from_spec(agent_spec);
  }
  /**
   * :return: A single tool name to use as the root of the chat agent.
   * This guy will be user facing.  If there are none or > 1,
   * an exception will be raised.
   */
  find_front_man() {
    return this.agent_network.find_front_man();
  }
  /**
   * :return: The absolute path of agent llm info file for llm extension.
   */
  get_agent_llm_info_file() {
    return this.agent_network.get_agent_llm_info_file();
  }
  /**
   * :return: The size in Uint8Array of this AgentNetwork
   */
  get_size_in_bytes() {
    return this.agent_network.get_size_in_bytes();
  }
}
exposeClassAttributes(AgentToolRegistry);
export {
  AgentNetwork,
  AgentToolRegistry,
  NetworkConfigFilterChain,
  ResolvedNetworkConfigFilter
};
