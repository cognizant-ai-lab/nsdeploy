import { dict, len, deepcopy, is_dict, contains } from "./stubs.mjs";
import { ConfigFilter, DictionaryOverlay, DictionaryExtractor, ConfigFilterChain } from "./leaf_common.mjs";
import { enumerate2, isinstance2, iter2, list3, slice2, getLogger, string2 } from "../vendor/libraries.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
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
export {
  NetworkConfigFilterChain,
  ResolvedNetworkConfigFilter
};
