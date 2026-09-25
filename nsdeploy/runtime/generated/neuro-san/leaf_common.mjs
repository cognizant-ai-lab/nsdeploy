import { time, max2, sorted2, list3, isinstance2, Path, slice2, dumps, load, loads, platform, getLogger, hasattr2, tuple2, partial, iter2, monotonic, copy, type2, getattr2, repr2, at2, range2, enumerate2, INFO, ERROR, CRITICAL, WARNING, DEBUG, basicConfig } from "../vendor/libraries.mjs";
import { exposeClassAttributes, ConfigFactory, ConfigTree } from "../browser/shims.mjs";
import { set, len, is_dict, contains, dict, BytesIO, SelectorEventLoop, new_event_loop, ThreadPoolExecutor, Lock, eager_task_factory, Event, Thread, set_event_loop, all_tasks, gather, format_exception, isawaitable, iscoroutinefunction, to_thread, Future, run_coroutine_threadsafe, Task, current_thread, current_task, import_module, issubclass, PersistenceFactory, deepcopy, getLogRecordFactory, setLogRecordFactory, StringIO, exc_info, EPIPE, addLevelName, fromTimestamp, dictConfig, getfile } from "./stubs.mjs";
import { process } from "../browser/process.mjs";
`
See class comment for details
`;
class TimeoutReachedException extends Error {
  /**
   * Constructor.
   * Store timeout information to pass it
   * to anyone who will handle this exception.
   *
   * :param timeout: The Timeout object which reached the timeout.
   * Note we do not type this to prevent circular dependencies
   */
  constructor(timeout) {
    super();
    this;
    this.timeout = timeout;
  }
}
exposeClassAttributes(TimeoutReachedException);
`
See class comment for details
`;
class Timeout {
  /**
   * Constructor.
   *
   * :param name: name (possibly empty) used to identify this timeout object
   * :param limit_in_seconds: timeout limit in seconds
   * if this value is negative (< 0),
   * timeout limit will never be reached (infinite timeout)
   */
  constructor(name, limit_in_seconds) {
    this.name = name;
    this.limit_in_seconds = limit_in_seconds;
    this.start_time = -1;
  }
  /**
   * Check if the timeout is reached.
   *
   * :return: True if timeout is reached at current time,
   * False otherwise
   */
  is_reached() {
    return this.get_remaining_time_in_seconds() == 0;
  }
  /**
   * Sets the name for timeout object.
   *
   * :param name: name to set.
   * :return: null
   */
  set_name(name) {
    this.name = name;
  }
  /**
   * Returns the name of timeout object.
   *
   * :return: current name of timeout
   */
  get_name() {
    return this.name;
  }
  /**
   * Sets timeout active with given limit in seconds
   * Start time will be set to current time.
   *
   * :param timeout_limit_in_seconds: timeout limit in seconds
   * :return: null
   */
  set_limit_in_seconds(timeout_limit_in_seconds) {
    this.limit_in_seconds = timeout_limit_in_seconds;
    this.start_time = time();
  }
  /**
   * Get currently set timeout limit in seconds.
   *
   * :return: timeout limit in seconds.
   */
  get_limit_in_seconds() {
    return this.limit_in_seconds;
  }
  /**
   * Get time in seconds remaining until current timeout is reached.
   *
   * Returned value will be negative if:
   * timeout is not set, or
   * timeout limit is set to be infinite ("limit_in_seconds" < 0)
   *
   * :return: remaining time in seconds
   */
  get_remaining_time_in_seconds() {
    if (this.start_time < 0 || this.limit_in_seconds < 0) {
      return -1;
    }
    let remain = this.start_time + this.limit_in_seconds - time();
    let new_remain = max2(remain, 0);
    return new_remain;
  }
  /**
   * Helper method that allows loops to asks whether they have enough
   * time, given then information in the timeout.
   * :param interval_seconds: The invertval of time to be queried,
   * in seconds.
   * :param timeout: The Timeout class to test against.
   * This can be null, in which case there is always enough time.
   * :return: True if there is enough time in the given interval and a loop
   * should continue, False otherwise.
   */
  static has_time(interval_seconds, timeout) {
    if (timeout == null) {
      return true;
    }
    let secs_remaining = timeout.get_remaining_time_in_seconds();
    if (secs_remaining < 0) {
      return true;
    }
    if (secs_remaining > interval_seconds) {
      return true;
    }
    return false;
  }
  /**
   * Check if the task timeout is reached.
   * If so, raise TimeoutReachedException exception
   * and pass timeout information along with it.
   *
   * :return: null
   */
  check_timeout() {
    if (this.is_reached()) {
      throw new TimeoutReachedException(this);
    }
  }
  /**
   * Helper that calls check_timeout() as long as the given timeout is not null.
   * :param timeout:
   */
  static check_if_not_none(timeout) {
    if (timeout != null) {
      timeout.check_timeout();
    }
  }
}
exposeClassAttributes(Timeout);
class DictionaryOverlay {
  /**
   * :param basis: The basis dictionary to be overlayed.
   * Unmodified on exit.
   * :param overlay: The overlay dictionary.
   * Unmodified on exit.
   * :param allow_overlay_only_items:
   * True, if we allow some keys from "overlay"
   * not to be present in "basis",
   * False otherwise. In this case, if such keys are found,
   * we raise Error exception.
   * :return: A new dictionary whose keys are the union of all
   * keys between the two dictionaries and whose values
   * favor the contents of the overlay dictionary.
   * In the case where values in both the basis and overlay
   * are both dictionaries, this method recurses.
   */
  overlay(basis, overlay, allow_overlay_only_items = true) {
    let overlay_only_items = set();
    let result = this._do_overlay(basis, overlay, overlay_only_items, "");
    if (len(overlay_only_items) > 0 && !allow_overlay_only_items) {
      let separator = ", ";
      let overlay_only_list = sorted2(list3(overlay_only_items));
      let message = overlay_only_list.join(separator);
      throw new Error(`overlay items not present in basis: ${message}`);
    }
    return result;
  }
  /**
   * :param basis: The basis dictionary to be overlayed.
   * Unmodified on exit.
   * :param overlay: The overlay dictionary.
   * Unmodified on exit.
   * :param overlay_only_items: set of dictionary keys
   * found in "overlay" but not in "basis".
   * This could be modified on exit.
   * :param items_prefix: for keys to be put in "overlay_only_items",
   * prefix them with "items_prefix" for better diagnostics.
   * :return: A new dictionary whose keys are the union of all
   * keys between the two dictionaries and whose values
   * favor the contents of the overlay dictionary.
   * In the case where values in both the basis and overlay
   * are both dictionaries, this method recurses.
   */
  _do_overlay(basis, overlay, overlay_only_items, items_prefix) {
    if (basis == null && overlay == null) {
      return null;
    }
    let use_basis = basis;
    if (basis == null) {
      use_basis = {};
    }
    if (!is_dict(use_basis)) {
      throw new Error("basis is not a dictionary");
    }
    let use_overlay = overlay;
    if (overlay == null) {
      use_overlay = {};
    }
    if (!is_dict(use_overlay)) {
      throw new Error("overlay is not a dictionary");
    }
    let result = {};
    Object.assign(result, use_basis);
    let key = null;
    for (const key2 of Object.keys(use_overlay)) {
      if (!contains(key2, Object.keys(use_basis))) {
        result[key2] = use_overlay[key2];
        let add_key = items_prefix + key2;
        overlay_only_items.add(add_key);
        continue;
      }
      let basis_value = dict.get(use_basis, key2);
      let overlay_value = dict.get(use_overlay, key2);
      if (basis_value != null && overlay_value != null) {
        overlay_value = this._convert_overlay_value(basis_value, overlay_value);
      }
      let result_value = overlay_value;
      if (is_dict(basis_value) && is_dict(overlay_value)) {
        result_value = this._do_overlay(basis_value, overlay_value, overlay_only_items, `${items_prefix}${key2}.`);
      }
      result[key2] = result_value;
    }
    return result;
  }
  /**
   * Given basis value from configuration and overlay value
   * we need to replace it with, convert overlay value if necessary.
   * If overlay value is a string and target basis value
   * is numeric/boolean, we expect the overlay string to represent
   * the correct value and parse it accordingly.
   *
   * :param basis_value: basis configuration value
   * :param overlay_value: value taken from configuration overlay
   * :return: converted overlay value to override basis value
   * in configuration.
   */
  _convert_overlay_value(basis_value, overlay_value) {
    let use_value = overlay_value;
    if (isinstance2(overlay_value, String)) {
      let string_value = overlay_value;
      if (isinstance2(basis_value, Boolean)) {
        use_value = Boolean(string_value.trim().toLowerCase() == "true");
      } else if (isinstance2(basis_value, Number)) {
        use_value = Number(Number(string_value));
      } else if (isinstance2(basis_value, Number)) {
        use_value = Number(string_value);
      }
    }
    return use_value;
  }
}
exposeClassAttributes(DictionaryOverlay);
class FileOfClass {
  /**
   * Constructor
   *
   * :param source_file: The source file which will be the starting point for relative paths.
   * :param path_to_basis: An optional path to a relative basis, so as to be
   * able to find other relevant files in an absolute manner.
   * This is expected to be a single string of multiple degrees of
   * ".." (or "../..", etc).
   * The default is the directory of the source_file.
   */
  constructor(source_file, path_to_basis = ".") {
    this.source_file = source_file;
    this.path_to_basis = path_to_basis;
  }
  /**
   * :return: A pathlib Path pointing to the file of the source_file
   */
  get_file_path() {
    return new Path(this.source_file);
  }
  /**
   * :return: A string pointing to the absolute file path of the source_file
   */
  get_file() {
    return String(this.get_file_path().resolve());
  }
  /**
   * :return: A pathlib Path pointing to the directory of the source_file
   */
  get_dir_path() {
    return new Path(this.source_file).parent;
  }
  /**
   * :return: The pathlib Path of the provided basis.
   */
  get_basis_path() {
    return new Path(this.get_dir_path() + "/" + this.path_to_basis);
  }
  /**
   * :return: The absolute file path of the provided basis.
   */
  get_basis() {
    return String(this.get_basis_path().resolve());
  }
  /**
   * :return: An absolute path to a file that resides within the basis.
   */
  get_file_in_basis(filename) {
    return String((this.get_basis_path() + "/" + filename).resolve());
  }
  /**
   * Used to quell Path Traversal vulnerabilities
   * :param filepath: The filepath to verify
   * :param basis: The directory under which the file must reside
   * :return: A fully resolved path if successful.
   * Otherwise a Error will be thrown.
   */
  static check_file(filepath, basis = "/") {
    if (filepath == null) {
      return filepath;
    }
    if (basis == null) {
      throw new Error("basis for file checking is null");
    }
    let test_abs_path = String(new Path(filepath).resolve());
    if (basis == "~") {
      basis = expanduser("~");
    }
    let basis_abs_path = String(new Path(basis).resolve());
    if (!test_abs_path.startsWith(basis_abs_path)) {
      throw new Error(`${test_abs_path} must be under ${basis_abs_path}`);
    }
    return test_abs_path;
  }
}
exposeClassAttributes(FileOfClass);
`
See class comment for details.
`;
class ConditionalLogger {
  /**
   * Constructor.
   *
   * :param logger: The wrapped logger to redirect write() calls to.
   */
  constructor(logger, env_var) {
    this.logger = logger;
    this._should_log = (process.env[env_var] ?? "true").toLowerCase() == "true";
  }
  /**
   * :return: True if this logger should log
   */
  should_log() {
    return this._should_log;
  }
  /**
   * Log 'msg % args' with severity 'DEBUG'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.debug("Houston, we have a %s", "thorny problem", exc_info=True)
   */
  debug(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.debug(msg, ...args, kwargs);
  }
  /**
   * Log 'msg % args' with severity 'INFO'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.info("Houston, we have a %s", "notable problem", exc_info=True)
   */
  info(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.info(msg, ...args, kwargs);
  }
  /**
   * Log 'msg % args' with severity 'WARNING'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.warning("Houston, we have a %s", "bit of a problem", exc_info=True)
   */
  warning(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.warning(msg, ...args, kwargs);
  }
  /**
   * Log 'msg % args' with severity 'ERROR'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.error("Houston, we have a %s", "major problem", exc_info=True)
   */
  error(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.error(msg, ...args, kwargs);
  }
  /**
   * Convenience method for logging an ERROR with exception information.
   */
  exception(msg, exc_info2 = true, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.exception(msg, ...args, { ...kwargs, exc_info: exc_info2 });
  }
  /**
   * Log 'msg % args' with severity 'CRITICAL'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.critical("Houston, we have a %s", "major disaster", exc_info=True)
   */
  critical(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.critical(msg, ...args, kwargs);
  }
  /**
   * Don't use this method, use critical() instead.
   */
  fatal(msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.fatal(msg, ...args, kwargs);
  }
  /**
   * Log 'msg % args' with the integer severity 'level'.
   *
   * To pass exception information, use the keyword argument exc_info with
   * a true value, e.g.
   *
   * logger.log(level, "We have a %s", "mysterious problem", exc_info=True)
   */
  log(level, msg, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (!this.should_log()) {
      return;
    }
    this.logger.log(level, msg, ...args, kwargs);
  }
}
exposeClassAttributes(ConditionalLogger);
;
`
See class comment for details.
`;
class SensitiveLogger extends ConditionalLogger {
  /**
   * Constructor.
   *
   * :param logger: The wrapped logger to redirect write() calls to.
   */
  constructor(logger) {
    super(logger, "LEAF_LOG_SENSITIVE");
  }
}
exposeClassAttributes(SensitiveLogger);
`
See class comment for details.
`;
class Restorer {
  /**
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: an object from some persisted store
   */
  restore(file_reference) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Restorer);
