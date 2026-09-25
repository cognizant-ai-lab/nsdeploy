import { DictionaryValidator, DictionaryExtractor, CompositeDictionaryValidator } from "./leaf_common.mjs";
import { is_dict, dict, contains, set, len, next } from "./stubs.mjs";
import { iter2, isinstance2, list3, getLogger, type2, match, repr2, enumerate2, sorted2 } from "../vendor/libraries.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
import { NetworkConfigFilterChain } from "./graph.mjs";
import { BaseModelDictionaryConverter } from "./run_context.mjs";
class AbstractNetworkValidator extends DictionaryValidator {
  static {
    this._PARAMS_NOT_FOUND = /* @__PURE__ */ Symbol("_PARAMS_NOT_FOUND");
  }
  /**
   * Locate the parameters block on an agent spec, checking
   * ``function.parameters`` (OpenAI-style) first, then a top-level
   * ``parameters`` key.
   *
   * :return: The raw value if the key exists (may be ``None`` for
   * explicitly null entries), or ``_PARAMS_NOT_FOUND`` when
   * no parameters key is present at all.
   */
  static _locate_parameters(agent_spec) {
    if (!is_dict(agent_spec)) {
      return AbstractNetworkValidator._PARAMS_NOT_FOUND;
    }
    let function_block = dict.get(agent_spec, "function");
    if (is_dict(function_block) && contains("parameters", function_block)) {
      return dict.get(function_block, "parameters");
    }
    if (contains("parameters", agent_spec)) {
      return dict.get(agent_spec, "parameters");
    }
    return AbstractNetworkValidator._PARAMS_NOT_FOUND;
  }
  /**
   * Validate the agent network.
   *
   * Expects a fully-resolved config (commondefs substitution, defaults
   * injection, and name correction already applied). Production callers
   * get this from the restorer's filter chain; the parameter validators
   * get it from ParametersSchemaNetworkValidator, which filters once for
   * both of its phases rather than once per validator.
   *
   * :param candidate: The agent network or name -> spec dictionary to validate
   * :return: A list of error messages
   */
  validate(candidate) {
    let errors = [];
    if (!candidate) {
      errors.push("Agent network is empty.");
      return errors;
    }
    let name_to_spec = AbstractNetworkValidator.get_name_to_spec(candidate);
    let name_to_spec_errors = this.validate_name_to_spec_dict(name_to_spec);
    errors.push(...name_to_spec_errors);
    return errors;
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages
   */
  validate_name_to_spec_dict(name_to_spec) {
    throw Error("Method not implemented");
  }
  /**
   * :param agent_network: The top-level agent network or tools dictionary
   * :return: The agent name -> single agent spec dictionary of the agent network
   */
  static get_name_to_spec(agent_network) {
    if (agent_network == null) {
      return null;
    }
    if (!contains("tools", agent_network)) {
      return agent_network;
    }
    let name_to_spec = {};
    let agents = dict.get(agent_network, "tools", []);
    for (const one_agent of iter2(agents)) {
      name_to_spec[dict.get(one_agent, "name")] = one_agent;
    }
    return name_to_spec;
  }
  /**
   * Check if a tool string is a URL or file path (not an agent name).
   *
   * :param tool: The tool string to check
   * :return: True if tool is a URL or path, False otherwise
   */
  static is_url_or_path(tool) {
    return tool.startsWith("/") || tool.startsWith("http://") || tool.startsWith("https://");
  }
  /**
   * Sometimes tool lists have dictionary entries to support servers-based tools
   * that need more than just a string.  For instance MCP servers.
   * :param  down_chains: List of tools
   * :return: List of tools without dictionary entries
   */
  static remove_dictionary_tools(down_chains) {
    let safe_list = [];
    for (const tool of iter2(down_chains)) {
      if (isinstance2(tool, String)) {
        safe_list.push(tool);
      }
    }
    return safe_list;
  }
  /**
   * Return the agent's `tools` as a list, coercing malformed values to empty.
   *
   * Callers that traverse the connectivity graph (front-man detection,
   * reachability, missing nodes, cycles) should use this rather than reading
   * `tools` directly so they do not crash on `str + list` or iterate the
   * characters of a string. The shape contract this enforces matches
   * ToolsShapeValidator.validate_tools, which is the place that reports the
   * shape error to the user.
   *
   * :param agent_spec: The agent specification dictionary
   * :return: The agent's `tools` list, or an empty list if the value is malformed.
   */
  static coerce_tools(agent_spec) {
    let no_tools = [];
    let extractor = new DictionaryExtractor(agent_spec, ".");
    let tools = extractor.get("tools", no_tools);
    if (isinstance2(tools, Array)) {
      return tools;
    }
    return no_tools;
  }
  /**
   * Return `args.tools` as a list of values, coercing malformed shapes to empty.
   *
   * `args.tools` is the convention coded tools use to declare downstream agents.
   * It may be a dict of label -> agent name (the values are the agent names)
   * or a list of agent names; anything else is coerced to empty. The shape
   * contract this enforces matches ToolsShapeValidator.validate_args_tools,
   * which is the place that reports the shape error to the user.
   *
   * :param agent_spec: The agent specification dictionary
   * :return: The combined list of agent names referenced by `args.tools`, or
   * empty if the value is missing or malformed.
   */
  static coerce_args_tools(agent_spec) {
    let no_tools = [];
    let extractor = new DictionaryExtractor(agent_spec, ".");
    let args_tools = extractor.get("args.tools", no_tools);
    if (is_dict(args_tools)) {
      return list3(Object.values(args_tools));
    }
    if (isinstance2(args_tools, Array)) {
      return args_tools;
    }
    return no_tools;
  }
}
exposeClassAttributes(AbstractNetworkValidator);
class KeywordNetworkValidator extends AbstractNetworkValidator {
  static {
    this.ALL_KEYWORDS = set(["description", "instructions"]);
  }
  /**
   * Constructor
   *
   * :param keywords: Iterable of keyword names to validate.
   * If null, all keywords are validated.
   * :param network_name: The agent network name for diagnostic log lines
   *
   * Note: `tools` shape validation lives in ToolsShapeValidator (a structure
   * concern, not a keyword concern), and is not handled by this class.
   */
  constructor(keywords, network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.keywords = keywords != null ? set(keywords) : this.ALL_KEYWORDS;
    this.network_name = network_name;
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: List of errors indicating agents and missing keywords
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    this.logger.debug("Validating %s agent network keywords...", this.network_name);
    for (const [agent_name, agent] of Object.entries(name_to_spec)) {
      if (contains("description", this.keywords)) {
        errors.push(...KeywordNetworkValidator.validate_description(agent_name, agent));
      }
      if (contains("instructions", this.keywords)) {
        errors.push(...KeywordNetworkValidator.validate_instructions(agent_name, agent));
      }
    }
    if (len(errors) > 0) {
      this.logger.warning(String(errors));
    }
    return errors;
  }
  /**
   * Validate that 'function.description' is a non-empty string when present.
   *
   * :param agent_name: The name of the agent being validated
   * :param agent: The agent spec dictionary
   * :return: A list of error messages
   */
  static validate_description(agent_name, agent) {
    let errors = [];
    let _function = dict.get(agent, "function");
    if (_function == null) {
      return errors;
    }
    if (!is_dict(_function)) {
      errors.push(`${agent_name} 'function' must be a dict, got ${type2(_function)}.`);
      return errors;
    }
    let description = dict.get(_function, "description");
    if (description != null) {
      if (!isinstance2(description, String)) {
        errors.push(`${agent_name} 'function.description' must be a str, got ${type2(description)}.`);
      } else if (description.trim() == "") {
        errors.push(`${agent_name} 'function.description' cannot be empty.`);
      }
    }
    return errors;
  }
  /**
   * Validate that 'instructions' is a non-empty string when present.
   *
   * :param agent_name: The name of the agent being validated
   * :param agent: The agent spec dictionary
   * :return: A list of error messages
   */
  static validate_instructions(agent_name, agent) {
    let errors = [];
    let instructions = dict.get(agent, "instructions");
    if (instructions != null) {
      if (!isinstance2(instructions, String)) {
        errors.push(`${agent_name} 'instructions' must be a str, got ${type2(instructions)}.`);
      } else if (instructions.trim() == "") {
        errors.push(`${agent_name} 'instructions' cannot be empty.`);
      }
    }
    return errors;
  }
}
exposeClassAttributes(KeywordNetworkValidator);
class MissingNodesNetworkValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   */
  constructor() {
    super();
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    let missing_nodes = this.find_missing_agent_nodes(name_to_spec);
    if (missing_nodes) {
      for (const [agent, missing_tools] of Object.entries(missing_nodes)) {
        let tools_str = [...(function* () {
          for (const tool of missing_tools)
            yield `'${tool}'`;
        })()].join(", ");
        errors.push(`Agent '${agent}' references non-existent agent(s) in tools: ${tools_str}`);
      }
    }
    if (len(errors) > 0) {
      this.logger.warning(String(errors));
    }
    return errors;
  }
  /**
   * Find agents referenced in "tools" lists that don't have corresponding nodes in the network.
   *
   * :param name_to_spec: The agent network to validate
   * :return: Dictionary mapping agent names to list of tools that reference non-existent agents
   * Format: {agent_name: [missing_tool1, missing_tool2, ...]}
   */
  find_missing_agent_nodes(name_to_spec) {
    let missing_nodes = {};
    for (const [agent_name, agent_data] of Object.entries(name_to_spec)) {
      let tools = MissingNodesNetworkValidator.coerce_tools(agent_data);
      let safe_tools = MissingNodesNetworkValidator.remove_dictionary_tools(tools);
      for (const tool of iter2(safe_tools)) {
        if (MissingNodesNetworkValidator.is_url_or_path(tool)) {
          continue;
        }
        if (!contains(tool, name_to_spec)) {
          if (!contains(agent_name, missing_nodes)) {
            missing_nodes[agent_name] = [];
          }
          missing_nodes[agent_name].push(tool);
        }
      }
    }
    return missing_nodes;
  }
}
exposeClassAttributes(MissingNodesNetworkValidator);
class ToolNameNetworkValidator extends AbstractNetworkValidator {
  static {
    this.TOOL_NAME_PATTERN = "^[a-zA-Z0-9_-]+$";
  }
  /**
   * Constructor
   */
  constructor() {
    super();
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: List of errors indicating agents than have invalid names
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    for (const [agent_name, agent] of Object.entries(name_to_spec)) {
      let spec_name = dict.get(agent, "name");
      if (!match(ToolNameNetworkValidator.TOOL_NAME_PATTERN, agent_name) || !match(ToolNameNetworkValidator.TOOL_NAME_PATTERN, spec_name)) {
        let error_msg = `${agent_name} must match the regex '${ToolNameNetworkValidator.TOOL_NAME_PATTERN}'`;
        errors.push(error_msg);
      }
    }
    if (len(errors) > 0) {
      this.logger.warning(String(errors));
    }
    return errors;
  }
}
exposeClassAttributes(ToolNameNetworkValidator);
class ToolsShapeValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   *
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.network_name = network_name;
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    this.logger.debug("Validating %s tools shape...", this.network_name);
    for (const [agent_name, agent] of Object.entries(name_to_spec)) {
      errors.push(...ToolsShapeValidator.validate_tools(agent_name, agent));
      errors.push(...ToolsShapeValidator.validate_args_tools(agent_name, agent));
    }
    if (len(errors) > 0) {
      this.logger.warning(String(errors));
    }
    return errors;
  }
  /**
   * Validate that 'tools' is a list where each element is a string or dict.
   *
   * :param agent_name: The name of the agent being validated
   * :param agent: The agent spec dictionary
   * :return: A list of error messages
   */
  static validate_tools(agent_name, agent) {
    let tools = dict.get(agent, "tools");
    if (tools == null) {
      return [];
    }
    if (!isinstance2(tools, Array)) {
      return [`${agent_name} 'tools' must be a list, got ${type2(tools)}.`];
    }
    return ToolsShapeValidator.check_element_types(tools, [String, Object], "str or dict", agent_name, "tools");
  }
  /**
   * Validate that 'args.tools', if present, is either a dict of string values or a
   * list of string values. This is the coded-tool convention for declaring
   * downstream agents: a dict of label -> agent name, or a list of agent names.
   *
   * :param agent_name: The name of the agent being validated
   * :param agent: The agent spec dictionary
   * :return: A list of error messages
   */
  static validate_args_tools(agent_name, agent) {
    let args = dict.get(agent, "args");
    if (!is_dict(args) || !contains("tools", args)) {
      return [];
    }
    let args_tools = dict.get(args, "tools");
    if (!isinstance2(args_tools, [Object, Array])) {
      return [`${agent_name} 'args.tools' must be a dict or list, got ${type2(args_tools)}.`];
    }
    return ToolsShapeValidator.check_element_types(args_tools, String, "str (agent name)", agent_name, "args.tools");
  }
  /**
   * Validate that each value in `items` is an instance of `allowed_types`.
   *
   * `items` can be a list (indexed by position, error label uses [i]) or a
   * dict (keyed by label, error label uses [key!r]). Used by both
   * `validate_tools` (tools list) and `validate_args_tools` (args.tools as
   * dict or list) to keep the iteration + error format consistent.
   *
   * :param items: The list or dict whose entries to check
   * :param allowed_types: A type or tuple of types each value must match
   * :param type_label: Human-readable description of allowed types for the
   * error message (e.g., "str or dict", "str (agent name)")
   * :param agent_name: The name of the agent being validated
   * :param field_prefix: The field path prefix used in error messages
   * (e.g., "tools" or "args.tools")
   * :return: A list of error messages, one per element that fails the check
   */
  static check_element_types(items, allowed_types, type_label, agent_name, field_prefix) {
    let errors = [];
    if (is_dict(items)) {
      for (const [key, value] of Object.entries(items)) {
        if (!isinstance2(value, allowed_types)) {
          errors.push(`${agent_name} '${field_prefix}[${repr2(key)}]' must be a ${type_label}, got ${type2(value)}.`);
        }
      }
    } else if (isinstance2(items, Array)) {
      for (const [i, value] of enumerate2(items)) {
        if (!isinstance2(value, allowed_types)) {
          errors.push(`${agent_name} '${field_prefix}[${i}]' must be a ${type_label}, got ${type2(value)}.`);
        }
      }
    }
    return errors;
  }
}
exposeClassAttributes(ToolsShapeValidator);
class UnreachableNodesNetworkValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   *
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.network_name = network_name;
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    this.logger.debug("Validating %s agent network structure...", this.network_name);
    let front_man_agents = this.find_all_front_man_agents(name_to_spec);
    if (len(front_man_agents) == 0) {
      errors.push("No front man agent found in network");
    } else if (len(front_man_agents) > 1) {
      errors.push(`Multiple front man agents found: ${sorted2(front_man_agents)}. Expected exactly one.`);
    }
    let unreachable_agents = set();
    if (len(front_man_agents) == 1) {
      let front_man_agent = next(iter2(front_man_agents));
      unreachable_agents = this.find_unreachable_agents(name_to_spec, front_man_agent);
      if (len(unreachable_agents) > 0) {
        errors.push(`Unreachable agents found: ${sorted2(unreachable_agents)}`);
      }
    }
    if (len(errors) > 0) {
      this.logger.warning(String(errors));
    }
    return errors;
  }
  /**
   * Build the list of traversable down-chain agent names for an agent spec.
   *
   * Down-chains come from two sources: the traditional `tools` field (a list of agent
   * names and/or inline dicts), and `args.tools` (the convention for coded tools, which
   * may be a dict of label -> agent name or a list of names). Both are read through
   * the inherited coerce helpers so a malformed value (the #852 case where `tools`
   * is a string) is treated as empty instead of crashing on `str + list`. The shape
   * error itself is surfaced by ToolsShapeValidator running in the validation chain.
   *
   * Dict-shaped entries (MCP/inline tool configs) and URL/path entries are filtered
   * out so the result contains only the agent names that this validator should
   * traverse.
   *
   * :param agent_spec: The agent specification dictionary
   * :return: List of agent-name strings reachable from this spec.
   */
  get_agent_down_chains(agent_spec) {
    let raw_down_chains = [...UnreachableNodesNetworkValidator.coerce_tools(agent_spec), ...UnreachableNodesNetworkValidator.coerce_args_tools(agent_spec)];
    let safe_down_chains = UnreachableNodesNetworkValidator.remove_dictionary_tools(raw_down_chains);
    let traversable_down_chains = [];
    for (const tool of iter2(safe_down_chains)) {
      if (!UnreachableNodesNetworkValidator.is_url_or_path(tool)) {
        traversable_down_chains.push(tool);
      }
    }
    return traversable_down_chains;
  }
  /**
   * Find all front man agents - agents that have down-chains but are not down-chains of others.
   *
   * :param name_to_spec: The agent network to validate
   * :return: Set of front man agent names
   */
  find_all_front_man_agents(name_to_spec) {
    let all_down_chains = set();
    let has_down_chains = set();
    for (const [agent_name, agent_config] of Object.entries(name_to_spec)) {
      let down_chains = this.get_agent_down_chains(agent_config);
      if (down_chains != null && len(down_chains) > 0) {
        has_down_chains.add(agent_name);
        for (const one_down_chain of down_chains) {
          all_down_chains.add(one_down_chain);
        }
        ;
      }
    }
    let front_man_agents = new Set([...has_down_chains].filter((one) => !all_down_chains.has(one)));
    if (len(front_man_agents) == 0 && len(name_to_spec) == 1) {
      let one_front_man = list3(Object.keys(name_to_spec))[0];
      front_man_agents.add(one_front_man);
    }
    return front_man_agents;
  }
  /**
   * Find agents that are unreachable from the front man agent using Depth-First Search (DFS) traversal.
   *
   * :param name_to_spec: The agent network to validate
   * :param front_man_agent: The single front man agent to start from
   * :return: Set of unreachable agent names
   */
  find_unreachable_agents(name_to_spec, front_man_agent) {
    let reachable_agents = set();
    let visited = set();
    this.dfs_reachability_traversal(name_to_spec, front_man_agent, visited, reachable_agents);
    let all_agents = set(Object.keys(name_to_spec));
    let unreachable_agents = new Set([...all_agents].filter((one) => !reachable_agents.has(one)));
    return unreachable_agents;
  }
  /**
   * Perform DFS traversal to find all agents reachable from a specific starting agent.
   *
   * :param name_to_spec: The agent network to validate
   * :param agent: Current agent being visited
   * :param visited: Set of agents already visited in this traversal (prevents infinite loops)
   * :param reachable_agents: Set to collect all agents that can be reached
   */
  dfs_reachability_traversal(name_to_spec, agent, visited, reachable_agents) {
    if (contains(agent, visited) || !contains(agent, name_to_spec)) {
      return;
    }
    visited.add(agent);
    reachable_agents.add(agent);
    let empty = {};
    let agent_spec = dict.get(name_to_spec, agent, empty);
    let down_chains = this.get_agent_down_chains(agent_spec);
    for (const child_agent of iter2(down_chains)) {
      this.dfs_reachability_traversal(name_to_spec, child_agent, visited, reachable_agents);
    }
  }
}
exposeClassAttributes(UnreachableNodesNetworkValidator);
class UrlNetworkValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   *
   * :param external_agents: A list of valid /external_agent referencess
   * :param mcp_servers: A list of MCP servers, as read in from a mcp_info.hocon file
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(external_agents, mcp_servers, network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.external_agents = external_agents;
    this.mcp_servers = mcp_servers;
    this.network_name = network_name;
  }
  /**
   * Validate the agent network, specifically in the form of a name -> agent spec dictionary.
   * Check if URL of MCP servers and external_agents are valid.
   *
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: List of errors indicating invalid URL
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    let urls = [];
    if (this.external_agents) {
      urls.push(...this.external_agents);
    }
    if (this.mcp_servers) {
      urls.push(...this.mcp_servers);
    }
    this.logger.debug("Validating %s URLs for MCP tools and subnetwork...", this.network_name);
    for (const [agent_name, agent] of Object.entries(name_to_spec)) {
      let tools = UrlNetworkValidator.coerce_tools(agent);
      if (tools) {
        let safe_tools = UrlNetworkValidator.remove_dictionary_tools(tools);
        this.check_safe_urls(agent_name, safe_tools, urls, errors);
      }
    }
    return errors;
  }
  /**
   * Validate that URL- or path-like tool references resolve to a known endpoint.
   *
   * A tool reference is considered valid if it matches one of the configured
   * external agents / MCP servers, is an http(s):// URL, or ends with "mcp"
   * or "mcp/"., unknown unrecognized URL- or path-like tool is appended to errors.
   *
   * :param agent_name: Name of the agent that owns these tools
   * :param safe_tools: Tool references to check (with dictionary-form tools removed)
   * :param urls: Known-valid URLs (configured external agents and MCP servers)
   * :param errors: List of errors. Modified in place when invalid tools are found.
   */
  check_safe_urls(agent_name, safe_tools, urls, errors) {
    for (const tool of iter2(safe_tools)) {
      if (UrlNetworkValidator.is_url_or_path(tool) && !contains(tool, urls) && (!tool.startsWith("http://") && (!tool.startsWith("https://") && (!tool.endsWith("mcp") && !tool.endsWith("mcp/"))))) {
        let error_msg = `Agent '${agent_name}' references an unrecognized URL or path tool '${tool}'. Expected an external agent or network name starting with '/' (e.g. '/bank_ops'), an MCP server, an http(s):// URL, or an MCP endpoint. Available URLs: ${urls}`;
        errors.push(error_msg);
      }
    }
  }
}
exposeClassAttributes(UrlNetworkValidator);
class PydanticParametersNetworkValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   *
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.network_name = network_name;
  }
  /**
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages describing pydantic conversion problems.
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    this.logger.debug("Validating %s parameters via pydantic...", this.network_name);
    for (const [agent_name, agent_spec] of Object.entries(name_to_spec)) {
      let params = PydanticParametersNetworkValidator._locate_parameters(agent_spec);
      if (params === AbstractNetworkValidator._PARAMS_NOT_FOUND) {
        continue;
      }
      if (params == null) {
        errors.push(`${agent_name}: 'parameters' is null - use {} or remove the key`);
        continue;
      }
      if (!is_dict(params)) {
        errors.push(`${agent_name}: 'parameters' must be object, got ${type2(params)}`);
        continue;
      }
      let properties = dict.get(params, "properties");
      if (!is_dict(properties) || !properties) {
        continue;
      }
      try {
        let converter = new BaseModelDictionaryConverter("parameters");
        converter.from_dict(params);
      } catch (e) {
        if (e instanceof Error) {
          let detail = String(e).split(/\s+/).join(" ");
          errors.push(`${agent_name}: pydantic model conversion failed - ${detail}`);
        } else if (e instanceof Error) {
          const exc = e;
          let detail = String(e).split(/\s+/).join(" ");
          errors.push(`${agent_name}: pydantic model conversion failed - ${detail}`);
        }
      }
    }
    return errors;
  }
}
exposeClassAttributes(PydanticParametersNetworkValidator);
class SemanticParametersNetworkValidator extends AbstractNetworkValidator {
  /**
   * Constructor
   *
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(network_name) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.network_name = network_name;
  }
  /**
   * :param name_to_spec: The name -> agent spec dictionary to validate
   * :return: A list of error messages describing semantic parameter problems.
   */
  validate_name_to_spec_dict(name_to_spec) {
    let errors = [];
    this.logger.debug("Validating %s parameters semantics...", this.network_name);
    for (const [agent_name, agent_spec] of Object.entries(name_to_spec)) {
      let params = SemanticParametersNetworkValidator._locate_parameters(agent_spec);
      if (!is_dict(params)) {
        continue;
      }
      for (const nested_path of SemanticParametersNetworkValidator._find_nested_parameters_keys(params)) {
        errors.push(`${agent_name}: '${nested_path}' contains a nested 'parameters' key - move the inner 'properties' and 'required' up one level`);
      }
      errors.push(...SemanticParametersNetworkValidator._check_required_refs(agent_name, params));
    }
    return errors;
  }
  /**
   * Yield ``(child_schema, child_path)`` for every nested object
   * property and array ``items`` entry inside *schema*.
   */
  static *_iter_subschemas(schema, path) {
    let properties = dict.get(schema, "properties");
    if (is_dict(properties)) {
      for (const [prop_name, prop_schema] of Object.entries(properties)) {
        if (is_dict(prop_schema)) {
          yield [prop_schema, path + ".properties." + prop_name];
        }
      }
    }
    let items = dict.get(schema, "items");
    if (is_dict(items)) {
      yield [items, path + ".items"];
    }
  }
  /**
   * Recursively verify that every ``required`` entry references a
   * key that exists in ``properties``.  Pydantic silently ignores
   * missing required entries, so this must remain a custom check.
   *
   * :param agent_name: Display name for error messages
   * :param params: The schema dict to validate
   * :param path: Dotted path for contextual error messages
   * :return: A list of error messages
   */
  static _check_required_refs(agent_name, params, path = "parameters") {
    let errors = [];
    if (!is_dict(params)) {
      return errors;
    }
    let properties = dict.get(params, "properties");
    let required = dict.get(params, "required");
    if (isinstance2(required, Array) && is_dict(properties)) {
      let missing = required.filter((r) => !contains(r, properties)).map((r) => r);
      if (missing) {
        errors.push(`${agent_name}: ${path}.required has undefined props ${missing}`);
      }
    }
    for (const [child, child_path] of this._iter_subschemas(params, path)) {
      errors.push(...SemanticParametersNetworkValidator._check_required_refs(agent_name, child, child_path));
    }
    return errors;
  }
  /**
   * Walk a JSON-schema-like tree, returning every dotted path whose dict
   * contains a 'parameters' key.  Does not recurse into the 'parameters'
   * value itself - once we've flagged a site as malformed, we leave the
   * inner contents alone (fixing the outer occurrence likely fixes the
   * inner ones, and reporting both would be noisy).
   */
  static _find_nested_parameters_keys(schema, path = "parameters") {
    let found = [];
    if (!is_dict(schema)) {
      return found;
    }
    if (contains("parameters", schema)) {
      found.push(path);
    }
    for (const [child, child_path] of this._iter_subschemas(schema, path)) {
      found.push(...SemanticParametersNetworkValidator._find_nested_parameters_keys(child, child_path));
    }
    return found;
  }
}
exposeClassAttributes(SemanticParametersNetworkValidator);
class ParametersSchemaNetworkValidator extends CompositeDictionaryValidator {
  /**
   * Constructor
   *
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(network_name) {
    let validators = [new PydanticParametersNetworkValidator(network_name), new SemanticParametersNetworkValidator(network_name)];
    super(validators);
  }
  /**
   * Resolve the config once, then run both parameter phases on it.
   *
   * The parameter validators need fully-resolved configs (commondefs
   * substitution, defaults injection, name correction). Filtering here -
   * rather than inside each leaf validator - means the filter chain runs
   * a single time for both phases instead of once per validator, which
   * matters when this composite is itself nested inside the larger
   * ManifestNetworkValidator.
   *
   * :param candidate: The agent network or name -> spec dictionary to validate
   * :return: A list of error messages
   */
  validate(candidate) {
    if (!candidate) {
      return super.validate(candidate);
    }
    let filtered = new NetworkConfigFilterChain().filter_config(candidate);
    return super.validate(filtered);
  }
}
exposeClassAttributes(ParametersSchemaNetworkValidator);
class ManifestNetworkValidator extends CompositeDictionaryValidator {
  /**
   * Constructor
   *
   * :param external_network_names: A list of external network names
   * :param mcp_servers: A list of MCP servers, as read in from a mcp_info.hocon file
   * :param network_name: The agent network name for diagnostic log lines
   */
  constructor(external_network_names, mcp_servers, network_name) {
    let validators = [new ToolsShapeValidator(network_name), new KeywordNetworkValidator(null, network_name), new MissingNodesNetworkValidator(), new UnreachableNodesNetworkValidator(network_name), new ToolNameNetworkValidator(), new ParametersSchemaNetworkValidator(network_name), new UrlNetworkValidator(external_network_names, mcp_servers, network_name)];
    super(validators);
  }
}
exposeClassAttributes(ManifestNetworkValidator);
export {
  AbstractNetworkValidator,
  KeywordNetworkValidator,
  ManifestNetworkValidator,
  MissingNodesNetworkValidator,
  ToolNameNetworkValidator,
  ToolsShapeValidator,
  UnreachableNodesNetworkValidator,
  UrlNetworkValidator
};