`
See class comment for details
`;
class ConfigFilter {
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
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ConfigFilter);
`
See class comment for details.
`;
class ConfigFilterChain extends ConfigFilter {
  /**
   * Constructor.
   */
  constructor() {
    super();
    this._filters = [];
  }
  /**
   * Registers a single filter with this filter chain instance.
   * The order that these calls are made matters.
   *
   * :param one_filter: a ConfigFilter to add to the filter chain.
   */
  register(one_filter) {
    this._filters.push(one_filter);
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
    let filtered = basis_config;
    let one_filter = null;
    for (const one_filter2 of this._filters) {
      filtered = one_filter2.filter_config(filtered);
    }
    return filtered;
  }
}
exposeClassAttributes(ConfigFilterChain);
class FieldExtractor {
  /**
   * :param dictionary: the dictionary in which the field
   * is supposed exist.
   * :param field_name: the fully specified field name.
   * :param default_value: a default value if the field is not found.
   * Default is null
   * :param delimiter: a delimiting character for splitting deep-dictionary
   * keys
   * :return: the value of the field in the dictionary or
   * null if the field did not exist.
   */
  get_field(dictionary, field_name, default_value = null, delimiter = ".") {
    if (dictionary == null || (!is_dict(dictionary) || field_name == null)) {
      return default_value;
    }
    if (field_name == null || !isinstance2(field_name, String)) {
      return dict.get(dictionary, field_name, default_value);
    }
    if (!contains(delimiter, field_name)) {
      return dict.get(dictionary, field_name, default_value);
    }
    let field_split = field_name.split(delimiter);
    let use_field_name = field_split[0];
    let value = dict.get(dictionary, use_field_name, null);
    if (value == null || !is_dict(value)) {
      return default_value;
    }
    let remaining_split = slice2(field_split, 1, len(field_split) + 1);
    let remaining_field = remaining_split.join(delimiter);
    let deep_value = this.get_field(value, remaining_field, default_value, delimiter);
    return deep_value;
  }
}
exposeClassAttributes(FieldExtractor);
`
See class comment for details.
`;
class DictionaryExtractor {
  /**
   * Constructor
   *
   * :param dictionary: The dictionary to operate on.
   * :param delimiter: a delimiting character for splitting deep-dictionary keys
   */
  constructor(dictionary, delimiter = ".") {
    this.my_dict = dictionary;
    this.delimiter = delimiter;
    this.extractor = new FieldExtractor();
  }
  /**
   * :param field_name: the fully specified field name.
   * :param default_value: a default value if the field is not found.
   * Default is null
   * :return: the value of the field in the dictionary or
   * null if the field did not exist.
   */
  get(field_name, default_value = null) {
    return this.extractor.get_field(this.my_dict, field_name, default_value, this.delimiter);
  }
}
exposeClassAttributes(DictionaryExtractor);
`
See class comment for details.
`;
class ConversionPolicy {
  /**
   * Constructor.
   *
   * :param reference_pruner: A ReferencePruner implementation
   * that knows how to prune/graft repeated references
   * throughout the object hierarchy
   * :param dictionary_converter: A DictionaryConverter implementation
   * that knows how to convert from a dictionary to the object type
   * in question.
   * :param pretty: a boolean which says whether the output is to be
   * nicely formatted or not.  Try for: indent=4, sort_keys=True
   */
  constructor(reference_pruner, dictionary_converter, pretty) {
    this._reference_pruner = reference_pruner;
    this._dictionary_converter = dictionary_converter;
    this._pretty = pretty;
  }
  /**
   * :return: Whether or not the output should be pretty
   */
  is_pretty() {
    return this._pretty;
  }
  /**
   * :param obj: The object to convert into a pruned dictionary
   * :return: a pruned dictionary representation of the object
   */
  convert_from_object(obj) {
    let pruned_obj = obj;
    if (this._reference_pruner != null) {
      pruned_obj = this._reference_pruner.prune(obj);
    }
    let pruned_dict = null;
    if (this._dictionary_converter != null) {
      pruned_dict = this._dictionary_converter.to_dict(pruned_obj);
    } else if (is_dict(pruned_obj)) {
      pruned_dict = pruned_obj;
    } else {
      pruned_dict = pruned_obj.this;
    }
    return pruned_dict;
  }
  /**
   * :param pruned_dict: The pruned dictionary that is to
   * be converted back into the object.
   * Can be null.
   * :return: the deserialized object
   */
  convert_to_object(pruned_dict) {
    let pruned_obj = null;
    if (this._dictionary_converter != null) {
      pruned_obj = this._dictionary_converter.from_dict(pruned_dict);
    } else {
      pruned_obj = pruned_dict;
    }
    let obj = pruned_obj;
    if (this._reference_pruner != null) {
      obj = this._reference_pruner.graft(pruned_obj);
    }
    return obj;
  }
}
exposeClassAttributes(ConversionPolicy);
`
See class comment for details.
`;
class Serializer {
  /**
   * :param obj: The object to serialize
   * :return: an open file-like object for streaming the serialized
   * bytes. , unknown file cursors should be set to the beginning
   * of the data (ala seek to the beginning).
   */
  from_object(obj) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Serializer);
`
See class comment for details.
`;
class SerializationFormat extends Serializer {
  /**
   * :param obj: The object to serialize
   * :return: an open file-like object for streaming the serialized
   * bytes. , unknown file cursors should be set to the beginning
   * of the data (ala seek to the beginning).
   */
  from_object(obj) {
    throw Error("Method not implemented");
  }
  /**
   * :param fileobj: The file-like object to deserialize.
   * It is expected that the file-like object be open
   * and be pointing at the beginning of the data
   * (ala seek to the beginning).
   *
   * After calling this method, the seek pointer
   * will be at the end of the data. Closing of the
   * fileobj is left to the caller.
   * :return: the deserialized object
   */
  to_object(fileobj) {
    throw Error("Method not implemented");
  }
  /**
   * :return: A string representing a file extension for the
   * serialization method, including the ".".
   *
   * While the parent interface allows for returning
   * lists, a SerializationFormat implementation should
   * only ever have a single file extension associated
   * with it.
   */
  get_file_extension() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(SerializationFormat);
`
See class comment for details.
`;
class JsonSerializationFormat extends SerializationFormat {
  /**
   * Constructor.
   *
   * :param reference_pruner: A ReferencePruner implementation
   * that knows how to prune/graft repeated references
   * throughout the object hierarchy
   * :param dictionary_converter: A DictionaryConverter implementation
   * that knows how to convert from a dictionary to the object type
   * in question.
   * :param pretty: a boolean which says whether the output is to be
   * nicely formatted or not.  Try for: indent=4, sort_keys=True
   */
  constructor(reference_pruner, dictionary_converter, pretty) {
    super();
    this.conversion_policy = new ConversionPolicy(reference_pruner, dictionary_converter, pretty);
  }
  /**
   * :param obj: The object to serialize
   * :return: an open file-like object for streaming the serialized
   * bytes. , unknown file cursors should be set to the beginning
   * of the data (ala seek to the beginning).
   */
  from_object(obj) {
    let pruned_dict = this.conversion_policy.convert_from_object(obj);
    let indent = null;
    let sort_keys = false;
    if (this.conversion_policy.is_pretty()) {
      indent = 4;
      sort_keys = true;
    }
    let json_str = dumps(pruned_dict, { indent, sortKeys: sort_keys });
    let byte_array = new Uint8Array(json_str, "utf-8");
    let fileobj = new BytesIO(byte_array);
    fileobj.seek(0, SEEK_SET);
    return fileobj;
  }
  /**
   * :param fileobj: The file-like object to deserialize.
   * It is expected that the file-like object be open and be
   * pointing at the beginning of the data (ala seek to the
   * beginning).
   *
   * After calling this method, the seek pointer will be at the end
   * of the data. Closing of the fileobj is left to the caller.
   * :return: the deserialized object
   */
  to_object(fileobj) {
    let pruned_dict = null;
    if (fileobj != null) {
      pruned_dict = load(fileobj);
    }
    let obj = this.conversion_policy.convert_to_object(pruned_dict);
    return obj;
  }
  /**
   * :return: A string representing a file extension for the
   * serialization method, including the ".".
   */
  get_file_extension() {
    return ".json";
  }
}
exposeClassAttributes(JsonSerializationFormat);
;
`
See class comment for details.
`;
class BytesDecoder {
  static {
    this.COMMON_ENCODINGS = ["utf-8", "cp1252", "latin-1"];
  }
  /**
   * Decodes the given Uint8Array data to a string by sequentially trying the encodings listed
   * in :attr:`COMMON_ENCODINGS` and returning as soon as one succeeds.
   *
   * With the default encodings (including ``latin-1``), this method is expected to always
   * return a decoded string, although the content may be garbled for non-text or
   * unexpectedly encoded inputs. The final ``UnicodeDecodeError`` is only raised if none
   * of the configured encodings can decode the data.
   *
   * :param bytes_data: The Uint8Array data to decode.
   * :param source_name: Optional name of the source of the Uint8Array data, used for logging purposes.
   * :return: The tuple of decoded string and the encoding used for decoding.
   */
  static decode_bytes(bytes_data, source_name) {
    const bytes = bytes_data instanceof Uint8Array ? bytes_data : new Uint8Array(bytes_data == null ? [] : bytes_data);
    const encoding_names = { "utf-8": "utf-8", "cp1252": "windows-1252", "latin-1": "iso-8859-1" };
    for (const encoding of BytesDecoder.COMMON_ENCODINGS) {
      try {
        const decoder = new TextDecoder(encoding_names[encoding] || encoding, { fatal: true });
        return [decoder.decode(bytes), encoding];
      } catch (e) {
        continue;
      }
    }
    throw new Error(`Unable to decode Uint8Array data from source '${source_name}'`);
  }
}
exposeClassAttributes(BytesDecoder);
`
See class comment for details.
`;
class HoconSerializationFormat extends JsonSerializationFormat {
  /**
   * Constructor.
   *
   * :param reference_pruner: A ReferencePruner implementation
   * that knows how to prune/graft repeated references
   * throughout the object hierarchy
   * :param dictionary_converter: A DictionaryConverter implementation
   * that knows how to convert from a dictionary to the object type
   * in question.
   * :param pretty: a boolean which says whether the output is to be
   * nicely formatted or not.  Try for: indent=4, sort_keys=True
   * :param sanitize_keys: When True, to_object() removes the quotation
   * marks that pyhocon embeds in keys that had to be quoted in
   * the HOCON source because they contain characters that are
   * special in HOCON keys -- "$", "}", "[", "]", ":", "=",
   * "+", "#", "`", "^", "?", "!", "@", "*", "&", and "." --
   * e.g. "llama3.1" or "llama3:8b".
   * Default is False, preserving the existing (quote-retaining)
   * behavior for current callers.
   */
  constructor(reference_pruner, dictionary_converter, pretty, sanitize_keys) {
    super(reference_pruner, dictionary_converter, pretty);
    this.sanitize_keys = sanitize_keys;
  }
  /**
   * :param fileobj: The file-like object to deserialize.
   * It is expected that the file-like object be open and be
   * pointing at the beginning of the data (ala seek to the
   * beginning).
   *
   * After calling this method, the seek pointer will be at the end
   * of the data. Closing of the fileobj is left to the caller.
   * :param basedir: Optional base directory for resolving include directives.
   * When provided, HOCON include paths are resolved relative to this
   * directory rather than the process working directory. Pass the
   * directory of the file being parsed so that sibling includes work
   * correctly regardless of where the server is started from.
   * :return: the deserialized object
   */
  to_object(fileobj, basedir = null) {
    let pruned_dict = null;
    if (fileobj != null) {
      let hocon_bytes = fileobj.getvalue();
      let [hocon_string, _] = BytesDecoder.decode_bytes(hocon_bytes);
      pruned_dict = ConfigFactory.parse_String(hocon_string, { basedir });
      if (pruned_dict != null && this.sanitize_keys) {
        let wrapper = new ConfigTree();
        wrapper.put("root", pruned_dict);
        pruned_dict = wrapper.as_plain_ordered_dict()["root"];
      }
      if (pruned_dict != null) {
        pruned_dict = loads(dumps(pruned_dict));
      }
    }
    let obj = this.conversion_policy.convert_to_object(pruned_dict);
    return obj;
  }
  /**
   * :return: A string representing a file extension for the
   * serialization method, including the ".".
   */
  get_file_extension() {
    return ".hocon";
  }
}
exposeClassAttributes(HoconSerializationFormat);
class StringFilter {
  /**
   * :param in_string: an input string to filter
   * :return: a filtered version of the in_string, according to implementation policy
   */
  filter(in_string) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(StringFilter);
class DictionaryValidator {
  /**
   * Validate the given dictionary
   *
   * :param candidate: The dictionary to validate
   * :return: A list of error messages
   */
  validate(candidate) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(DictionaryValidator);
class CompositeDictionaryValidator extends DictionaryValidator {
  /**
   * Constructor
   *
   * :param validators: A list of validators to use
   * :param stop_on_error: When True, return after the first validator that produces
   * errors instead of running every validator. Useful for ordering phases
   * where later validators assume earlier validators passed (e.g., shape
   * checks before semantic checks that would crash on malformed input).
   * Default False preserves the "collect all errors" behavior.
   */
  constructor(validators, stop_on_error = false) {
    super();
    this.validators = validators;
    this.stop_on_error = stop_on_error;
  }
  /**
   * Validate the agent network.
   *
   * :param candidate: The dictionary to validate
   * :return: A list of error messages
   */
  validate(candidate) {
    let errors = [];
    if (!candidate) {
      errors.push("Nothing to validate.");
      return errors;
    }
    if (this.validators == null || len(this.validators) == 0) {
      errors.push("No validation policy.");
      return errors;
    }
    for (const validator of this.validators) {
      let new_errors = validator.validate(candidate);
      errors.push(...new_errors);
      if (new_errors && this.stop_on_error) {
        break;
      }
    }
    return errors;
  }
}
exposeClassAttributes(CompositeDictionaryValidator);
`
See class comment for details.
`;
class DictionaryConverter {
  /**
   * :param obj: The object to be converted into a dictionary
   * :return: A data-only dictionary that represents all the data for
   * the given object, either in primitives
   * (booleans, ints, floats, strings), arrays, or dictionaries.
   * If obj is null, then the returned dictionary should also be
   * null.  If obj is not the correct type, it is also reasonable
   * to return null.
   */
  to_dict(obj) {
    throw Error("Method not implemented");
  }
  /**
   * :param obj_dict: The data-only dictionary to be converted into an object
   * :return: An object instance created from the given dictionary.
   * If obj_dict is null, the returned object should also be null.
   * If obj_dict is not the correct type, it is also reasonable
   * to return null.
   */
  from_dict(obj_dict) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(DictionaryConverter);
`
See class comment for details.
`;
class EventLoopFactory {
  /**
   * :return: A callable that constructs a platform-appropriate event
   * loop, or null if asyncio's default is appropriate. null is
   * the documented value asyncio.run() and asyncio.Runner()
   * accept to mean "use the default factory", so the return
   * value of this method can be forwarded unchanged on any
   * platform.
   */
  static loop_factory() {
    if (platform == "win32") {
      return SelectorEventLoop;
    }
    return null;
  }
  /**
   * :return: A newly-constructed event loop appropriate for the current
   * platform. On Windows this is a SelectorEventLoop; on other
   * platforms it is the loop type returned by
   * asyncio.new_event_loop().
   */
  static new_event_loop() {
    let factory = EventLoopFactory.loop_factory();
    if (factory != null) {
      return factory();
    }
    return new_event_loop();
  }
}
exposeClassAttributes(EventLoopFactory);
`
See class comment for details.
`;
class TaskExecutor {
  /**
   * :return: The AbstractEventLoop associated with this executor instance
   */
  get_event_loop() {
    return null;
  }
  /**
   * Starts the executor.
   * Do this separately from constructor for more control.
   */
  start() {
    throw Error("Method not implemented");
  }
  /**
   * Call initializing function on executor event loop
   * and wait for it to finish.
   * Used for setting up executor tasks run-time state before any tasks are submitted.
   * :param init_function: function to call.
   */
  initialize(init_function) {
    throw Error("Method not implemented");
  }
  /**
   * Submit a function to be run in the executor.
   * Note that the function is run in "fire and forget" mode,
   * so no result, successful or otherwise, is returned to the caller.
   *
   * :param submitter_id: A string id denoting who is doing the submitting.
   * :param function: The function handle to run
   * :param /: Positional or keyword arguments.
   * See https://realpython.com/python-asterisk-and-slash-special-parameters/
   * :param args: args for the function
   * :param kwargs: keyword args for the function
   * :return: An asyncio.Task that corresponds to the submitted task
   */
  submit(submitter_id, _function, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    throw Error("Method not implemented");
  }
  /**
   * Creates a task for the event loop given an Awaitable
   * :param awaitable: The Awaitable to create and schedule a task for
   * :param submitter_id: A string id denoting who is doing the submitting.
   * :param raise_exception: True if exceptions are to be raised in the executor.
   * Default is False.
   * :return: The Task object bound to our event loop
   */
  create_task(awaitable, submitter_id, raise_exception) {
    throw Error("Method not implemented");
  }
  /**
   * Shuts down the executor.
   * :param wait: True if we should wait for the background thread to join up.
   * False otherwise.  Default is True.
   * :param cancel_futures: Ignored? Default is False.
   */
  shutdown(wait, cancel_futures) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(TaskExecutor);
`
See class comment for details.
`;
class AsyncioThreadPoolExecutor extends ThreadPoolExecutor {
  /**
   * Constructor.
   */
  constructor(...args) {
    super(...args);
    this.running = 0;
    this.lock = new Lock();
    this.logger = getLogger(this.constructor.name);
    this.no_threads_warning_logged = false;
  }
  /**
   * Override of submit method to wrap the submitted function with additional logic
   * for counting the number of active (running) threads.
   */
  submit(fn, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    function wrapped(kw = {}, ...a) {
      const _resource = this.lock;
      try {
        this.running += 1;
      } finally {
        _resource.close?.();
      }
      try {
        return fn(...a, kw);
      } finally {
        const _resource2 = this.lock;
        try {
          this.running -= 1;
        } finally {
          _resource2.close?.();
        }
      }
    }
    return super.submit(wrapped, ...args, kwargs);
  }
  /**
   * Get number of threads in the pool and number of currently running threads.
   * :return: Tuple of (number of threads in the pool, number of currently running threads)
   * Note: number of threads in the pool is an approximation, as ThreadPoolExecutor does not provide
   * a direct way to get this information. The method tries to access the protected member _threads,
   * which may not be available in all implementations of ThreadPoolExecutor.
   */
  get_threads_metrics() {
    let num_threads = 0;
    if (hasattr2(this, "_threads")) {
      num_threads = len(this._threads);
    } else if (!this.no_threads_warning_logged) {
      this.logger.warning("ThreadPoolExecutor does not have _threads attribute, number of threads in the pool will be reported as 0");
      this.no_threads_warning_logged = true;
    }
    const _resource = this.lock;
    try {
      return num_threads;
    } finally {
      _resource.close?.();
    }
  }
}
exposeClassAttributes(AsyncioThreadPoolExecutor);
`
See class comment for details.
`;
let EXECUTOR_START_TIMEOUT_SECONDS = 5;
class AsyncioExecutor extends TaskExecutor {
  /**
   * Constructor
   */
  constructor(max_workers) {
    super();
    this._shutdown = false;
    this._thread = null;
    this._threadpool_executor = new AsyncioThreadPoolExecutor({ max_workers });
    this._loop = EventLoopFactory.new_event_loop();
    this._loop.set_exception_handler(AsyncioExecutor.loop_exception_handler);
    this._loop.set_default_executor(this._threadpool_executor);
    this._loop.set_task_factory(eager_task_factory);
    this._loop_ready = new Event();
    this._init_done = new Event();
    this._background_tasks = {};
    this._background_tasks_lock = new Lock();
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * :return: The AbstractEventLoop associated with this instance
   */
  get_event_loop() {
    return this._loop;
  }
  /**
   * Starts the background thread.
   * Do this separately from constructor for more control.
   */
  start() {
    if (this._thread != null) {
      return;
    }
    this._thread = new Thread({ target: AsyncioExecutor.loop_manager, args: tuple2(this._loop, this._loop_ready), daemon: true });
    set_event_loop(this._loop);
    this._loop.run_forever();
    this._loop_ready.set();
  }
  /**
   * Call initializing function on executor event loop
   * and wait for it to finish.
   * :param init_function: function to call.
   */
  async initialize(init_function) {
    if (this._shutdown) {
      throw new Error("Cannot schedule new calls after shutdown");
    }
    if (!this._loop.is_running()) {
      throw new Error("Loop must be started before any function can be submitted");
    }
    this._init_done.clear();
    this._loop.call_soon_threadsafe(AsyncioExecutor.run_initialization, init_function, this._init_done);
    let timeout = EXECUTOR_START_TIMEOUT_SECONDS;
    let was_set = await this._init_done.wait({ timeout });
    if (!was_set) {
      throw new Error(`FAILED to run executor initializer in ${timeout} sec`);
    }
  }
  /**
   * Run in-loop initialization
   */
  static run_initialization(init_function, init_done) {
    try {
      init_function();
    } catch (exc) {
      console.log(`Initializing function raised exception: ${exc}`);
    } finally {
      init_done.set();
    }
  }
  /**
   * Function will be called once the event loop starts
   */
  static notify_loop_ready(loop_ready) {
    loop_ready.set();
  }
  /**
   * Entry point static method for the background thread.
   *
   * :param loop: The AbstractEventLoop to use to run the event loop.
   * :param loop_ready: event notifying that loop is ready for execution.
   */
  static loop_manager(loop, loop_ready) {
    set_event_loop(loop);
    loop.call_soon(AsyncioExecutor.notify_loop_ready, loop_ready);
    loop.run_forever();
    let pending = all_tasks({ loop });
    if (pending) {
      loop.run_until_complete(gather(...pending, { return_exceptions: true }));
    }
    loop.close();
  }
  /**
   * Handles exceptions for the asyncio event loop
   *
   * DEF - I believe this exception handler is for exceptions that happen in
   * the event loop itself, *not* the submit()-ed coroutines.
   * Exceptions from the coroutines are handled by submission_done() below.
   *
   * :param loop: The asyncio event loop
   * :param context: A context dictionary described here:
   * https://docs.python.org/3/library/asyncio-eventloop.html#asyncio.loop.call_exception_handler
   */
  static loop_exception_handler(loop, context) {
    loop.default_exception_handler(context);
    let message = dict.get(context, "message", null);
    let exception = dict.get(context, "exception", null);
    let formatted_exception = format_exception(exception);
    console.log(`Event loop traceback (${message}):
${formatted_exception}`);
  }
  /**
   * :param function: The function handle
   * :param submitter_id: A string id denoting who is doing the submitting
   * :return: The fully qualified name of the function, suitable for logging/tracking
   */
  get_function_name(_function, submitter_id) {
    let function_name = null;
    try {
      function_name = _function.__qualname__;
    } catch (e) {
      function_name = _function.constructor.name;
    }
    if (submitter_id) {
      function_name = `${submitter_id}:${function_name}`;
    }
    return function_name;
  }
  /**
   * :return: True if we are currently executing in the event loop thread.
   */
  _in_executor_thread() {
    return true;
  }
  /**
   * Create a task in the event loop thread and set it as a result on the provided Future.
   * :param function: The function handle to run
   * :param task_name: The name to assign to the task
   * :param task_creation_future: The Future to set result/exception on
   * :param /: Positional or keyword arguments.
   * See https://realpython.com/python-asterisk-and-slash-special-parameters/
   * :param args: args for the function
   * :param kwargs: keyword args for the function
   */
  _create_in_loop_thread(_function, task_name, task_creation_future, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    let task = null;
    try {
      if (isawaitable(_function)) {
        task = this._loop.create_task(_function, { name: task_name });
      } else if (iscoroutinefunction(_function)) {
        let coro = _function(...args, kwargs);
        task = this._loop.create_task(coro, { name: task_name });
      } else {
        let func = partial(_function, ...args, kwargs);
        task = this._loop.create_task(to_thread(func), { name: task_name });
      }
      task_creation_future.set_result(task);
    } catch (exc) {
      task_creation_future.set_exception(exc);
    }
  }
  /**
   * Submit some executable item as a Task in executor event loop.
   * If call is from the outside of AsyncioExecutor running thread,
   * we should do it by scheduling a "task creation" task on internal event loop,
   * and then get a Future representing this creation task.
   * The result of this Future successful completion will be a Task object we have created.
   * If call is from the inside of AsyncioExecutor running thread, we can just create the Task directly
   * and set it as a result on the Future we will return to the caller.
   *
   * :param submitter_id: A string id denoting who is doing the submitting.
   * :param function: The function handle to run
   * :param /: Positional or keyword arguments.
   * See https://realpython.com/python-asterisk-and-slash-special-parameters/
   * :param args: args for the function
   * :param kwargs: keyword args for the function
   * :return: A Future object which will return a created Task in our event loop.
   */
  _submit_as_task(submitter_id, _function, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    let task_creation_future = new Future();
    let task_name = this.get_function_name(_function, submitter_id);
    if (this._in_executor_thread()) {
      this._create_in_loop_thread(_function, task_name, task_creation_future, ...args, kwargs);
      return task_creation_future;
    }
    let creation_function = partial(this._create_in_loop_thread, _function, task_name, task_creation_future, ...args, kwargs);
    this._loop.call_soon_threadsafe(creation_function);
    return task_creation_future;
  }
  /**
   * Submit a function to be run in the asyncio event loop.
   *
   * :param submitter_id: A string id denoting who is doing the submitting.
   * :param function: The function handle to run
   * :param /: Positional or keyword arguments.
   * See https://realpython.com/python-asterisk-and-slash-special-parameters/
   * :param args: args for the function
   * :param kwargs: keyword args for the function
   * :return: An asyncio.Task that corresponds to the submitted task
   */
  submit(submitter_id, _function, ...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    if (this._shutdown) {
      throw new Error("Cannot schedule new tasks after shutdown");
    }
    if (!this._loop.is_running()) {
      throw new Error("Loop must be started before any function can be submitted");
    }
    let task_creation_future = this._submit_as_task(submitter_id, _function, ...args, kwargs);
    let task = task_creation_future.result();
    this.track_task(task);
    return task;
  }
  /**
   * Creates a task for the event loop given an Awaitable
   * :param awaitable: The Awaitable to create and schedule a task for
   * :param submitter_id: A string id denoting who is doing the submitting.
   * :param raise_exception: True if exceptions are to be raised in the executor.
   * Default is False.
   * :return: The Task object bound to our event loop
   */
  create_task(awaitable, submitter_id, raise_exception) {
    if (this._shutdown) {
      throw new Error("Cannot schedule new tasks after shutdown");
    }
    if (!this._loop.is_running()) {
      throw new Error("Loop must be started before any function can be submitted");
    }
    let task_creation_future = this._submit_as_task(submitter_id, awaitable);
    let task = task_creation_future.result();
    this.track_task(task, { raise_exception });
    return task;
  }
  /**
   * :param task: The task to track
   * :param raise_exception: True if exceptions are to be raised in the executor.
   * Default is False.
   */
  track_task(task, raise_exception) {
    let task_info_dict = { "task": task, "raise_exception": raise_exception };
    let task_id = Number(task);
    this._background_tasks[task_id] = task_info_dict;
    task.add_done_callback(this.submission_done.bind(this));
    return task;
  }
  static async _cancel_and_drain(tasks) {
    let pending = [];
    for (const task of iter2(tasks)) {
      let test_task = task;
      let test_task_done = test_task.done();
      if (!test_task_done) {
        test_task.cancel("cancel-and-drain");
        pending.push(test_task);
      }
    }
    let _ = await gather(...pending, { return_exceptions: true });
  }
  /**
   * Method to cancel the currently submitted tasks for this executor.
   * :param timeout: The maximum time in seconds to cancel the current tasks
   */
  cancel_current_tasks(timeout) {
    if (!this._loop.is_running()) {
      throw new Error("Loop must be running to cancel remaining tasks");
    }
    let tasks_to_cancel = [];
    let background_tasks_save = {};
    const _resource = this._background_tasks_lock;
    try {
      background_tasks_save = this._background_tasks;
      this._background_tasks = {};
    } finally {
      _resource.close?.();
    }
    for (const task_dict of Object.values(background_tasks_save)) {
      let task = dict.get(task_dict, "task", null);
      if (task && !task.done()) {
        tasks_to_cancel.push(task);
      }
    }
    let cancel_task = run_coroutine_threadsafe(AsyncioExecutor._cancel_and_drain(tasks_to_cancel), this._loop);
    try {
      cancel_task.result(timeout);
    } catch (e) {
      this.logger.info("Timeout %f sec exceeded while cleaning up AsyncioExecutor %s", timeout, Number(this));
      throw e;
    }
  }
  /**
   * Check status of a task.
   * :param task: The Task to check
   */
  _check_task(task) {
    let task_id = Number(task);
    if (!task.done()) {
      throw new Error(`Task ${task_id} is not done, but submission_done is called.`);
    }
    if (!isinstance2(task, Task)) {
      throw new Error(`Future ${task_id} is expected to be Task.`);
    }
    let origination = task.get_name();
    if (!(task_id in this._background_tasks)) {
      this.logger.info("Task %s/%s is not present in the tasks table.", task_id, origination);
    }
  }
  /**
   * Intended as a "done_callback" method on tasks created by submit() above.
   * Does some processing on a task that has been marked as done
   * (for whatever reason).
   *
   * :param task: The Task which has completed
   */
  submission_done(task) {
    let task_id = Number(task);
    let empty = {};
    let task_info = this._background_tasks[task_id] ?? empty;
    this._check_task(task);
    let origination = task.get_name();
    try {
      let exception = task.exception();
      if (exception != null && dict.get(task_info, "raise_exception")) {
        throw exception;
      }
      if (exception == null) {
        let result = task.result();
        let _ = result;
      }
    } catch (e) {
      if (e instanceof Error) {
        this.logger.info("Task from %s took too long", origination);
      } else if (e instanceof Error) {
        this.logger.info("Task from %s was cancelled", origination);
      } else if (e instanceof Error) {
      } else if (e instanceof Error) {
        const exc = e;
        let formatted_exception = format_exception(exc);
        let sensitive_logger = new SensitiveLogger(this.logger);
        for (const line of iter2(formatted_exception)) {
          let use_line = line;
          if (line.endsWith("\n")) {
            use_line = slice2(line, void 0, -1);
          }
          sensitive_logger.info("%s", use_line);
        }
      }
    }
    const _resource = this._background_tasks_lock;
    try {
      delete this._background_tasks[task_id];
    } finally {
      _resource.close?.();
    }
  }
  /**
   * For ThreadExecutorPool used by our event loop,
   * get number of created threads and number of currently running threads.
   * :return: Tuple of (number of threads in the pool, number of currently running threads)
   */
  get_threads_metrics() {
    if (this._threadpool_executor) {
      return this._threadpool_executor.get_threads_metrics();
    }
    return 0;
  }
  /**
   * Shuts down the event loop.
   *
   * :param wait: True if we should wait for the background thread to join up.
   * False otherwise.  Default is True.
   * :param cancel_futures: Ignored? Default is False.
   */
  shutdown(wait, cancel_futures) {
    this._shutdown = true;
    this._loop.call_soon_threadsafe(this._loop.stop.bind(this._loop));
    if (wait) {
      this._thread.join();
    }
    this._thread = null;
  }
}
exposeClassAttributes(AsyncioExecutor);
`
See class comments
`;
class AsyncioExecutorPool {
  static {
    this.DEFAULT_IDLE_TIMEOUT_SECONDS = 3 * 60;
  }
  static {
    this.DEFAULT_GC_SWEEP_INTERVAL_SECONDS = 30;
  }
  /**
   * Constructor.
   * :param reuse_mode: True, if requested executor instances
   * are taken from pool of available ones (pool mode);
   * False, if requested executor instances are created new
   * and shutdown on return (backward compatible mode)
   * Note that 2 parameters below are keyword-only, to make it more explicit when configuring the GC policy.
   * :param idle_timeout_seconds: Idle time threshold in seconds. An
   * AsyncioExecutor sitting in pool_available
   * longer than this is shut down and removed
   * by the background GC thread. Only applies
   * when reuse_mode is True.
   * :param gc_sweep_interval_seconds: Interval at which the GC thread
   * checks pool_available for stale executors.
   * Stale executors linger at most one sweep
   * interval beyond the idle timeout before
   * being collected. Only applies when
   * reuse_mode is True.
   * :param max_workers: maximum number of threads to use for each AsyncioExecutor
   */
  constructor(reuse_mode, idle_timeout_seconds, DEFAULT_IDLE_TIMEOUT_SECONDS, gc_sweep_interval_seconds, DEFAULT_GC_SWEEP_INTERVAL_SECONDS, max_workers) {
    this.reuse_mode = reuse_mode;
    this.idle_timeout_seconds = idle_timeout_seconds;
    this.gc_sweep_interval_seconds = gc_sweep_interval_seconds;
    this.max_workers = max_workers;
    if (this.reuse_mode) {
      if (this.gc_sweep_interval_seconds <= 0) {
        throw new Error("gc_sweep_interval_seconds must be > 0 when reuse_mode=True");
      }
      if (this.idle_timeout_seconds < 0) {
        throw new Error("idle_timeout_seconds must be >= 0 when reuse_mode=True");
      }
    }
    this.pool_available = [];
    this.pool_used = [];
    this._returned_at = {};
    this.lock = new Lock();
    this.logger = getLogger(this.constructor.name);
    this._gc_stop_event = new Event();
    this._gc_thread = null;
    if (this.reuse_mode) {
      this._gc_thread = new Thread({ target: this._gc_loop, name: `AsyncioExecutorPool-GC-${Number(this)}`, daemon: true });
      this._gc_thread.start();
    }
    this.logger.debug("AsyncioExecutorPool created: %s reuse: %s idle_timeout: %.1fs sweep_interval: %.1fs", Number(this), String(this.reuse_mode), this.idle_timeout_seconds, this.gc_sweep_interval_seconds);
  }
  /**
   * Get active (running) executor from the pool. Does not sweep;
   * sweeping is the GC thread's responsibility. If a stale executor
   * happens to sit at the head of pool_available before the next
   * sweep, get_executor() will reuse it -- which is fine, since
   * "stale" only means "would otherwise be collected as idle".
   * :return: AsyncioExecutor instance
   */
  get_executor() {
    if (this.reuse_mode) {
      const _resource2 = this.lock;
      try {
        if (len(this.pool_available) > 0) {
          let result2 = this.pool_available.shift();
          delete this._returned_at[Number(result2)];
          this.logger.debug("Reusing AsyncioExecutor %s", Number(result2));
          this.pool_used.push(result2);
          return result2;
        }
      } finally {
        _resource2.close?.();
      }
    }
    let result = new AsyncioExecutor(this.max_workers);
    result.start();
    this.logger.debug("Creating AsyncioExecutor %s", Number(result));
    const _resource = this.lock;
    try {
      this.pool_used.push(result);
    } finally {
      _resource.close?.();
    }
    return result;
  }
  /**
   * Return AsyncioExecutor instance back to the pool of available instances.
   * Does not sweep; the GC thread handles stale collection on its own
   * schedule.
   * :param executor: AsyncioExecutor to return.
   */
  return_executor(executor) {
    const _resource = this.lock;
    try {
      if (!contains(executor, this.pool_used)) {
        throw new Error(`Returned executor ${Number(executor)} is not in the pool of used executors`);
      }
      this.pool_used.splice(this.pool_used.indexOf(executor), 1);
    } finally {
      _resource.close?.();
    }
    if (this.reuse_mode) {
      executor.cancel_current_tasks();
    } else {
      this.logger.debug("Shutting down: AsyncioExecutor %s", Number(executor));
      executor.shutdown();
    }
    if (this.reuse_mode) {
      const _resource2 = this.lock;
      try {
        this.pool_available.push(executor);
        this._returned_at[Number(executor)] = monotonic();
        this.logger.debug("Returned to pool: AsyncioExecutor %s pool size: %d", Number(executor), len(this.pool_available));
      } finally {
        _resource2.close?.();
      }
    }
  }
  /**
   * Stop the background GC thread. After this returns, the pool no
   * longer reaps idle executors. Idempotent. Executors still held in
   * pool_used or pool_available are NOT shut down here; callers that
   * want those gone should handle them explicitly.
   */
  shutdown(wait) {
    let gc_thread = null;
    const _resource = this.lock;
    try {
      gc_thread = this._gc_thread;
      if (gc_thread == null) {
        return;
      }
      this._gc_thread = null;
    } finally {
      _resource.close?.();
    }
    this._gc_stop_event.set();
    if (wait && current_thread() !== gc_thread) {
      () => join(gc_thread);
    }
  }
  /**
   * Active GC loop: sweep, then wait for either the configured
   * interval or the stop event, whichever comes first. Exits cleanly
   * when shutdown() sets the stop event.
   *
   * Exceptions from _sweep_once are logged but do not stop the loop,
   * so a single bad executor cannot leak the rest of the pool.
   */
  _gc_loop() {
    while (!this._gc_stop_event.is_set()) {
      try {
        this._sweep_once();
      } catch (exc) {
        let sensitive_logger = new SensitiveLogger(this.logger);
        sensitive_logger.warning("GC: sweep raised %s; continuing", exc, { exc_info: true });
      }
      this._gc_stop_event.wait({ timeout: this.gc_sweep_interval_seconds });
    }
  }
  _collect_executors(executors) {
    let sensitive_logger = new SensitiveLogger(this.logger);
    for (const executor of iter2(executors)) {
      try {
        sensitive_logger.debug("GC: shutting down idle AsyncioExecutor %s", Number(executor));
        executor.shutdown({ wait: true });
      } catch (exc) {
        sensitive_logger.warning("GC: shutdown failed for AsyncioExecutor %s: %s", Number(executor), exc, { exc_info: true });
      }
    }
  }
  /**
   * Identify any executors in pool_available whose idle time exceeds
   * idle_timeout_seconds, remove them from the pool, and shut them
   * down. No-op when not in reuse mode.
   *
   * pool_available is FIFO-ordered by return time (oldest at the head),
   * so the scan stops at the first non-stale entry.
   *
   * Run by the GC thread on its periodic schedule; tests may call it
   * directly with a synthetic `now` for deterministic verification.
   *
   * :param now: Optional override for the current time, in the same
   * units as time.monotonic(). Intended for tests; production
   * callers should omit this and let it default to
   * time.monotonic().
   */
  _sweep_once(now) {
    if (!this.reuse_mode) {
      return;
    }
    if (now == null) {
      now = monotonic();
    }
    let to_collect = [];
    const _resource = this.lock;
    try {
      let keep_from = 0;
      let prev_returned_at = 0;
      for (const executor of this.pool_available) {
        if (!contains(Number(executor), this._returned_at)) {
          this.logger.warning("GC: executor %s in pool_available but missing return timestamp; fixing", Number(executor));
          this._returned_at[Number(executor)] = prev_returned_at;
        }
        let returned_at = dict.get(this._returned_at, Number(executor), prev_returned_at);
        if (now - returned_at > this.idle_timeout_seconds) {
          to_collect.push(executor);
          keep_from += 1;
          prev_returned_at = returned_at;
        } else {
          break;
        }
      }
      if (keep_from > 0) {
        for (const executor of slice2(this.pool_available, void 0, keep_from)) {
          delete this._returned_at[Number(executor)];
        }
        this.pool_available.splice(0, keep_from);
      }
    } finally {
      _resource.close?.();
    }
    this._collect_executors(to_collect);
  }
  /**
   * Get metrics related to threads in the pool of executors:
   * for both collections of used and available executors,
   * get the total number of executors in this collection "executors",
   * the total number of work threads across all executors in this collection "work_threads",
   * and the total number of currently running work threads
   * across all executors in this collection "threads_running".
   */
  get_threads_metrics() {
    let available_copy = [];
    let used_copy = [];
    const _resource = this.lock;
    try {
      available_copy = copy(this.pool_available);
      used_copy = copy(this.pool_used);
    } finally {
      _resource.close?.();
    }
    let used_threads = 0;
    let used_running = 0;
    let available_threads = 0;
    let available_running = 0;
    for (const executor of iter2(used_copy)) {
      let threads, running = executor.get_threads_metrics();
      used_threads += threads;
      used_running += running;
    }
    for (const executor of iter2(available_copy)) {
      let threads, running = executor.get_threads_metrics();
      available_threads += threads;
      available_running += running;
    }
    let result_dict = { "used": { "executors": len(used_copy), "work_threads": used_threads, "threads_running": used_running }, "available": { "executors": len(available_copy), "work_threads": available_threads, "threads_running": available_running } };
    return result_dict;
  }
  /**
   * Debug helper: snapshot the asyncio tasks currently living on every
   * AsyncioExecutor in the pool's "used" list. For each executor, this
   * schedules a one-shot coroutine on that executor's event loop that
   * enumerates asyncio.all_tasks() and captures each task's name, coro
   * qualname, done/cancelled state, and suspended stack. Results are
   * collected across loops via run_coroutine_threadsafe.
   *
   * If a loop is unresponsive within per_loop_timeout_s -- for example,
   * because it is CPU-bound on a synchronous hog and cannot service any
   * new callback -- that executor's entry is marked as "unresponsive_timeout"
   * rather than blocking indefinitely. An unresponsive loop is itself a
   * strong diagnostic signal ("this loop cannot even run our probe").
   *
   * Intended for on-demand invocation from a debug endpoint or a signal
   * handler while the server is wedged. Do NOT call from performance-
   * sensitive paths: it walks every task frame on every used executor.
   *
   * :param per_loop_timeout_s: How long to wait for a single loop's
   * probe coroutine to run. Loops that don't respond by
   * then are recorded as unresponsive.
   * :return: A dict keyed by String(Number(executor)) with per-executor entries
   * describing loop status and (when responsive) the list of
   * tasks with their suspended stacks. See format_task_dump()
   * for a printable rendering.
   */
  dump_tasks_in_used_executors(per_loop_timeout_s) {
    let result = {};
    let used_snapshot = [];
    const _resource = this.lock;
    try {
      used_snapshot = list3(this.pool_used);
    } finally {
      _resource.close?.();
    }
    for (const executor of iter2(used_snapshot)) {
      let executor_key = String(Number(executor));
      let loop = executor.get_event_loop();
      if (!loop.is_running()) {
        result[executor_key] = { "loop_state": "not_running", "tasks": [] };
        continue;
      }
      let future = run_coroutine_threadsafe(AsyncioExecutorPool._collect_tasks_on_current_loop(), loop);
      try {
        let tasks = future.result({ timeout: per_loop_timeout_s });
        result[executor_key] = { "loop_state": "responded", "tasks": tasks };
      } catch (e) {
        if (e instanceof Error) {
          future.cancel();
          result[executor_key] = { "loop_state": "unresponsive_timeout", "tasks": [] };
        } else if (e instanceof Error) {
          const exc = e;
          result[executor_key] = { "loop_state": "probe_error", "error": `${type2(exc)}: ${exc}`, "tasks": [] };
        }
      }
    }
    return result;
  }
  /**
   * Probe coroutine scheduled onto each target loop. Runs inside that
   * loop's context so asyncio.all_tasks() sees every task on it; the
   * probe filters itself out of the result.
   */
  static _collect_tasks_on_current_loop() {
    let me = current_task();
    let tasks_info = [];
    for (const task of all_tasks()) {
      if (me != null && task === me) {
        continue;
      }
      let coro = task.get_coro();
      let stack_frames = [];
      for (const frame of task.get_stack()) {
        stack_frames.push({ "file": frame.f_code.co_filename, "line": frame.f_lineno, "func": frame.f_code.co_name });
      }
      tasks_info.push({ "name": task.get_name(), "coro": getattr2(coro, "__qualname__", repr2(coro)), "done": task.done(), "cancelled": task.cancelled(), "stack": stack_frames });
    }
    return tasks_info;
  }
  /**
   * Render the output of dump_tasks_in_used_executors() as a printable
   * multi-line string. Useful for logging or writing into a debug HTTP
   * response.
   *
   * :param dump: A dict returned by dump_tasks_in_used_executors().
   * :return: A human-readable multi-line string.
   */
  static format_task_dump(dump) {
    if (!dump) {
      return "(no used executors)";
    }
    let lines = [];
    for (const [executor_key, entry] of Object.entries(dump)) {
      let loop_state = dict.get(entry, "loop_state", "unknown");
      let tasks = dict.get(entry, "tasks", []);
      lines.push(`== executor ${executor_key}  loop_state=${loop_state}  tasks=${len(tasks)} ==`);
      if (loop_state == "probe_error") {
        lines.push(`   probe_error: ${dict.get(entry, "error")}`);
      }
      for (const task of iter2(tasks)) {
        lines.push(`  - name=${repr2(task["name"])}  coro=${task["coro"]}  done=${task["done"]}  cancelled=${task["cancelled"]}`);
        for (const frame of dict.get(task, "stack", [])) {
          lines.push(`      File "${frame["file"]}", line ${frame["line"]}, in ${frame["func"]}`);
        }
      }
    }
    return lines.join("\n");
  }
}
exposeClassAttributes(AsyncioExecutorPool);
class Startable {
  /**
   * Perform start up.
   */
  start() {
    throw Error("Method not implemented");
  }
  /**
   * Perform steps to stop/shut-down
   * By default this does nothing
   */
  stop() {
  }
}
exposeClassAttributes(Startable);
`
See class comment for details.
`;
class Resolver {
  /**
   * :param packages: The list of packages to search
   */
  constructor(packages) {
    this.packages = packages;
  }
  /**
   * :param class_name: The name of the class we are looking for.
   * Can be null, in which case the module is returned
   * :param module_name: The name of the module the class should be in.
   * Can be null, in which case the module name is taken
   * as the underscores version of the class name.
   * :param raise_if_not_found: When True an error will be raised that
   * the class could not be resolved.
   * :param verbose: Controls how chatty the process is. Default False.
   * :param install_if_missing: Optional name of a package to install if the module is missing.
   * :param surface_import_errors: When True, any import errors will be immediately raised.
   * By default this is false so failures in lazy loading can slip by with no noise.
   * :return: a reference to the Python class, if the class could be resolved,
   * or the module if class_name is null.
   * null otherwise.
   */
  resolve_class_in_module(class_name, module_name, raise_if_not_found, verbose, install_if_missing, surface_import_errors) {
    let use_module_name = module_name;
    if (use_module_name == null) {
      use_module_name = this.module_name_from_class_name(class_name);
    }
    let logger = getLogger(this.constructor.name);
    let messages = [];
    if (verbose) {
      logger.info("Attempting to resolve module %s", use_module_name);
    }
    let found_module = this._find_module(use_module_name, messages, install_if_missing, { surface_import_errors });
    if (found_module == null) {
      let message = `Could not find code for ${use_module_name}`;
      messages.push(message);
      for (const message2 of iter2(messages)) {
        if (verbose) {
          logger.warning(message2);
        }
      }
      if (raise_if_not_found) {
        throw new Error(String(messages));
      }
    } else if (verbose) {
      logger.info("Found module %s", use_module_name);
    }
    if (class_name == null) {
      return found_module;
    }
    let my_class = null;
    if (found_module != null) {
      my_class = getattr2(found_module, class_name);
    }
    return my_class;
  }
  /**
   * Searches for a module by name, trying each configured package in turn.
   * Also tries the module name as a top-level module if packages are configured.
   *
   * :param use_module_name: The module name to search for
   * :param messages: a list of messages where logs of failed attempts can go
   * :param install_if_missing: Optional name of a package to install if the module is missing.
   * :param surface_import_errors: When True, an exception will be raised immediately.
   * :return: The python module if found. null if not found.
   */
  _find_module(use_module_name, messages, install_if_missing, surface_import_errors) {
    if (this.packages == null) {
      return this.try_to_import_module(use_module_name, messages, { install_if_missing, surface_import_errors });
    }
    for (const _package of this.packages) {
      let fully_qualified_module = `${_package}.${use_module_name}`;
      let found_module = this.try_to_import_module(fully_qualified_module, messages, { install_if_missing, surface_import_errors });
      if (found_module != null) {
        return found_module;
      }
      let check_main_package = this.try_to_import_module(_package, messages, { install_if_missing, surface_import_errors });
      if (check_main_package != null) {
        return check_main_package;
      }
    }
    return null;
  }
  /**
   * Makes a single attempt to load a module
   *
   * :param module: The name of the module to load
   * :param messages: a list of messages where logs of failed attempts can go
   * :param install_if_missing: Optional name of a package to install if the module is missing.
   * :param surface_import_errors: When True an error will be raised that the module could not be loaded
   * :return: The python module if found. null if not found.
   */
  try_to_import_module(_module, messages, install_if_missing, surface_import_errors) {
    let found_module = null;
    let message = null;
    try {
      found_module = import_module(_module);
    } catch (exception) {
      if (exception instanceof SyntaxError) {
        message = `Module ${_module}: Couldn't load due to SyntaxError: ${String(exception)}`;
        if (surface_import_errors) {
          throw new Error(message);
        }
      } else if (exception instanceof Error) {
        message = `Module ${_module}: Couldn't load due to ImportError: ${String(exception)}`;
        message += "...\n";
        if (!install_if_missing) {
          if (!surface_import_errors) {
            message += "This might be OK if this is *not* an ImportError ";
            message += "in the file itself and the code can be found in ";
            message += "another directory";
          }
        } else {
          message += `Try pip installing the package ${install_if_missing} to get past this error.`;
        }
        let exception_pertains_to_module = _module == exception.name || _module.startsWith(`${exception.name}.`);
        let candidate_missing = isinstance2(exception, Error) && exception_pertains_to_module;
        if (surface_import_errors && !candidate_missing) {
          throw new Error(message);
        }
      } else if (exception instanceof Error) {
        message = `Module ${_module}: Couldn't load due to Exception: ${String(exception)}`;
        if (surface_import_errors) {
          throw new Error(message);
        }
      }
    }
    if (message != null) {
      messages.push(message);
    }
    return found_module;
  }
  /**
   * :param class_name: The class name whose module name we are looking for
   * :return: the snake-case module name
   */
  module_name_from_class_name(class_name) {
    let sub_expr = sub("(.)([A-Z][a-z]+)", "$1_$2", class_name);
    let module_name = sub("([a-z0-9])([A-Z])", "$1_$2", sub_expr).toLowerCase();
    return module_name;
  }
}
exposeClassAttributes(Resolver);
`
See class comment for details.
`;
class ResolverUtil {
  /**
   * Resolves the class_name to instantiate an instance of the class.
   * Goes through some standard checking with standard exceptions thrown
   * to make sure the class is set up the way we want it.
   *
   * :param class_name: The fully qualified class name to instantiate
   * :param class_name_source: A string description of where we are getting the value of
   * class_name, so that exceptions can be more instructive.
   * :param type_of_class: The type that the instance must be in order to pass muster.
   * :param surface_import_errors: Raise an exception if the class cannot be instantiated.
   * By default this is True, because we assume that if we can't get the instance
   * it is because of an import error and the user will need to know why it didn't work.
   * :return: An instance of the class referred to by class_name if everything is successful.
   * Can return null if class_name is a null or empty string.
   */
  static create_instance(class_name, class_name_source, type_of_class, surface_import_errors) {
    let instance = null;
    let class_reference = ResolverUtil.create_class(class_name, class_name_source, type_of_class, { surface_import_errors });
    if (class_reference == null) {
      return null;
    }
    try {
      instance = class_reference();
    } catch (exception) {
      throw new Error(`Class '${class_name}' from ${class_name_source} must have a no-args constructor`);
    }
    return instance;
  }
  /**
   * Resolves a fully qualified class name string into an actual Python class object.
   *
   * This method expects the input string to follow the format:
   * '<package>.<module>.<ClassName>' and uses a Resolver to dynamically
   * locate and return the class object.
   *
   * :param class_name: The fully qualified name of the class to resolve.
   * :param class_name_source: A description of the source of the class_name string,
   * used for clearer error messages.
   * :param type_of_class: Base type or interface the class must inherit from.
   * :param surface_import_errors: Raise an exception if the class cannot be resolved
   * :return: The resolved class object. Can return null if class_name is a null or empty string.
   */
  static create_class(class_name, class_name_source, type_of_class, surface_import_errors) {
    if (class_name == null || len(class_name) == 0) {
      return null;
    }
    let value_error_message = `Value from ${class_name_source} '${class_name}' must be of the form <package_name>.<module_name>.<ClassName> or <package_name>.<ClassName> `;
    let class_split = class_name.split(".");
    if (len(class_split) < 2) {
      throw new Error(value_error_message);
    }
    let packages = [];
    let module_name = null;
    if (len(class_split) <= 2) {
      packages = [class_split[0]];
      module_name = class_split[0];
    } else {
      let class_list = slice2(class_split, void 0, -2);
      let class_join = class_list.join(".");
      packages = [class_join];
      module_name = at2(class_split, -2);
    }
    let new_class_name = at2(class_split, -1);
    let resolver = new Resolver(packages);
    let class_reference = null;
    try {
      class_reference = resolver.resolve_class_in_module(new_class_name, { module_name, surface_import_errors });
    } catch (exception) {
      throw new Error(`Class '${new_class_name}' from ${class_name_source} not found in PYTHONPATH`);
    }
    if (!issubclass(class_reference, type_of_class)) {
      throw new Error(`Class ${new_class_name} in ${class_name_source} must be a subclass of ${type_of_class.name}`);
    }
    return class_reference;
  }
  /**
   * :param fully_qualified_name: The fully qualified name of the class to create
   * :param raise_if_not_found: Raise an exception if the class is not found when True.
   * :param install_if_missing: The pip package to install if the class is not found
   * :return: The class referenced (*not* an instance of the class).
   * Can return null if the class is not found and raise_if_not_found is False.
   */
  static create_type(fully_qualified_name, raise_if_not_found, install_if_missing) {
    if (!fully_qualified_name) {
      return null;
    }
    let name_split = fully_qualified_name.split(".");
    let module_list = slice2(name_split, void 0, -1);
    let module_name = module_list.join(".");
    let class_name = at2(name_split, -1);
    let resolver = new Resolver();
    let class_type = resolver.resolve_class_in_module(class_name, { module_name, raise_if_not_found, install_if_missing });
    return class_type;
  }
  /**
   * Creates a tuple of class types for use in isinstance(obj, <tuple_of_types>)
   * situations.
   *
   * :param type_list: A list of fully qualified names of the types to create
   * (not class instances) to the string name of the package to install
   * if the class is not found.
   * :return: A tuple of the class types that could be resolved.
   * Can return an empty tuple if nothing in the type_list could be resolved
   */
  static create_type_tuple(type_list) {
    if (!type_list) {
      return tuple2();
    }
    let tuple_list = [];
    for (const class_name of iter2(type_list)) {
      let one_type = ResolverUtil.create_type(class_name, { raise_if_not_found: false, install_if_missing: null });
      if (one_type != null) {
        tuple_list.push(one_type);
      }
    }
    return tuple2(tuple_list);
  }
}
exposeClassAttributes(ResolverUtil);
class ConfigUtil {
  /**
   * Read a boolean-valued config entry, accepting common boolean-like
   * forms found in configs sourced from HOCON, JSON, or environment
   * variables.
   *
   * Recognized inputs:
   * - bool: returned as-is.
   * - str: case-insensitive match against "true"/"yes" -> True;
   * case-insensitive match against "false"/"no" -> False.
   * - int: 0 -> False, any other number -> True. (Note: boolean is checked
   * first; Python's True/False would otherwise match the int
   * branch since boolean is a subclass of int.)
   *
   * When the key is absent OR the value is present but not in one of
   * the recognized forms (e.g. null, list, dict, an unrecognized
   * string), the supplied `default` is returned. This makes the helper
   * safe to call against partially-specified configs without having to
   * pre-validate them.
   *
   * :param config: The config dict to read from.
   * :param key: The key whose value should be interpreted as a bool.
   * :param default: The value to return when the key is missing or its
   * value is not a recognized boolean-like form.
   * :return: The boolean interpretation of config[key], or default.
   */
  static get_bool(config, key, _default) {
    if (!contains(key, config)) {
      return _default;
    }
    let value = config[key];
    if (isinstance2(value, Boolean)) {
      return value;
    }
    if (isinstance2(value, String)) {
      let string_value = value;
      let lowered = string_value.trim().toLowerCase();
      if (contains(lowered, tuple2("true", "yes"))) {
        return true;
      }
      if (contains(lowered, tuple2("false", "no"))) {
        return false;
      }
      return _default;
    }
    if (isinstance2(value, Number)) {
      return value != 0;
    }
    return _default;
  }
}
exposeClassAttributes(ConfigUtil);
class ExceptionUtil {
  /**
   * Recursively extract detailed information from nested exceptions.
   *
   * This function handles both regular exceptions and AggregateError instances
   * which can contain multiple nested exceptions.
   * It creates a human-readable, hierarchical representation of all exceptions
   * in the error chain.
   *
   * :param exception: The exception to analyze. Can be any Error type,
   * including AggregateError instances that contain multiple
   * nested exceptions.
   * :param indent: The current indentation level for formatting.
   * Each recursive call increases this by 1 to create
   * a visual hierarchy. Defaults to 0.
   *
   * :return: A formatted string containing the exception type, message, and
   * any nested sub-exceptions with proper indentation to show the
   * hierarchy. Each line ends with a newline character.
   *
   * This function is particularly useful for debugging MCP (Model Context Protocol)
   * errors and other complex exception scenarios where multiple errors can occur
   * simultaneously and get wrapped in AggregateError containers.
   */
  static get_exception_details(exception, indent) {
    let spaces = "";
    for (const _ of range2(indent)) {
      spaces += "  ";
    }
    let message = `${spaces}${type2(exception)}: ${exception}
`;
    if (isinstance2(exception, AggregateError)) {
      for (const [i, sub_exc] of enumerate2(exception.exceptions)) {
        message += `${spaces}Sub-exception ${i + 1}:
`;
        message += ExceptionUtil.get_exception_details(sub_exc, indent + 1);
      }
    }
    return message;
  }
}
exposeClassAttributes(ExceptionUtil);
`
See class comment for details.
`;
class Persistor {
  /**
   * Persists the object passed in.
   *
   * :param obj: an object to persist
   * :param file_reference: The file reference to use when persisting.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return an object describing the location to which the object was persisted
   */
  persist(obj, file_reference) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Persistor);
`
See class comment for details.
`;
class Persistence extends Persistor {
  /**
   * Persists the object passed in.
   *
   * :param obj: an object to persist
   * :param file_reference: The file reference to use when persisting.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return an object describing the location to which the object was persisted
   */
  persist(obj, file_reference) {
    throw Error("Method not implemented");
  }
  /**
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: an object from some persisted store
   */
  restore(file_reference) {
    throw Error("Method not implemented");
  }
  /**
   * :return: A string representing a file extension for the
   * serialization method, including the ".",
   * *or* a list of these strings that are considered valid
   * file extensions.
   */
  get_file_extension() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Persistence);
`
See class comment for details.
`;
class PassThroughDictionaryConverter extends DictionaryConverter {
  /**
   * Constructor.
   *
   * :param allow_restore_none: When True (the default), null values are
   * allowed to come back from restore() when there is no dictionary
   * as input.  When False, the same case has restore() returning
   * an empty dictionary.
   */
  constructor(allow_restore_none) {
    super();
    this.allow_restore_none = allow_restore_none;
  }
  /**
   * :param obj: The object to be converted into a dictionary
   * :return: A data-only dictionary that represents all the data for
   * the given object, either in primitives
   * (booleans, ints, floats, strings), arrays, or dictionaries.
   * If obj is null, then the returned dictionary should also be
   * null.  If obj is not the correct type, it is also reasonable
   * to return null.
   */
  to_dict(obj) {
    return obj;
  }
  /**
   * :param obj_dict: The data-only dictionary to be converted into an object
   * :return: An object instance created from the given dictionary.
   * By default, if obj_dict is null, then the returned object will
   * also be null.  If obj_dict is not the correct type, it is also
   * reasonable to return null.  However, if allow_restore_none is
   * False, then these null cases will return an empty dictionary.
   */
  from_dict(obj_dict) {
    if (obj_dict == null || !is_dict(obj_dict)) {
      obj_dict = null;
      if (!this.allow_restore_none) {
        obj_dict = {};
      }
    }
    return obj_dict;
  }
}
exposeClassAttributes(PassThroughDictionaryConverter);
`
See class comment for details
`;
class AbstractEasyPersistence extends Persistence {
  /**
   * Constructor.
   *
   * :param serialization_format: The format name from
   * SerializationFormats to use
   * :param base_name: The base name of the file.
   * This does *not* include the ".txt" extension.
   * :param folder: The folder in which the file is to be persisted.
   * :param must_exist: Default False.  When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :param object_type: A string indicating the type of object to be
   * persisted. "string" by default.
   * :param dictionary_converter: An implementation of a DictionaryConverter
   * to use when converting the yaml to/from a dictionary.
   * Default value of null implies that a
   * PassThroughDictionaryConverter will be used, which does not
   * modify the dictionary at all.
   * :param use_file_extension: Use the provided string instead of the
   * standard file extension for the format. Default is null,
   * indicating the standard file extension for the format should
   * be used.
   * :param full_ref: A full file reference to be broken apart into
   * consituent pieces for purposes of persistence.
   * :param persistence_mechanism: By default, use
   * PersistenceMechanisms.LOCAL
   */
  constructor(serialization_format, base_name, folder, must_exist, object_type, dictionary_converter, use_file_extension, full_ref, persistence_mechanism) {
    super();
    let use_dictionary_converter = dictionary_converter;
    if (dictionary_converter == null && object_type == "dict") {
      use_dictionary_converter = new PassThroughDictionaryConverter();
    }
    let factory = new PersistenceFactory({ object_type, dictionary_converter: use_dictionary_converter });
    this.persistence = factory.create_persistence(folder, base_name, { persistence_mechanism, serialization_format, must_exist, use_file_extension, full_ref });
  }
  /**
   * Persists the object passed in.
   *
   * :param obj: an object to persist
   * :param file_reference: An optional file reference string to override
   * any file settings fixed at construct time. Default of null
   * indicates to resort to implementation's fixed file reference
   * settings.
   */
  persist(obj, file_reference) {
    return this.persistence.persist(obj, file_reference);
  }
  /**
   * :param file_reference: An optional file reference string to override
   * any file settings fixed at construct time. Default of null
   * indicates to resort to implementation's fixed file reference
   * settings.
   * :return: an object from some persisted store as specified
   * by the constructor.  If must_exist is False,
   * this method can return null.
   */
  restore(file_reference) {
    let obj = this.persistence.restore(file_reference);
    return obj;
  }
  /**
   * :param file_reference: An optional file reference string to override
   * any file settings fixed at construct time. Default of null
   * indicates to resort to implementation's fixed file reference
   * settings.
   * :return: The full file reference of what is to be persisted
   */
  get_file_reference(file_reference) {
    let filename = this.persistence.get_file_reference(file_reference);
    return filename;
  }
  /**
   * :return: A string representing a file extension for the
   * serialization method, including the ".",
   * *or* a list of these strings that are considered valid
   * file extensions.
   */
  get_file_extension() {
    return this.persistence.get_file_extension();
  }
}
exposeClassAttributes(AbstractEasyPersistence);
class SerializationFormats {
  static {
    this.GZIP = "gzip";
  }
  static {
    this.HOCON = "hocon";
  }
  static {
    this.JSON = "json";
  }
  static {
    this.JSON_GZIP = `${JSON}_${SerializationFormats.GZIP}`;
  }
  static {
    this.RAW_BYTES = "raw_bytes";
  }
  static {
    this.TEXT = "text";
  }
  static {
    this.YAML = "yaml";
  }
  static {
    this.SERIALIZATION_FORMATS = [SerializationFormats.HOCON, SerializationFormats.JSON, SerializationFormats.JSON_GZIP, SerializationFormats.RAW_BYTES, SerializationFormats.TEXT, SerializationFormats.YAML];
  }
}
exposeClassAttributes(SerializationFormats);
;
`
See class comment for details
`;
class EasyHoconPersistence extends AbstractEasyPersistence {
  /**
   * Constructor.
   *
   * :param base_name: The base name of the file.
   * This does *not* include the ".hocon" extension.
   * :param folder: The folder in which the file is to be persisted.
   * :param must_exist: Default False.  When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :param object_type: A string indicating the type of object to be
   * persisted. "dict" by default.
   * :param dictionary_converter: An implementation of a DictionaryConverter
   * to use when converting the Hocon to/from a dictionary.
   * Default value of null implies that a
   * PassThroughDictionaryConverter will be used, which does not
   * modify the dictionary at all.
   * :param use_file_extension: Use the provided string instead of the
   * standard file extension for the format. Default is null,
   * indicating the standard file extension for the format should
   * be used.
   * :param full_ref: A full file reference to be broken apart into
   * consituent pieces for purposes of persistence.
   */
  constructor(base_name = null, folder = ".", must_exist = false, object_type = "dict", dictionary_converter = null, use_file_extension = null, full_ref = null) {
    super(SerializationFormats.HOCON, {
      base_name,
      folder,
      must_exist,
      object_type,
      dictionary_converter,
      use_file_extension,
      full_ref
    });
  }
}
exposeClassAttributes(EasyHoconPersistence);
;
`
See class comment for details
`;
class EasyJsonPersistence extends AbstractEasyPersistence {
  /**
   * Constructor.
   *
   * :param base_name: The base name of the file.
   * This does *not* include the ".json" extension.
   * :param folder: The folder in which the file is to be persisted.
   * :param must_exist: Default False.  When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :param object_type: A string indicating the type of object to be
   * persisted. "dict" by default.
   * :param dictionary_converter: An implementation of a DictionaryConverter
   * to use when converting the JSON to/from a dictionary.
   * Default value of null implies that a
   * PassThroughDictionaryConverter will be used, which does not
   * modify the dictionary at all.
   * :param use_file_extension: Use the provided string instead of the
   * standard file extension for the format. Default is null,
   * indicating the standard file extension for the format should
   * be used.
   * :param full_ref: A full file reference to be broken apart into
   * consituent pieces for purposes of persistence.
   */
  constructor(base_name = null, folder = ".", must_exist = false, object_type = "dict", dictionary_converter = null, use_file_extension = null, full_ref = null) {
    super(SerializationFormats.JSON, {
      base_name,
      folder,
      must_exist,
      object_type,
      dictionary_converter,
      use_file_extension,
      full_ref
    });
  }
}
exposeClassAttributes(EasyJsonPersistence);
;
`
See class comment for details
`;
class EasyYamlPersistence extends AbstractEasyPersistence {
  /**
   * Constructor.
   *
   * :param base_name: The base name of the file.
   * This does *not* include the ".yaml" extension.
   * :param folder: The folder in which the file is to be persisted.
   * :param must_exist: Default False.  When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :param object_type: A string indicating the type of object to be
   * persisted. "dict" by default.
   * :param dictionary_converter: An implementation of a DictionaryConverter
   * to use when converting the yaml to/from a dictionary.
   * Default value of null implies that a
   * PassThroughDictionaryConverter will be used, which does not
   * modify the dictionary at all.
   * :param use_file_extension: Use the provided string instead of the
   * standard file extension for the format. Default is null,
   * indicating the standard file extension for the format should
   * be used.
   * :param full_ref: A full file reference to be broken apart into
   * consituent pieces for purposes of persistence.
   */
  constructor(base_name = null, folder = ".", must_exist = false, object_type = "dict", dictionary_converter = null, use_file_extension = null, full_ref = null) {
    super(SerializationFormats.YAML, {
      base_name,
      folder,
      must_exist,
      object_type,
      dictionary_converter,
      use_file_extension,
      full_ref
    });
  }
}
exposeClassAttributes(EasyYamlPersistence);
class ConfigHandler {
  /**
   * Main entry point for reading config files
   * :param config_source: Either a string filename reference to a
   * config dictionary to be read from the file, or
   * a config dictionary in and of itself
   * :param default_config: A config dictionary to be used as a default.
   * Default is null, indicating that no defaults are to be
   * applied when reading from the config_source.
   * When a dictionary is supplied, the default_config is used
   * as a basis for which any new config parameters read
   * from the config_source are overlayed on top of.
   * :param must_exist: Default True.  When True, an error is
   * raised when the file does not exist upon config
   * reading via a Persistor restore() method.
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   */
  import_config(config_source, default_config, must_exist) {
    let config = {};
    if (default_config != null && is_dict(default_config)) {
      config = deepcopy(default_config);
    }
    let update_source = {};
    if (isinstance2(config_source, String)) {
      update_source = this.read_config_from_file(config_source, must_exist);
    } else if (is_dict(config_source)) {
      update_source = config_source;
    }
    let new_config = this.deep_update(config, update_source);
    return new_config;
  }
  /**
   * Performs overlay functionality
   * DEF: Use DictionaryOverlay class instead.
   */
  deep_update(dest, source) {
    let key = null;
    let value = null;
    for (const [key2, value2] of Object.entries(source)) {
      if (is_dict(value2)) {
        let recurse = this.deep_update(dict.get(dest, key2, {}), value2);
        dest[key2] = recurse;
      } else {
        dest[key2] = source[key2];
      }
    }
    return dest;
  }
  /**
   * :param filepath: The file to parse
   * :param must_exist: When True, an error is
   * raised when the file does not exist upon config
   * reading via a Persistor restore() method.
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :return: The dictionary parsed from the config file
   */
  read_config_from_file(filepath, must_exist) {
    let file_extension_to_parser_map = { ".conf": "parse_hocon", ".hocon": "parse_hocon", ".json": "parse_json", ".properties": "parse_hocon", ".yaml": "parse_yaml" };
    let parser = null;
    let file_extension = null;
    for (const file_extension2 of list3(Object.keys(file_extension_to_parser_map))) {
      if (filepath.endsWith(file_extension2)) {
        parser = dict.get(file_extension_to_parser_map, file_extension2);
      }
    }
    let message = `Could not read ${filepath} as config. Unknown file extension.`;
    let config = {};
    if (parser != null) {
      config = this.parse_with_method(parser, filepath, must_exist);
    } else if (must_exist) {
      throw new Error(message);
    } else {
      console.log(message);
      config = {};
    }
    return config;
  }
  /**
   * :param parser: The parser method on this class to use
   * :param filepath: The file to parse
   * :param must_exist: When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :return: The dictionary parsed from the config file
   */
  parse_with_method(parser, filepath, must_exist) {
    let config = null;
    if (parser == "parse_hocon") {
      config = this.parse_hocon(filepath, must_exist);
    } else if (parser == "parse_json") {
      config = this.parse_json(filepath, must_exist);
    } else if (parser == "parse_yaml") {
      config = this.parse_yaml(filepath, must_exist);
    }
    return config;
  }
  /**
   * :param filepath: The json file to parse
   * :param must_exist: When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :return: The dictionary parsed from the hocon config file
   */
  parse_json(filepath, must_exist) {
    let persistence = new EasyJsonPersistence({ full_ref: filepath, must_exist });
    let config = persistence.restore(null);
    return config;
  }
  /**
   * :param filepath: The hocon file to parse
   * :param must_exist: When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :return: The dictionary parsed from the hocon config file
   */
  parse_hocon(filepath, must_exist) {
    let persistence = new EasyHoconPersistence({ full_ref: filepath, must_exist });
    let config = persistence.restore(null);
    return config;
  }
  /**
   * :param filepath: The yaml file to parse
   * :param must_exist: When True, an error is
   * raised when the file does not exist upon restore()
   * When False, the lack of a file to restore from is
   * ignored and a dictionary value of null is returned
   * :return: The dictionary parsed from the yaml config file
   */
  parse_yaml(filepath, must_exist) {
    let persistence = new EasyYamlPersistence({ full_ref: filepath, must_exist });
    let config = persistence.restore(null);
    return config;
  }
}
exposeClassAttributes(ConfigHandler);
let _SERVICE_OLD_FACTORY = null;
let _DEFAULT_EXTRA_LOGGING_FIELDS_DICT = {};
let _SERVICE_LOGGING_FIELDS_KEY = "service_logging_fields_dict";
function _service_log_record_factory(...args) {
  const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
  let log_record = _SERVICE_OLD_FACTORY(...args, kwargs);
  let my_current_thread = current_thread();
  let thread_dict = my_current_thread.this;
  let logging_fields_dict = _DEFAULT_EXTRA_LOGGING_FIELDS_DICT;
  if (contains(_SERVICE_LOGGING_FIELDS_KEY, thread_dict)) {
    logging_fields_dict = thread_dict[_SERVICE_LOGGING_FIELDS_KEY];
  }
  let log_record_dict = log_record.this;
  Object.assign(log_record_dict, logging_fields_dict);
  return log_record;
}
class ServiceLogRecord {
  /**
   * Constructor.
   *
   * :param logging_fields_dict: Dictionary with thread-specific information
   * for logging, whose keys will become attributes on a LogRecord.
   * By default this is null, implying that an empty dictionary
   * will be initially created as a placeholder for the thread's
   * additional log messaging fields.
   */
  constructor(logging_fields_dict) {
    let my_current_thread = current_thread();
    let thread_dict = my_current_thread.this;
    let use_dict = logging_fields_dict;
    if (use_dict == null) {
      use_dict = {};
    }
    this.thread_local_dict = use_dict;
    thread_dict[_SERVICE_LOGGING_FIELDS_KEY] = this.thread_local_dict;
  }
  /**
   * Called early on in the lifetime of a service to redirect the standard
   * Python LogRecord creation to our _record_factory() call at the top
   * of the file.
   *
   * This needs to be called once by a service before any constructor of
   * this class is called or message is logged.
   */
  static async set_up_record_factory(default_extra_logging_fields = null) {
    if (_SERVICE_OLD_FACTORY == null) {
      _SERVICE_OLD_FACTORY = getLogRecordFactory();
    }
    if (default_extra_logging_fields != null) {
      _DEFAULT_EXTRA_LOGGING_FIELDS_DICT = copy(default_extra_logging_fields);
    }
    setLogRecordFactory(_service_log_record_factory);
  }
  /**
   * :return: The dictionary previously passed into set_up_record_factory()
   */
  static async get_default_extra_logging_fields() {
    let default_extra_logging_fields = copy(_DEFAULT_EXTRA_LOGGING_FIELDS_DICT);
    return default_extra_logging_fields;
  }
  /**
   * Called once when a service request is initiated.
   *
   * :param logging_fields_dict:  The thread-specific dictionary containing
   * logging fields that will be added to each LogRecord produced.
   */
  set_logging_fields_dict(logging_fields_dict) {
    Object.assign(this.thread_local_dict, logging_fields_dict);
  }
}
exposeClassAttributes(ServiceLogRecord);
`
See class comment for details.
`;
class StreamToLogger extends StringIO {
  /**
   * Constructor.
   *
   * :param logger: The logger to redirect write() calls to.
   * :param log_level: The integer logging level at which the writes() will be
   * written.  Default is logging.INFO.
   */
  constructor(logger, log_level, INFO2) {
    super();
    this.logger = logger;
    this.log_level = log_level;
    this.last_logged = [];
    this.last_num_lines_logged = [];
  }
  /**
   * Write the string s to the stream and return the number of characters
   * written.  The "stream" in this case is really any set of logging
   * handlers set up by LoggingSetup. , unknown one of these can be stdout,
   * which this method is meant to subvert.
   *
   * :param s: the string to write to the log
   * :return: the number of characters written
   */
  write(s) {
    let stripped = s.trimEnd();
    let lines = stripped.split(/\r?\n/);
    let num_lines = len(lines);
    let exception_type, exception_value, _ = exc_info();
    let dont_log_1 = len(this.last_num_lines_logged) > 0;
    let dont_log_2 = dont_log_1 && at2(this.last_num_lines_logged, -1) == num_lines;
    let dont_log_3 = dont_log_2 && contains(at2(this.last_logged, -1), stripped);
    let dont_log_4 = dont_log_3 || exception_type == Error || exception_type == Error || exception_type == Error && String(exception_value) == String(EPIPE);
    let dont_log = dont_log_4 || num_lines > 0 && lines[0].startsWith("--- Logging error ---");
    if (dont_log) {
      return 0;
    }
    this.last_logged.push(stripped);
    this.last_num_lines_logged.push(num_lines);
    for (const line of iter2(lines)) {
      let line_to_write = line.trimEnd();
      this.logger.log(this.log_level, line_to_write);
    }
    this.last_logged.pop();
    this.last_num_lines_logged.pop();
    let num_chars = len(s);
    return num_chars;
  }
  /**
   * Subverts stdout and stderr to separate instances of the python logger
   * for this class.
   * :param logger: The logger to use for subverting stdout and stderr
   * By default this is null, indicating a new logger
   * will be based off this class.
   * :param reroute_stdout: True if stdout should be rerouted to the
   * StreamToLogger.  False otherwise
   * :param reroute_stderr: True if stderr should be rerouted to the
   * StreamToLogger.  False otherwise
   */
  static subvert(logger, reroute_stdout, reroute_stderr) {
    let use_logger = logger;
    if (use_logger == null) {
      use_logger = getLogger(this.name);
    }
    let info_stream_logger = new StreamToLogger(use_logger, INFO);
    if (reroute_stdout) {
    }
    let error_stream_logger = new StreamToLogger(use_logger, ERROR);
    if (reroute_stderr) {
    }
  }
}
exposeClassAttributes(StreamToLogger);
const API = INFO + 7;
const METRICS = INFO + 5;
addLevelName(API, "API");
addLevelName(METRICS, "METRICS");
class MessageType {
  static {
    this.OTHER = "Other";
  }
  static {
    this.ERROR = "Error";
  }
  static {
    this.WARNING = "Warning";
  }
  static {
    this.METRICS = "Metrics";
  }
  static {
    this.API = "API";
  }
}
exposeClassAttributes(MessageType);
let _STRUCTURED_OLD_FACTORY = null;
function _structured_log_record_factory(...args) {
  const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
  const log_record = _STRUCTURED_OLD_FACTORY(...args, kwargs);
  let message_type = null;
  if (log_record.exc_info != null) {
    message_type = MessageType.ERROR;
  } else if (log_record.levelno == CRITICAL) {
    message_type = MessageType.ERROR;
  } else if (log_record.levelno == ERROR) {
    message_type = MessageType.ERROR;
  } else if (log_record.levelno == WARNING) {
    message_type = MessageType.WARNING;
  } else if (log_record.levelno == API) {
    message_type = MessageType.API;
  } else if (log_record.levelno == METRICS) {
    message_type = MessageType.METRICS;
  } else if (log_record.levelno == INFO) {
    message_type = MessageType.OTHER;
  } else if (log_record.levelno == DEBUG) {
    message_type = MessageType.OTHER;
  } else {
    message_type = MessageType.OTHER;
  }
  log_record.message_type = message_type.value;
  const log_timestamp_since_epoch = log_record.created;
  const log_datetime = fromTimestamp(log_timestamp_since_epoch);
  const iso_timestamp = log_datetime.isoformat();
  log_record.iso_timestamp = iso_timestamp;
  return log_record;
}
class StructuredLogRecord {
  /**
   * Called early on in the lifetime of a service to redirect the standard
   * Python LogRecord creation to our _record_factory() call at the top
   * of the file.
   *
   * This needs to be called once by a service before any constructor of
   * this class is called or message is logged.
   */
  static async set_up_record_factory() {
    if (_STRUCTURED_OLD_FACTORY == null) {
      _STRUCTURED_OLD_FACTORY = getLogRecordFactory();
    }
    setLogRecordFactory(_structured_log_record_factory);
  }
}
exposeClassAttributes(StructuredLogRecord);
`
See class comment for details.
`;
class LoggingSetup {
  /**
   * Constructor.
   *
   * :param default_log_config_dir: Directory on filesystem where the logging
   * configuration file lives.  Default is current directory.
   * :param default_log_config_file: The default name of the logging
   * configuration file.  Default is 'logging.json'
   * :param default_log_level: The default log level if no config file found.
   * Default is 'DEBUG'
   * :param log_config_env: Environment variable name from which
   * to get a potential override of the
   * previously mentioned coded defaults config file.
   * Default is null, indicating no override is
   * possible.
   * :param log_level_env: Environment variable name from which
   * to get a potential override of the
   * previously mentioned coded default log level.
   * Default is null, indicating no override is
   * possible.
   * :param log_file: The actual file to log to.
   * This overrides anything in the config.
   * Default is null - no override.
   * :param logging_config: Config reference. Can be file or dictionary
   * Default is null, implying use everything else above.
   * :param source_anchor: object whose source file is the anchor
   * for relative paths. Default is null, implying
   * this the current working directory.
   * :param default_logger_name:  The name of the logger to use
   * for default print diversion.
   */
  constructor(default_log_config_dir, default_log_config_file, default_log_level, log_config_env, log_level_env, log_file, logging_config, source_anchor, default_logger_name) {
    this.default_log_config_dir = default_log_config_dir;
    this.default_log_config_file = default_log_config_file;
    this.default_log_level = default_log_level;
    this.log_config_env = log_config_env;
    this.log_level_env = log_level_env;
    this.log_file = log_file;
    this.logging_config = logging_config;
    this.source_anchor = source_anchor;
    this.default_logger_name = default_logger_name;
  }
  /**
   * Sets up logging while diverting stdout/err to the
   * logger for the source anchor.
   *
   * :return: the logger used for diversion
   */
  setup_with_diversion() {
    this.setup();
    let logger_name = this.default_logger_name;
    if (logger_name == null) {
      logger_name = "default";
      if (this.source_anchor != null) {
        logger_name = this.source_anchor.constructor.name;
      }
    }
    let logger = getLogger(logger_name);
    let log_level = this.determine_log_level();
    logger.setLevel(log_level);
    StreamToLogger.subvert({ logger, reroute_stdout: true, reroute_stderr: true });
    console.log("Print statements diverted to logger");
    return logger;
  }
  /**
   * Actually set up the logging per the parameters in the constructor.
   */
  setup() {
    let config = this.logging_config;
    let log_config_file_path = this.determine_log_config_file_path();
    if (log_config_file_path != null) {
      let config_handler = new ConfigHandler();
      config = config_handler.import_config(log_config_file_path);
    }
    if (config != null && is_dict(config)) {
      config = this.replace_log_file(config);
      dictConfig(config);
    } else {
      let log_level = this.determine_log_level();
      basicConfig({ filename: this.log_file, level: log_level });
    }
  }
  /**
   * Determine the path of the log config file based on constructor args.
   * :return: a single string path to the log file
   */
  determine_log_config_file_path() {
    let default_logging_config_file = join(this.default_log_config_dir, this.default_log_config_file);
    if (this.logging_config != null) {
      if (is_dict(this.logging_config)) {
        return null;
      }
      if (isinstance2(this.logging_config, String)) {
        default_logging_config_file = this.logging_config;
      }
    }
    let log_config_file_path = default_logging_config_file;
    if (this.log_config_env != null) {
      log_config_file_path = dict.get(process.env, this.log_config_env, default_logging_config_file);
    }
    if (log_config_file_path.startsWith(".")) {
      log_config_file_path = LoggingSetup.get_absolute_source_file_path(log_config_file_path, { source_anchor: this.source_anchor });
    }
    let new_log_config_file_path = abspath(log_config_file_path);
    return new_log_config_file_path;
  }
  /**
   * This is only used when no config file is found.
   * :return: The log level for a basicConfig
   */
  determine_log_level() {
    let log_level = this.default_log_level;
    if (this.log_level_env != null) {
      log_level = dict.get(process.env, this.log_level_env, this.default_log_level);
    }
    return log_level;
  }
  /**
   * Replace the log file in the given config with the one passed into the
   * constructor.
   * :param config: The dictionary containing the logging config.
   * :return: A potentially modified dictionary containing the logging config
   */
  replace_log_file(config) {
    if (this.log_file == null) {
      return config;
    }
    let handlers = dict.get(config, "handlers", {});
    for (const handler_key of Object.keys(handlers)) {
      let handler = dict.get(handlers, handler_key, {});
      let filename = dict.get(handler, "filename", null);
      if (filename != null) {
        handler["filename"] = this.log_file;
        break;
      }
    }
    return config;
  }
  /**
   * :param relative_filepath: The filepath relative to the source file
   * for this class
   * :param source_anchor: An instance whose source file is to be the anchor
   * for any relative source paths.  Default value of null implies
   * use of the current working directory.
   * :return: the full absolute path to the provided relative_filepath
   */
  static get_absolute_source_file_path(relative_filepath, source_anchor) {
    let relative_dir = getcwd();
    if (source_anchor != null) {
      if (isinstance2(source_anchor, String)) {
        relative_dir = source_anchor;
      } else {
        let module_file = getfile(source_anchor.constructor);
        let module_path = abspath(module_file);
        relative_dir = dirname(module_path);
      }
    }
    let partial_relative_path = join(relative_dir, relative_filepath);
    let absolute_file_path = abspath(partial_relative_path);
    return absolute_file_path;
  }
  /**
   * Sets up extra thread-specific fields to be logged with each
   * log message.
   *
   * :param metadata_dict: Metadata dictionary. Default is null
   * :param extra_logging_fields: Additional fields dictionary. Default is null
   */
  static setup_extra_logging_fields(metadata_dict, extra_logging_fields) {
    let extra = ServiceLogRecord.get_default_extra_logging_fields();
    if (extra == null) {
      extra = {};
    }
    if (extra_logging_fields != null) {
      Object.assign(extra, extra_logging_fields);
    }
    extra["thread_name"] = current_thread().name;
    if (metadata_dict != null) {
      for (const key of iter2(extra)) {
        if (contains(key, tuple2("source", "thread_name"))) {
          continue;
        }
        let value = dict.get(metadata_dict, key, null);
        if (value != null) {
          extra[key] = String(value);
        }
      }
    }
    let service_log_record = new ServiceLogRecord();
    service_log_record.set_logging_fields_dict(extra);
  }
  /**
   * Setup logging to be used by ServerLifeTime
   */
  static setup_logging(server_name_for_logs, default_log_dir, log_config_env, log_level_env, extra_logging_fields_defaults, logging_config) {
    let default_extra_logging_fields = { "source": server_name_for_logs, "thread_name": "Unknown", "request_id": "None", "user_id": "None", "group_id": "None", "run_id": "None", "experiment_id": "None" };
    let extras = extra_logging_fields_defaults;
    if (extras == null) {
      extras = default_extra_logging_fields;
    }
    let logging_setup = new LoggingSetup({ default_log_config_dir: default_log_dir, default_log_config_file: "logging.json", default_log_level: "DEBUG", log_config_env, log_level_env, logging_config });
    logging_setup.setup();
    StructuredLogRecord.set_up_record_factory();
    ServiceLogRecord.set_up_record_factory(extras);
    LoggingSetup.setup_extra_logging_fields({ extra_logging_fields: extras });
  }
}
exposeClassAttributes(LoggingSetup);
export {
  AsyncioExecutorPool,
  CompositeDictionaryValidator,
  ConfigFilter,
  ConfigFilterChain,
  ConfigUtil,
  DictionaryConverter,
  DictionaryExtractor,
  DictionaryOverlay,
  DictionaryValidator,
  ExceptionUtil,
  FieldExtractor,
  FileOfClass,
  HoconSerializationFormat,
  JsonSerializationFormat,
  LoggingSetup,
  Resolver,
  ResolverUtil,
  Restorer,
  SensitiveLogger,
  Startable,
  StringFilter,
  Timeout
};
