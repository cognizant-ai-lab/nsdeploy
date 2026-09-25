import { dict, len, ConfigDict, set, contains, is_dict, is_instance_named, loads } from "./stubs.mjs";
import { iter2, BaseMessage, AIMessage, copy, isinstance2, KNOWN_BLOCK_TYPES, tuple2, isfinite, b64encode, getattr2, SystemMessage, HumanMessage, escape, search, DOTALL, slice2, dumps, any2 } from "../vendor/libraries.mjs";
import { DictionaryConverter, ConfigFilter, DictionaryExtractor } from "./leaf_common.mjs";
import { exposeClassAttributes } from "../browser/shims.mjs";
class MessageProcessor {
  /**
   * Resets any previously accumulated state
   */
  reset() {
  }
  /**
   * :param chat_message_dict: The ChatMessage dictionary to consider.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the given message should be blocked from further downstream
   * processing.  False otherwise (the default).
   */
  should_block_downstream_processing(chat_message_dict, message_type) {
    let _ = [chat_message_dict, message_type];
    return false;
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    throw Error("Method not implemented");
  }
  /**
   * Process the message asynchronously.
   * By default, this simply calls the synchronous version.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  async async_process_message(chat_message_dict, message_type) {
    this.process_message(chat_message_dict, message_type);
  }
  /**
   * Convenience method for processing lists of messages.
   * :param chat_message_dicts: The messages to process.
   */
  process_messages(chat_message_dicts) {
    let message = null;
    for (const message2 of iter2(chat_message_dicts)) {
      let message_type = dict.get(message2, "type");
      this.process_message(message2, message_type);
    }
  }
  /**
   * Convenience method for asynchronouslt processing lists of messages.
   * :param chat_message_dicts: The messages to process.
   */
  async async_process_messages(chat_message_dicts) {
    let message = null;
    for (const message2 of iter2(chat_message_dicts)) {
      let message_type = dict.get(message2, "type");
      await this.async_process_message(message2, message_type);
    }
  }
}
exposeClassAttributes(MessageProcessor);
var ChatMessageType;
(function(ChatMessageType2) {
  ChatMessageType2[ChatMessageType2["UNKNOWN_MESSAGE_TYPE"] = 0] = "UNKNOWN_MESSAGE_TYPE";
  ChatMessageType2[ChatMessageType2["SYSTEM"] = 1] = "SYSTEM";
  ChatMessageType2[ChatMessageType2["HUMAN"] = 2] = "HUMAN";
  ChatMessageType2[ChatMessageType2["AI"] = 4] = "AI";
  ChatMessageType2[ChatMessageType2["AGENT"] = 100] = "AGENT";
  ChatMessageType2[ChatMessageType2["AGENT_FRAMEWORK"] = 101] = "AGENT_FRAMEWORK";
  ChatMessageType2[ChatMessageType2["AGENT_TOOL_RESULT"] = 103] = "AGENT_TOOL_RESULT";
  ChatMessageType2[ChatMessageType2["AGENT_PROGRESS"] = 104] = "AGENT_PROGRESS";
})(ChatMessageType || (ChatMessageType = {}));
const MESSAGE_TYPE_TO_CHAT_MESSAGE_TYPE = {
  "system": ChatMessageType.SYSTEM,
  "human": ChatMessageType.HUMAN,
  "ai": ChatMessageType.AI,
  "AGENT": ChatMessageType.AGENT,
  "AGENT_FRAMEWORK": ChatMessageType.AGENT_FRAMEWORK,
  "AGENT_TOOL_RESULT": ChatMessageType.AGENT_TOOL_RESULT,
  "AGENT_PROGRESS": ChatMessageType.AGENT_PROGRESS
};
const CHAT_MESSAGE_TYPE_TO_STRING = {
  [ChatMessageType.UNKNOWN_MESSAGE_TYPE]: "UNKNOWN",
  [ChatMessageType.SYSTEM]: "SYSTEM",
  [ChatMessageType.HUMAN]: "HUMAN",
  [ChatMessageType.AI]: "AI",
  [ChatMessageType.AGENT]: "AGENT",
  [ChatMessageType.AGENT_FRAMEWORK]: "AGENT_FRAMEWORK",
  [ChatMessageType.AGENT_TOOL_RESULT]: "AGENT_TOOL_RESULT",
  [ChatMessageType.AGENT_PROGRESS]: "AGENT_PROGRESS"
};
class TracedMessage extends BaseMessage {
  /**
   * Pass in content as positional arg.
   *
   * @param content - The string contents of the message.
   * @param trace_source - Another TracedMessage to copy additional_kwargs from.
   * @param kwargs - Additional fields to pass to the
   */
  constructor(content, trace_source, kwargs = {}) {
    if (trace_source) {
      let additional_kwargs = trace_source.minimal_additional_kwargs();
      super({ ...kwargs, content: "", additional_kwargs });
    } else {
      super({ ...kwargs, content });
    }
  }
  /**
   * Indicates if the object can be serialized by LangChain.
   */
  get lc_serializable() {
    return true;
  }
  /**
   * :return: the dictionary of keyword arguments for serialization.
   */
  get lc_kwargs() {
    throw Error("Method not implemented");
  }
  /**
   * Creates a minimal additional_kwargs dictionary from the trace_source
   * :return: The minimal kwargs dictionary
   */
  minimal_additional_kwargs() {
    let additional_kwargs = {};
    for (const [key, value] of Object.entries(this.lc_kwargs)) {
      let new_key, new_value = this.translate_for_trace(key, value);
      if (new_key != null) ;
    }
    return additional_kwargs;
  }
  /**
   * :param key: The key to consider/translate.
   * :param value: The value to consider/translate
   * :return: A tuple with the new key and new value to be shown in the trace.
   * New keys that are null are not included in the additional_kwargs.
   * The default implementation simply ensures that there is something in the
   * value to trace display to maximize information.
   */
  async translate_for_trace(key, value) {
    let displayable = value != null && len(value) > 0;
    if (!displayable) {
      return [null, null];
    }
    return [key, value];
  }
}
exposeClassAttributes(TracedMessage);
class AgentToolResultMessage extends AIMessage {
  static {
    this.tool_result_origin = null;
  }
  static {
    this._type = "agent-tool-result";
  }
  /**
   * Constructor
   *
   * :param content: The string contents of the message.
   * :param tool_result_origin: A dictionary describing the origin of the tool result.
   * :param trace_source: A message of the same type to prepare for tracing display
   * :param kwargs: Additional fields to pass to initialize
   */
  constructor(content, tool_result_origin, trace_source, kwargs = {}) {
    super(content, trace_source, kwargs);
    this.tool_result_origin = tool_result_origin;
  }
  /**
   * :return: the keyword arguments for serialization.
   */
  static lc_name() {
    return "AGENT_TOOL_RESULT";
  }
  get type() {
    return "AGENT_TOOL_RESULT";
  }
  get lc_kwargs() {
    return { "content": this.content, "tool_result_origin": this.tool_result_origin };
  }
}
exposeClassAttributes(AgentToolResultMessage);
class AgentMessage extends TracedMessage {
  static {
    this.structure = null;
  }
  static {
    this._type = "agent";
  }
  /**
   * Constructor
   *
   * :param content: The string contents of the message.
   * :param structure: A dictionary to pack into the message
   * :param trace_source: A message of the same type to prepare for tracing display
   * :param kwargs: Additional fields to pass to initialize
   */
  constructor(content, structure, trace_source, kwargs = {}) {
    super(content, trace_source, kwargs);
    this.structure = structure;
  }
  /**
   * :return: the keyword arguments for serialization.
   */
  static lc_name() {
    return "AGENT";
  }
  get type() {
    return "AGENT";
  }
  get lc_kwargs() {
    return { "content": this.content, "structure": this.structure };
  }
}
exposeClassAttributes(AgentMessage);
class AgentFrameworkMessage extends TracedMessage {
  static {
    this.structure = null;
  }
  static {
    this.sly_data = null;
  }
  static {
    this.chat_context = null;
  }
  static {
    this.redactor = null;
  }
  static {
    this._type = "agent-framework";
  }
  static {
    this.model_config = ConfigDict({ arbitrary_types_allowed: true });
  }
  /**
   * Pass in content as positional arg.
   *
   * :param content: The string contents of the message.
   * :param chat_context: A dictionary that fully desbribes the state of play
   * of the chat conversation such that when it is passed on to a
   * different server, the conversation can continue uninterrupted.
   * :param sly_data: A dictionary of private data, separate from the chat stream.
   * :param structure: A dictionary previously extracted from the content
   * that had been optionally detected by the system as JSON text.
   * The idea is to have the server do the hard parsing so the
   * multitude of clients do not have to rediscover how to best do it.
   * :param trace_source: A message of the same type to prepare for tracing display
   * :param redactor: An optional SlyDataRedactor to use. Default is null.
   * :param kwargs: Additional fields to pass to the superclass
   */
  constructor(content, chat_context, sly_data, structure, trace_source, redactor, kwargs = {}) {
    super(content, trace_source, kwargs);
    this.chat_context = chat_context;
    if (chat_context == null) {
      this.chat_context = {};
    }
    this.sly_data = sly_data;
    this.structure = structure;
    this.redactor = redactor;
  }
  /**
   * :return: the keyword arguments for serialization.
   */
  static lc_name() {
    return "AGENT_FRAMEWORK";
  }
  get type() {
    return "AGENT_FRAMEWORK";
  }
  get lc_kwargs() {
    return { "content": this.content, "structure": this.structure, "sly_data": this.sly_data, "chat_context": this.chat_context };
  }
  /**
   * :param key: The key to consider/translate.
   * :param value: The value to consider/translate
   * :return: A tuple with the new key and new value to be shown in the trace.
   * New keys that are null are not included in the additional_kwargs.
   * The default implementation simply ensures that there is something in the
   * value to trace display to maximize information.
   */
  async translate_for_trace(key, value) {
    let new_key = null;
    let new_value = null;
    [new_key, new_value] = await super.translate_for_trace(key, value);
    if (!new_key) {
      return [null, null];
    }
    if (new_key == "sly_data") {
      let allow_sly_data_keys = set();
      if (this.redactor != null) {
        let redacted = this.redactor.filter_config(new_value);
        if (redacted != null) {
          allow_sly_data_keys = set(Object.keys(redacted));
        }
      }
      new_value = copy(value);
      for (const [sly_data_key, sly_data_value] of Object.entries(new_value)) {
        if (contains(sly_data_key, allow_sly_data_keys)) {
          new_value[sly_data_key] = sly_data_value;
        } else {
          new_value[sly_data_key] = "<redacted>";
        }
      }
    }
    return [new_key, new_value];
  }
}
exposeClassAttributes(AgentFrameworkMessage);
class AgentProgressMessage extends TracedMessage {
  static {
    this.structure = null;
  }
  static {
    this._type = "agent-progress";
  }
  /**
   * Constructor
   *
   * :param content: The string contents of the message.
   * :param structure: A dictionary to pack into the message
   * :param trace_source: A message of the same type to prepare for tracing display
   * :param kwargs: Additional fields to pass to initialize
   */
  constructor(content, structure, trace_source, kwargs = {}) {
    super(content, trace_source, kwargs);
    this.structure = structure;
  }
  /**
   * :return: the keyword arguments for serialization.
   */
  static lc_name() {
    return "AGENT_PROGRESS";
  }
  get type() {
    return "AGENT_PROGRESS";
  }
  get lc_kwargs() {
    return { "content": this.content, "structure": this.structure };
  }
}
exposeClassAttributes(AgentProgressMessage);
class ChatMessageTypeUtil {
  /**
   * :param base_message: A base message instance
   * :return: The ChatMessageType corresponding to the base_message
   */
  static from_message(base_message) {
    let base_message_type = Object.getOwnPropertyDescriptor(base_message?.constructor?.prototype ?? {}, "type")?.get?.call(base_message) ?? base_message?.type;
    let chat_message_type = dict.get(MESSAGE_TYPE_TO_CHAT_MESSAGE_TYPE, base_message_type, ChatMessageType.UNKNOWN_MESSAGE_TYPE);
    return chat_message_type;
  }
  /**
   * :param response_type: A type from a response instance
   * :return: The ChatMessageType corresponding to the base_message
   */
  static from_response_type(response_type) {
    let message_type = ChatMessageType.UNKNOWN_MESSAGE_TYPE;
    if (response_type == null) {
      return message_type;
    }
    if (isinstance2(response_type, ChatMessageType)) {
      return response_type;
    }
    if (isinstance2(response_type, Number)) {
      return response_type;
    }
    try {
      message_type = ChatMessageType[response_type];
    } catch (exception) {
      throw new Error(`Got message type ${response_type} (type ${response_type.constructor.name}). Are ChatMessageType and chat.proto out of sync?`);
    }
    return message_type;
  }
  /**
   * :param chat_message_type: A ChatMessageType instance
   * :return: A string corresponding to the chat_message_type
   */
  static to_String(chat_message_type) {
    let message_type_str = dict.get(CHAT_MESSAGE_TYPE_TO_STRING, chat_message_type);
    if (message_type_str == null) {
      message_type_str = dict.get(CHAT_MESSAGE_TYPE_TO_STRING, ChatMessageType.UNKNOWN_MESSAGE_TYPE);
    }
    return message_type_str;
  }
}
exposeClassAttributes(ChatMessageTypeUtil);
class DecodeUtils {
  /**
   * :param instring: The Uint8Array or Uint8Array to decode
   * :param encoding: The encoding to use
   * :return: The decoded string
   */
  static decode(instring, encoding) {
    if (!instring) {
      return "";
    }
    let decoded = instring.decode(encoding);
    return decoded;
  }
}
exposeClassAttributes(DecodeUtils);
class ContentUtils {
  static {
    this.TOOL_CALL_BLOCK_TYPES = ["tool_call", "tool_call_chunk", "invalid_tool_call"];
  }
  static {
    this.OUTPUT_VERSION_V1 = "v1";
  }
  static {
    this.DATA_BLOCK_TYPES = ["image", "audio", "video", "file", "text-plain"];
  }
  /**
   * Project message content down to its visible text.
   *
   * Follows langchain's BaseMessage.text semantics: concatenate top-level
   * strings and the "text" field of {"type": "text"} blocks, in order.
   * Other block types (reasoning, image, etc.) contribute nothing.
   * Unlike some call sites, this method never strips whitespace -
   * callers that strip today must keep stripping themselves.
   *
   * :param source: A BaseMessage, or raw message content
   * (a string, or a list of strings and/or block dictionaries)
   * :return: The concatenated text. Never null; empty content yields "".
   */
  static flatten_to_text(source) {
    let content = isinstance2(source, BaseMessage) ? source.content : source;
    if (content == null) {
      return "";
    }
    if (isinstance2(content, String)) {
      let content_string = content;
      return content_string;
    }
    if (!isinstance2(content, Array)) {
      return String(content);
    }
    let content_list = content;
    let parts = [];
    for (const item of iter2(content_list)) {
      if (isinstance2(item, String)) {
        let item_string = item;
        parts.push(item_string);
      } else if (is_dict(item)) {
        let item_dict = item;
        if (dict.get(item_dict, "type") == "text") {
          let text_value = dict.get(item_dict, "text");
          if (isinstance2(text_value, String)) {
            let text_value_string = text_value;
            parts.push(text_value_string);
          }
        }
      }
    }
    return parts.join("");
  }
  /**
   * Determine whether message content carries no actionable payload.
   *
   * A whitespace-only string, an empty list, or a list whose every element
   * is a blank string or a blank text block all count as empty.
   *, unknown non-text block (reasoning, image, ...) counts as content.
   *
   * NOTE for wire-conversion use: today's ChatMessage wire format emits
   * text="" for empty *string* content and omits the text key only for
   * empty *list* content, so a text-omission gate built on this method
   * must apply it to list-form content only (golden parity).
   *
   * :param source: A BaseMessage, or raw message content
   * :return: True if the content is empty in the sense above
   */
  static is_empty_content(source) {
    let content = source;
    if (isinstance2(source, BaseMessage)) {
      content = source.content;
    }
    if (content == null) {
      return true;
    }
    if (isinstance2(content, String)) {
      let string_content = content;
      return string_content.trim() == "";
    }
    if (isinstance2(content, Array)) {
      let list_content = content;
      for (const item of iter2(list_content)) {
        if (!ContentUtils._is_blank_block(item)) {
          return false;
        }
      }
      return true;
    }
    return !Boolean(content);
  }
  /**
   * Determine whether a single list-content item carries no visible text.
   *
   * :param item: One element of a message's list content
   * :return: True for a whitespace-only string or an empty/whitespace text
   * block ({"type": "text"}); any other block type counts as content
   */
  static _is_blank_block(item) {
    if (isinstance2(item, String)) {
      return item.trim() == "";
    }
    if (is_dict(item) && dict.get(item, "type") == "text") {
      let text_value = dict.get(item, "text");
      if (!isinstance2(text_value, String)) {
        return true;
      }
      return text_value.trim() == "";
    }
    return false;
  }
  /**
   * Get the standardized (langchain v1) content-block view of a message.
   *
   * Wraps the message's .content_blocks property, which translates
   * provider-native content (Anthropic "thinking" dicts, OpenAI Responses
   * reasoning items, additional_kwargs reasoning) into standard blocks,
   * then:
   * - excludes tool-call blocks (see TOOL_CALL_BLOCK_TYPES), and
   * - sanitizes the result to be JSON-safe (bytes become base64 strings).
   *
   * Call this while the message's response_metadata (model_provider /
   * output_version) is still intact - translator selection depends on it.
   * Messages lacking model_provider metadata (and Anthropic
   * redacted_thinking blocks even with it) standardize provider-native
   * shapes as {"type": "non_standard", "value": ...} wrappers: data-
   * preserving and JSON-safe, but downstream renderers must expect them.
   *
   * :param message: The BaseMessage whose content to standardize
   * :return: A JSON-safe list of standard content-block dictionaries
   */
  static standard_blocks(message) {
    let blocks = [];
    let content_blocks = message.content_blocks;
    let block = null;
    for (const block2 of iter2(content_blocks)) {
      let use_block = block2;
      let block_type = dict.get(use_block, "type");
      if (contains(block_type, ContentUtils.TOOL_CALL_BLOCK_TYPES)) {
        continue;
      }
      blocks.push(use_block);
    }
    let json_safe_blocks = ContentUtils.to_json_safe(blocks);
    return json_safe_blocks;
  }
  /**
   * Determine whether a standardized block list carries no more information
   * than its flattened text - a single text block with no annotations and
   * no extras. Trivial block lists collapse back to plain-string content
   * so that existing text-only traffic keeps its exact current shape.
   *
   * Policy: provider bookkeeping keys ("id", "index") do NOT make a text
   * block non-trivial - such messages are plain strings on today's wire,
   * and the collapse deliberately drops those keys to keep that shape.
   *
   * :param blocks: A list of standard content-block dictionaries
   * :return: True if the list is equivalent to a plain string
   */
  static is_trivial(blocks) {
    if (len(blocks) != 1) {
      return false;
    }
    let block = blocks[0];
    if (dict.get(block, "type") != "text") {
      return false;
    }
    if (dict.get(block, "annotations") || dict.get(block, "extras")) {
      return false;
    }
    return true;
  }
  /**
   * Reduce a message's content to its canonical in-server form:
   * plain-string content stays a plain string; block-form content becomes
   * the standardized block list - unless it is empty or trivial, in which
   * case it collapses to its flattened text so that text-only traffic
   * keeps its exact current shape.
   *
   * :param message: The BaseMessage whose content to normalize
   * :return: A string, or a JSON-safe list of standard block dictionaries
   */
  static normalize_content(message) {
    let content = message.content;
    if (isinstance2(content, String)) {
      let content_string = content;
      return content_string;
    }
    if (isinstance2(content, Array)) {
      let content_list = content;
      let all_strings = true;
      let item = null;
      for (const item2 of iter2(content_list)) {
        if (!isinstance2(item2, String)) {
          all_strings = false;
          break;
        }
      }
      if (all_strings) {
        return ContentUtils.flatten_to_text(message);
      }
    }
    let blocks = ContentUtils.standard_blocks(message);
    if (!blocks || ContentUtils.is_trivial(blocks)) {
      return ContentUtils.flatten_to_text(message);
    }
    return blocks;
  }
  /**
   * Return a copy of the message whose content is normalize_content()'s
   * canonical form. When that form is a block list, the copy's
   * response_metadata is stamped with output_version="v1" so that any
   * later .content_blocks access passes the already-standard blocks
   * through instead of re-translating them (which would wrap them
   * as "non_standard").
   *
   * Intended for COMPLETE messages. Do not use on AIMessageChunks:
   * chunk-only shapes (e.g. a tool_call_chunk block living solely in
   * chunk content) are not content and would be collapsed away.
   *
   * :param message: The BaseMessage to normalize
   * :return: The same message instance if nothing changed,
   * otherwise a model_copy with normalized content
   */
  static normalize_message(message) {
    let update_dict = {};
    let normalized = ContentUtils.normalize_content(message);
    if (isinstance2(normalized, String)) {
      if (normalized == message.content) {
        return message;
      }
      update_dict["content"] = normalized;
      return ContentUtils.message_model_copy(message, update_dict);
    }
    let response_metadata = null;
    if (message.response_metadata == null) {
      response_metadata = {};
    } else {
      response_metadata = copy(message.response_metadata);
    }
    response_metadata["output_version"] = ContentUtils.OUTPUT_VERSION_V1;
    update_dict = { "content": normalized, "response_metadata": response_metadata };
    return ContentUtils.message_model_copy(message, update_dict);
  }
  /**
   * Funnel method to return a model_copy() of the message with the given update_dict applied.
   *
   * :param message: The BaseMessage to copy
   * :param update_dict: The dictionary to update the message with
   * :return: A model_copy() of the message with the update_dict applied
   */
  static message_model_copy(message, update_dict) {
    return message.model_copy({ update: update_dict });
  }
  /**
   * Determine whether a value is a non-empty list of standard langchain v1
   * content-block dictionaries (every element a dict whose "type" is one
   * of langchain's KNOWN_BLOCK_TYPES). Does not qualify:
   * - provider-native shapes (e.g. Anthropic {"type": "thinking"}),
   * - v0-era blocks (marked by a "source_type" key),
   * - tool-call blocks (see TOOL_CALL_BLOCK_TYPES) - they are not
   * message content, and accepting them inbound would let clients
   * inject synthetic tool calls.
   *
   * :param value: unknown value to inspect
   * :return: True if the value can be used as standard block content
   */
  static looks_like_blocks(value) {
    if (!isinstance2(value, Array) || len(value) == 0) {
      return false;
    }
    let list_value = value;
    let item = null;
    for (const item2 of iter2(list_value)) {
      if (!is_dict(item2)) {
        return false;
      }
      let item_dict = item2;
      let item_type = dict.get(item_dict, "type");
      if (!contains(item_type, KNOWN_BLOCK_TYPES)) {
        return false;
      }
      if (contains(item_type, ContentUtils.TOOL_CALL_BLOCK_TYPES)) {
        return false;
      }
      if (contains("source_type", Object.keys(item_dict))) {
        return false;
      }
    }
    return true;
  }
  /**
   * Extract langchain v1 content blocks from a neuro-san ChatMessage
   * dictionary, if it carries any block-form content.
   *
   * 1. A "content_blocks" list of standard blocks is used verbatim.
   * A content_blocks value that is present but NOT valid standard
   * blocks yields null (fail safe) - it does not fall through to
   * mime_data. Note the verbatim path aliases the caller's list;
   * callers must not mutate the result.
   * 2. Otherwise a non-empty "mime_data" list ({"mime_type": ...,
   * "mime_bytes": <base64 string>} entries per chat.proto) is mapped to
   * data blocks, preceded by a text block for any "text" field.
   * 3. Otherwise there is no block content.
   *
   * :param chat_message: A ChatMessage dictionary
   * :return: A list of standard block dictionaries, or null if the
   * message carries no usable block-form content (including
   * when content_blocks or mime_data entries are malformed -
   * callers should fall back to their existing text-only
   * handling)
   */
  static blocks_from_chat_message(chat_message) {
    if (chat_message == null) {
      return null;
    }
    let content_blocks = dict.get(chat_message, "content_blocks");
    let content_blocks_list = content_blocks;
    if (content_blocks != null && !(isinstance2(content_blocks, Array) && len(content_blocks_list) == 0)) {
      if (ContentUtils.looks_like_blocks(content_blocks)) {
        return content_blocks;
      }
      return null;
    }
    let mime_data = dict.get(chat_message, "mime_data");
    if (!isinstance2(mime_data, Array)) {
      return null;
    }
    let mime_data_list = mime_data;
    if (len(mime_data_list) == 0) {
      return null;
    }
    let blocks = [];
    let text = dict.get(chat_message, "text");
    if (isinstance2(text, String) && text) {
      blocks.push({ "type": "text", "text": text });
    }
    let entry = null;
    for (const entry2 of iter2(mime_data_list)) {
      if (!is_dict(entry2)) {
        return null;
      }
      let entry_dict = entry2;
      let mime_type = String(dict.get(entry_dict, "mime_type") || "");
      let mime_bytes = dict.get(entry_dict, "mime_bytes");
      if (!isinstance2(mime_bytes, String) || (!mime_bytes || !mime_type)) {
        return null;
      }
      let mime_bytes_str = mime_bytes;
      blocks.push(ContentUtils._data_block(mime_type, mime_bytes_str));
    }
    return blocks;
  }
  /**
   * Project content to text that is safe to replay as assistant-role
   * conversation history. Text contributes as in flatten_to_text, but
   * data-bearing blocks (see DATA_BLOCK_TYPES) are replaced by a short
   * "[<type> attachment: <mime_type>]" reference instead of vanishing -
   * so an image-only tool result does not become empty history.
   * Providers reject raw image/file blocks in assistant-role messages,
   * which is why history copies must go through this projection.
   *
   * :param source: A BaseMessage, or raw message content
   * :return: The history-safe text. Never null.
   */
  static history_safe_text(source) {
    let content = source;
    if (isinstance2(source, BaseMessage)) {
      content = source.content;
    }
    if (content == null || isinstance2(content, String)) {
      return content || "";
    }
    if (!isinstance2(content, Array)) {
      return String(content);
    }
    let content_list = content;
    let parts = [];
    let item = null;
    for (const item2 of iter2(content_list)) {
      if (isinstance2(item2, String)) {
        let string_item = item2;
        parts.push(string_item);
        continue;
      }
      if (!is_dict(item2)) {
        continue;
      }
      let dict_item = item2;
      let block_type = dict.get(dict_item, "type");
      if (block_type == "text") {
        let text_value = dict.get(dict_item, "text");
        if (isinstance2(text_value, String)) {
          parts.push(text_value);
        }
      } else if (contains(block_type, ContentUtils.DATA_BLOCK_TYPES)) {
        let inline_text = dict.get(dict_item, "text");
        if (isinstance2(inline_text, String) && inline_text) {
          parts.push(inline_text);
        } else {
          let mime_type = String(dict.get(dict_item, "mime_type") || "unknown");
          parts.push(`[${block_type} attachment: ${mime_type}]`);
        }
      }
    }
    return parts.join("");
  }
  /**
   * Build the standard langchain v1 data block for one MimeData entry.
   *
   * :param mime_type: The MIME type of the data
   * :param base64_str: The data as a base64 string (never raw bytes)
   * :return: A standard data-block dictionary
   */
  static _data_block(mime_type, base64_str) {
    if (mime_type == "text/plain") {
      return { "type": "text-plain", "mime_type": "text/plain", "base64": base64_str };
    }
    let kind = "file";
    for (const prefix of tuple2("image", "audio", "video")) {
      if (mime_type.startsWith(`${prefix}/`)) {
        kind = prefix;
        break;
      }
    }
    return { "type": kind, "base64": base64_str, "mime_type": mime_type };
  }
  /**
   * Recursively make a value JSON-serializable without dropping data:
   * Uint8Array become base64 strings, non-finite floats and unknown objects
   * become their string form, tuples and sets become lists, and
   * dictionary keys become strings. Use it for message content and
   * content-block payloads (tool outputs, images, files) that must
   * survive intact into the journal.
   *
   * Not to be confused with ChatMessageConverter.to_json_safe, the lossy
   * variant for outbound ChatMessage response dictionaries: there
   * anything non-serializable, Uint8Array included, becomes null and
   * non-string keys are dropped. Use that one for response
   * dictionaries, this one for content.
   *
   * :param value: unknown value to sanitize
   * :return: A JSON-serializable equivalent of the value
   */
  static to_json_safe(value) {
    if (value == null || isinstance2(value, [String, Boolean, Number])) {
      return value;
    }
    if (isinstance2(value, Number)) {
      return isfinite(value) ? value : String(value);
    }
    if (isinstance2(value, [Uint8Array, Uint8Array])) {
      let bytes_value = new Uint8Array(value);
      let encoded = b64encode(bytes_value);
      return DecodeUtils.decode(encoded, "ascii");
    }
    if (is_dict(value)) {
      let safe_dict = {};
      for (const [key, item] of Object.entries(value)) {
        safe_dict[String(key)] = ContentUtils.to_json_safe(item);
      }
      return safe_dict;
    }
    if (isinstance2(value, [Array, Array, Set])) {
      let safe_list = [];
      for (const item of iter2(value)) {
        safe_list.push(ContentUtils.to_json_safe(item));
      }
      return safe_list;
    }
    return String(value);
  }
}
exposeClassAttributes(ContentUtils);
class BaseMessageDictionaryConverter extends DictionaryConverter {
  /**
   * Constructor
   *
   * :param origin: A List of origin dictionaries indicating the origin of the run.
   * The origin can be considered a path to the original call to the front-man.
   * Origin dictionaries themselves each have the following keys:
   * "tool"                  The string name of the tool in the spec
   * "instantiation_index"   An integer indicating which incarnation
   * of the tool is being dealt with.
   * This is only used for to_dict()
   * :param langchain_only: When True (default) only convert langchain messages,
   * and not our own special variants.
   * This is only used for from_dict()
   */
  constructor(origin, langchain_only) {
    super();
    this.origin = origin;
    this.langchain_only = langchain_only;
  }
  /**
   * Convert the BaseMessage to a chat.ChatMessage dictionary
   *
   * :param obj: The BaseMessage to convert
   * :return: The ChatMessage in dictionary form
   */
  to_dict(obj) {
    let message = obj;
    let message_type = ChatMessageTypeUtil.from_message(message);
    let chat_message = { "type": message_type };
    if (this.origin != null) {
      chat_message["origin"] = this.origin;
    }
    let optionals = { "content": "text", "chat_context": "chat_context", "tool_result_origin": "tool_result_origin", "structure": "structure", "sly_data": "sly_data" };
    for (const [src, dest] of Object.entries(optionals)) {
      let value = null;
      try {
        value = getattr2(message, src);
      } catch (e) {
        value = null;
      }
      if (src == "content" && isinstance2(value, Array)) {
        if (len(value) == 0) {
          value = null;
        } else {
          value = ContentUtils.flatten_to_text(value);
        }
      }
      if (value != null) {
        chat_message[dest] = value;
      }
    }
    return chat_message;
  }
  /**
   * The intended use for this method is for converting a neuro-san ChatMessage
   * dictionary into a langchain BaseMessage such that it can be understood by
   * a langchain agent within the context of a langchain-facing chat history.
   * This means that some special messages we might have inserted into a chat
   * history *might* need to be converted into something langchain agents will
   * understand.
   *
   * :param obj_dict: A ChatMessage dictionary to convert into BaseMessage
   * :return: A BaseMessage that was converted from the input.
   * Can return null if conversion could not take place
   */
  from_dict(obj_dict) {
    let chat_message = obj_dict;
    let base_message = null;
    if (chat_message == null) {
      return base_message;
    }
    let content = dict.get(chat_message, "text");
    let chat_message_type = ChatMessageTypeUtil.from_response_type(dict.get(chat_message, "type"));
    if (chat_message_type == ChatMessageType.SYSTEM) {
      base_message = new SystemMessage(content);
    } else if (chat_message_type == ChatMessageType.HUMAN) {
      base_message = new HumanMessage(content);
    } else if (chat_message_type == ChatMessageType.AI) {
      base_message = new AIMessage(content);
    } else if (chat_message_type == ChatMessageType.AGENT_TOOL_RESULT) {
      base_message = new AgentToolResultMessage(content, dict.get(chat_message, "tool_result_origin"), null);
    }
    if (this.langchain_only) {
      return base_message;
    }
    if (base_message == null) {
      if (chat_message_type == ChatMessageType.AGENT) {
        base_message = new AgentMessage(dict.get(chat_message, "text", ""), dict.get(chat_message, "structure"), null);
      } else if (chat_message_type == ChatMessageType.AGENT_FRAMEWORK) {
        base_message = new AgentFrameworkMessage(dict.get(chat_message, "text", ""), null, null, null, null, null);
      } else if (chat_message_type == ChatMessageType.AGENT_PROGRESS) {
        base_message = new AgentProgressMessage(dict.get(chat_message, "text", ""), dict.get(chat_message, "structure"), null);
      }
    }
    return base_message;
  }
  /**
   * :param base_message: The BaseMessage to consider
   * :return: True if the BaseMessage type is relevant to chat history (include).
   * False otherwise (do not include).
   */
  static is_relevant_to_chat_history(base_message) {
    if (is_instance_named(base_message, ["AgentMessage", "AgentFrameworkMessage", "ToolMessage", "AgentProgressMessage"])) {
      return false;
    }
    return true;
  }
}
exposeClassAttributes(BaseMessageDictionaryConverter);
class MessageFilter {
  /**
   * Determine whether to allow the message through.
   * This is the main entry point for most clients.
   */
  allow(chat_message_dict) {
    let message_type = MessageFilter.get_message_type(chat_message_dict);
    return this.allow_message(chat_message_dict, message_type);
  }
  /**
   * Convert the message type in the ChatMessage dictionary to the enum we want to work with
   * :param chat_message_dict: The ChatMessage dictionary to consider.
   * :return: The ChatMessageType of the chat_message_dict
   */
  static get_message_type(chat_message_dict) {
    let response_type = dict.get(chat_message_dict, "type");
    let message_type = ChatMessageTypeUtil.from_response_type(response_type);
    return message_type;
  }
  /**
   * Determine whether to allow the message through.
   * This is what subclasses should implement.
   * MessageProcessors also call this interface directly.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(MessageFilter);
class AnswerMessageFilter extends MessageFilter {
  /**
   * Determine whether to allow the message through.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    if (!contains(message_type, tuple2(ChatMessageType.AI, ChatMessageType.AGENT_FRAMEWORK))) {
      return false;
    }
    let origin = dict.get(chat_message_dict, "origin");
    if (origin != null && len(origin) > 1) {
      return false;
    }
    let text = dict.get(chat_message_dict, "text");
    let structure = dict.get(chat_message_dict, "structure");
    if (text == null && structure == null) {
      return false;
    }
    return true;
  }
}
exposeClassAttributes(AnswerMessageFilter);
class StructureParser {
  /**
   * Constructor
   */
  constructor() {
    this.remainder = null;
  }
  /**
   * Parse the single string content for any signs of structure
   *
   * :param content: The string to parse for structure
   * :return: A dictionary structure that was embedded in the content.
   * Will return null if no parseable structure is detected.
   */
  parse_structure(content) {
    throw Error("Method not implemented");
  }
  /**
   * :return: unknown content string that was not essential in detecting or
   * describing the structure.  The parse_structure() method must
   * be called to get anything valid out of the return value here.
   * Will return null if no parseable structure is detected.
   */
  get_remainder() {
    return this.remainder;
  }
}
exposeClassAttributes(StructureParser);
class JsonStructureParser extends StructureParser {
  /**
   * Parse the single string content for any signs of structure
   *
   * :param content: The string to parse for structure
   * :return: A dictionary structure that was embedded in the content.
   * Will return null if no parseable structure is detected.
   */
  parse_structure(content) {
    this.remainder = null;
    let delimiters = { "```json": "```", "```": "```", "`{": "}`", "{": "}" };
    let meat = null;
    let one_remainder = null;
    [meat, one_remainder] = this._extract_delimited_block(content, delimiters);
    this.remainder = one_remainder;
    let structure = null;
    try {
      structure = loads(meat);
      if (!is_dict(structure)) {
        structure = null;
      }
    } catch (e) {
      if (e instanceof Error) {
        this.remainder = null;
      } else if (e instanceof TypeError) {
        this.remainder = null;
      }
    }
    return structure;
  }
  /**
   * Extracts a block of text from the input string "text" that is enclosed between any
   * of the provided delimiter pairs. Returns a tuple of:
   * - The extracted main block with delimiters, or null if no match
   * - The remaining string with the block removed and extra whitespace collapsed
   *
   * :param text: The input string potentially containing a delimited block
   * :param delimiters: A dictionary mapping starting delimiters to ending delimiters
   *
   * :return: A tuple of (main block content, remainder string)
   */
  _extract_delimited_block(text, delimiters) {
    let start = null;
    let end = null;
    for (const [start2, end2] of Object.entries(delimiters)) {
      let pattern = escape(start2) + "(.*)" + escape(end2);
      let match = search(pattern, text, DOTALL);
      if (match) {
        let main = match.group(0).trim();
        let pre_remainder = slice2(text, void 0, match.start());
        let post_remainder = slice2(text, match.end(), void 0);
        let remainder = pre_remainder + post_remainder;
        let stripped_remainder = remainder.trim();
        return [main, stripped_remainder];
      }
    }
    let stripped_text = text.trim();
    return [null, stripped_text];
  }
}
exposeClassAttributes(JsonStructureParser);
class StructureParserFactory {
  /**
   * Creates a structure parser given the string type
   *
   * :param parser_type: A string describing the format of the structure parser.
   */
  create_structure_parser(parser_type) {
    let structure_parser = null;
    if (parser_type == null || !isinstance2(parser_type, String)) {
      structure_parser = null;
    } else if (parser_type.toLowerCase() == "json") {
      structure_parser = new JsonStructureParser();
    }
    return structure_parser;
  }
}
exposeClassAttributes(StructureParserFactory);
class FirstAvailableStructureParser extends StructureParser {
  /**
   * Constructor
   *
   * :param structure_formats: A List of strings containing potential parse formats to match
   */
  constructor(structure_formats) {
    super();
    this.structure_formats = structure_formats;
    this.factory = new StructureParserFactory();
  }
  /**
   * Parse the single string content for any signs of structure
   *
   * :param content: The string to parse for structure
   * :return: A dictionary structure that was embedded in the content.
   * Will return null if no parseable structure is detected.
   */
  parse_structure(content) {
    let structure = null;
    for (const structure_format of this.structure_formats) {
      let structure_parser = this.factory.create_structure_parser(structure_format);
      if (structure_parser == null) {
        continue;
      }
      structure = structure_parser.parse_structure(content);
      if (structure != null) {
        this.remainder = structure_parser.get_remainder();
        break;
      }
    }
    return structure;
  }
}
exposeClassAttributes(FirstAvailableStructureParser);
class AnswerMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param structure_formats: Optional string or list of strings telling us to look for
   * specific formats within the text of the final answer to separate out
   * in a common way so that clients do not have to reinvent this wheel over
   * and over again.
   *
   * Valid values are:
   * "json" - look for JSON in the message content as structure to report.
   *
   * By default this is null, implying that such parsing is bypassed.
   */
  constructor(structure_formats) {
    super();
    this.answer = null;
    this.structure = null;
    this.answer_origin = null;
    this.filter = new AnswerMessageFilter();
    this.structure_formats = structure_formats;
    if (this.structure_formats != null) {
      if (isinstance2(this.structure_formats, String)) {
        this.structure_formats = [this.structure_formats];
      }
    } else {
      this.structure_formats = [];
    }
    if (!isinstance2(this.structure_formats, Array)) {
      throw new Error(`Value '${structure_formats}' must be a string, a list of strings, or null`);
    }
  }
  /**
   * :return: The final answer from the agent session interaction
   */
  get_answer() {
    return this.answer;
  }
  /**
   * :return: The origin of the final answer from the agent session interaction
   */
  get_answer_origin() {
    return this.answer_origin;
  }
  /**
   * :return: unknown dictionary structure that was contained within the final answer
   * from the agent session interaction, if such a specific breakout was desired.
   */
  get_structure() {
    return this.structure;
  }
  /**
   * Resets any previously accumulated state
   */
  reset() {
    this.answer = null;
    this.structure = null;
    this.answer_origin = null;
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    if (!this.filter.allow_message(chat_message_dict, message_type)) {
      return;
    }
    let origin = dict.get(chat_message_dict, "origin");
    let text = dict.get(chat_message_dict, "text");
    let structure = dict.get(chat_message_dict, "structure");
    if (text != null) {
      this.answer = text;
    }
    if (origin != null) {
      this.answer_origin = origin;
    }
    if (structure != null) {
      this.structure = structure;
    }
    if (structure == null && text != null) {
      let structure_parser = new FirstAvailableStructureParser(this.structure_formats);
      this.structure = structure_parser.parse_structure(text);
      if (this.structure != null) {
        this.answer = structure_parser.get_remainder();
      }
    }
  }
}
exposeClassAttributes(AnswerMessageProcessor);
class ChatContextMessageFilter extends MessageFilter {
  /**
   * Determine whether to allow the message through.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    if (message_type != ChatMessageType.AGENT_FRAMEWORK) {
      return false;
    }
    if (dict.get(chat_message_dict, "chat_context") == null) {
      return false;
    }
    return true;
  }
}
exposeClassAttributes(ChatContextMessageFilter);
class ChatContextMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   */
  constructor() {
    super();
    this.chat_context = {};
    this.sly_data = null;
    this.filter = new ChatContextMessageFilter();
  }
  /**
   * :return: The chat_context discovered from the agent session interaction
   * Empty dictionaries or null values simply start a new conversation.
   */
  get_chat_context() {
    return this.chat_context;
  }
  /**
   * :return: The sly_data discovered from the agent session interaction
   */
  get_sly_data() {
    return this.sly_data;
  }
  /**
   * Resets any previously accumulated state
   */
  reset() {
    this.chat_context = {};
    this.sly_data = null;
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    if (!this.filter.allow_message(chat_message_dict, message_type)) {
      return;
    }
    this.chat_context = dict.get(chat_message_dict, "chat_context", this.chat_context);
    this.sly_data = dict.get(chat_message_dict, "sly_data", this.sly_data);
  }
}
exposeClassAttributes(ChatContextMessageProcessor);
class CompositeMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param message_processors: An ordered List of MessageProcessors with which
   * this instance will process messages
   * :param depth_blocks_breadth: When True, any one component of this instance (depth)
   * can block further message processing of downstream peers (breadth).
   */
  constructor(message_processors, depth_blocks_breadth) {
    super();
    this.message_processors = message_processors;
    if (this.message_processors == null) {
      this.message_processors = [];
    }
    this.depth_blocks_breadth = depth_blocks_breadth;
  }
  /**
   * Adds a MessageProcessor to the list.
   * Order can be important.
   *
   * :param message_processor: The MessageProcessor to add
   */
  add_processor(message_processor) {
    if (message_processor != null) {
      this.message_processors.push(message_processor);
    }
  }
  /**
   * Resets any previously accumulated state
   */
  reset() {
    for (const message_processor of this.message_processors) {
      message_processor.reset();
    }
  }
  /**
   * :param chat_message_dict: The ChatMessage dictionary to consider.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the given message should be blocked from further downstream
   * processing.  False otherwise (the default).
   */
  should_block_downstream_processing(chat_message_dict, message_type) {
    if (!this.depth_blocks_breadth) {
      return false;
    }
    for (const message_processor of this.message_processors) {
      if (message_processor.should_block_downstream_processing(chat_message_dict, message_type)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * Can be null to kick the process off.
   */
  process_message(chat_message_dict, message_type) {
    if (message_type == null) {
      message_type = MessageFilter.get_message_type(chat_message_dict);
    }
    for (const message_processor of this.message_processors) {
      message_processor.process_message(chat_message_dict, message_type);
      if (message_processor.should_block_downstream_processing(chat_message_dict, message_type)) {
        break;
      }
    }
  }
  /**
   * Process the message asynchronously.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * Can be null to kick the process off.
   */
  async async_process_message(chat_message_dict, message_type) {
    if (message_type == null) {
      message_type = MessageFilter.get_message_type(chat_message_dict);
    }
    for (const message_processor of this.message_processors) {
      await message_processor.async_process_message(chat_message_dict, message_type);
      if (message_processor.should_block_downstream_processing(chat_message_dict, message_type)) {
        break;
      }
    }
  }
}
exposeClassAttributes(CompositeMessageProcessor);
class TokenAccountingMessageFilter extends MessageFilter {
  /**
   * Determine whether to allow the message through.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    if (message_type != ChatMessageType.AGENT) {
      return false;
    }
    let origin = dict.get(chat_message_dict, "origin");
    if (origin != null && len(origin) > 1) {
      return false;
    }
    let structure = dict.get(chat_message_dict, "structure");
    if (structure == null) {
      return false;
    }
    if (dict.get(structure, "total_tokens") == null) {
      return false;
    }
    return true;
  }
}
exposeClassAttributes(TokenAccountingMessageFilter);
class TokenAccountingMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param structure_formats: Optional string or list of strings telling us to look for
   * specific formats within the text of the final answer to separate out
   * in a common way so that clients do not have to reinvent this wheel over
   * and over again.
   *
   * Valid values are:
   * "json" - look for JSON in the message content as structure to report.
   *
   * By default this is null, implying that such parsing is bypassed.
   */
  constructor() {
    super();
    this.token_accounting = null;
    this.filter = new TokenAccountingMessageFilter();
  }
  /**
   * :return: The final token accounting from the agent session interaction
   */
  get_token_accounting() {
    return this.token_accounting;
  }
  /**
   * Resets any previously accumulated state
   */
  reset() {
    this.token_accounting = null;
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    if (!this.filter.allow_message(chat_message_dict, message_type)) {
      return;
    }
    let structure = dict.get(chat_message_dict, "structure");
    if (structure != null) {
      this.token_accounting = structure;
    }
  }
}
exposeClassAttributes(TokenAccountingMessageProcessor);
class BasicMessageProcessor extends CompositeMessageProcessor {
  /**
   * Constructor
   *
   * :param message_processors: An ordered List of additional MessageProcessors with which
   * this instance will process messages
   */
  constructor(message_processors) {
    super(message_processors, false);
    this.answer = new AnswerMessageProcessor(null);
    this.chat_context = new ChatContextMessageProcessor();
    this.token_accounting = new TokenAccountingMessageProcessor();
    this.message_processors.unshift(this.chat_context);
    this.message_processors.unshift(this.answer);
    this.message_processors.push(this.token_accounting);
  }
  /**
   * :return: The final answer from the agent session interaction
   */
  get_answer() {
    return this.answer.get_answer();
  }
  /**
   * :return: The origin of the final answer from the agent session interaction
   */
  get_answer_origin() {
    return this.answer.get_answer_origin();
  }
  /**
   * :return: unknown sly_data that was returned
   */
  get_sly_data() {
    return this.chat_context.get_sly_data();
  }
  /**
   * :return: The chat_context discovered from the agent session interaction
   * Empty dictionaries or null values simply start a new conversation.
   */
  get_chat_context() {
    return this.chat_context.get_chat_context();
  }
  /**
   * :return: unknown dictionary structure that was contained within the final answer
   * from the agent session interaction, if such a specific breakout was desired.
   */
  get_structure() {
    return this.answer.get_structure();
  }
  /**
   * :return: All components of the "answer" except for sly_data compiled into
   * a single string.  This includes the results of these methods in order:
   * get_answer()
   * get_structure()
   */
  get_compiled_answer() {
    let compiled = this.get_answer();
    let structure = this.get_structure();
    if (structure != null) {
      let string_struct = dumps(structure, { indent: 4, sortKeys: true });
      if (compiled == null) {
        compiled = "";
      }
      compiled += `
\`\`\`json
${string_struct}
\`\`\``;
    }
    return compiled;
  }
  /**
   * :return: The token accounting dictionary from the streaming_chat() session.
   */
  get_token_accounting() {
    return this.token_accounting.get_token_accounting();
  }
}
exposeClassAttributes(BasicMessageProcessor);
class SlyDataRedactor extends ConfigFilter {
  /**
   * Constructor
   *
   * :param calling_agent_tool_spec: The dictionary describing the JSON agent tool
   * that is providing the sly_data.
   * :param config_keys: A list of config keys in reverse precedence order.
   * That is, the further on in the list you get, the greater the precedence.
   * Each string is a fully qualified identifier that can span multiple
   * dictionaries like: "allow.to_upstream.sly_data".
   * :param allow_empty_dict: Default is true which allows filter_config() to return
   * an empty dictionary.  When set to False and empty this yields
   * a null value.
   */
  constructor(calling_agent_tool_spec, config_keys, allow_empty_dict) {
    super();
    this.agent_tool_spec = calling_agent_tool_spec;
    this.config_keys = config_keys;
    if (this.config_keys == null) {
      this.config_keys = [];
    }
    this.allow_empty_dict = allow_empty_dict;
  }
  /**
   * :param basis_config: Source of the sly_data to redact.
   * :return: A new sly_data dictionary with proper redactions per the config_keys on the
   * agent_tool_spec.  If no such keys exist, then no sly_data
   * gets through to the agent to be called.  Also, if allow_empty_dict
   * is set to true, this method can return an empty dictionary.
   * When allow_empty_dict is set to False and empty dictionary returns a null value.
   */
  filter_config(basis_config) {
    let empty = {};
    let extractor = new DictionaryExtractor(this.agent_tool_spec, ".");
    let allow_dict = empty;
    for (const config_key of this.config_keys) {
      allow_dict = extractor.get(config_key, allow_dict);
    }
    if (!Boolean(allow_dict)) {
      return this.maybe_empty(empty);
    }
    if (isinstance2(allow_dict, Boolean) && Boolean(allow_dict)) {
      return this.maybe_empty(basis_config);
    }
    if (!Boolean(basis_config) || !is_dict(basis_config)) {
      return this.maybe_empty(empty);
    }
    if (isinstance2(allow_dict, Array)) {
      let true_dict = {};
      let key = null;
      for (const key2 of iter2(allow_dict)) {
        let use_key = key2;
        true_dict[use_key] = true;
      }
      allow_dict = true_dict;
    }
    let redacted = {};
    let source_key = null;
    let dest_key = null;
    for (const [source_key2, dest_key2] of Object.entries(allow_dict)) {
      let source_value = dict.get(basis_config, source_key2);
      if (source_value == null) {
        continue;
      }
      if (isinstance2(dest_key2, String)) {
        let use_dest_key = dest_key2;
        redacted[use_dest_key] = source_value;
      } else if (isinstance2(dest_key2, Boolean) && Boolean(dest_key2)) {
        redacted[source_key2] = source_value;
      }
    }
    return this.maybe_empty(redacted);
  }
  /**
   * :param test_dict: The dictionary to test for emptiness
   * :return: If the test_dict is empty and the instance is not configured
   * to return empty dictionaries, then return null. Otherise return
   * the test_dict in its entirety
   */
  maybe_empty(test_dict) {
    if (!this.allow_empty_dict && !Boolean(test_dict)) {
      return null;
    }
    return test_dict;
  }
}
exposeClassAttributes(SlyDataRedactor);
class MaximalMessageFilter extends MessageFilter {
  /**
   * Determine whether to allow the message through.
   *
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    if (any2(Object.keys(chat_message_dict))) {
      return true;
    }
    return false;
  }
}
exposeClassAttributes(MaximalMessageFilter);
class CompoundMessageFilter extends MessageFilter {
  /**
   * Constructor
   *
   * :param filters: A List of MessageFilter instances to simultaneously service
   */
  constructor(filters) {
    super();
    this.filters = filters;
    if (this.filters == null) {
      this.filters = [];
    }
  }
  /**
   * Determine whether to allow the message through.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   * :return: True if the message should be allowed through to the client. False otherwise.
   */
  allow_message(chat_message_dict, message_type) {
    for (const one_filter of this.filters) {
      if (one_filter.allow_message(chat_message_dict, message_type)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Adds a message_filter to the list
   * :param message_filter: A MessageFilter instance to service
   */
  add_message_filter(message_filter) {
    this.filters.push(message_filter);
  }
}
exposeClassAttributes(CompoundMessageFilter);
class MinimalMessageFilter extends CompoundMessageFilter {
  /**
   * Constructor
   */
  constructor() {
    let filters = [new ChatContextMessageFilter()];
    super(filters);
  }
}
exposeClassAttributes(MinimalMessageFilter);
let TYPE_TO_MESSAGE_FILTER_CLASS = { 0: MinimalMessageFilter, 1: MinimalMessageFilter, 2: MaximalMessageFilter, "UNKNOWN": MinimalMessageFilter, "MINIMAL": MinimalMessageFilter, "MAXIMAL": MaximalMessageFilter };
class MessageFilterFactory {
  /**
   * :param chat_filter: The ChatFilter dictionary to process.
   * :return: A MessageFilter that corresponds to the contents
   */
  static create_message_filter(chat_filter) {
    let _default = "MINIMAL";
    let chat_filter_type = _default;
    if (chat_filter != null) {
      chat_filter_type = dict.get(chat_filter, "chat_filter_type", chat_filter_type);
    }
    if (isinstance2(chat_filter_type, String)) {
      let chat_filter_type_string = chat_filter_type;
      chat_filter_type = chat_filter_type_string.toUpperCase();
    }
    let chat_filter_class = dict.get(TYPE_TO_MESSAGE_FILTER_CLASS, chat_filter_type);
    if (chat_filter_class == null) {
      chat_filter_class = dict.get(TYPE_TO_MESSAGE_FILTER_CLASS, _default);
    }
    let message_filter = new chat_filter_class();
    return message_filter;
  }
}
exposeClassAttributes(MessageFilterFactory);
class StructureMessageProcessor extends MessageProcessor {
  /**
   * Constructor
   *
   * :param structure_formats: Optional string or list of strings telling us to look for
   * specific formats within the text to separate out/extract
   * in a common way so that clients do not have to reinvent this wheel over
   * and over again.
   *
   * Valid values are:
   * "json" - look for JSON in the message content as structure to report.
   *
   * By default this is null, implying that such parsing is bypassed.
   */
  constructor(structure_formats) {
    super();
    this.structure_formats = structure_formats;
    if (this.structure_formats != null) {
      if (isinstance2(this.structure_formats, String)) {
        this.structure_formats = [this.structure_formats];
      }
    } else {
      this.structure_formats = [];
    }
    if (!isinstance2(this.structure_formats, Array)) {
      throw new Error(`Value '${structure_formats}' must be a string, a list of strings, or null`);
    }
  }
  /**
   * Process the message.
   * :param chat_message_dict: The ChatMessage dictionary to process.
   * :param message_type: The ChatMessageType of the chat_message_dictionary to process.
   */
  process_message(chat_message_dict, message_type) {
    if (message_type != ChatMessageType.AGENT_FRAMEWORK) {
      return;
    }
    let text = dict.get(chat_message_dict, "text");
    let structure = dict.get(chat_message_dict, "structure");
    if (structure != null) {
      return;
    }
    if (text == null || len(text) == 0) {
      return;
    }
    let structure_parser = new FirstAvailableStructureParser(this.structure_formats);
    let use_structure = structure_parser.parse_structure(text);
    if (use_structure == null) {
      return;
    }
    let use_text = structure_parser.get_remainder();
    chat_message_dict["text"] = use_text;
    chat_message_dict["structure"] = use_structure;
  }
}
exposeClassAttributes(StructureMessageProcessor);
export {
  AgentFrameworkMessage,
  AgentMessage,
  AgentProgressMessage,
  AgentToolResultMessage,
  AnswerMessageProcessor,
  BaseMessageDictionaryConverter,
  BasicMessageProcessor,
  ChatMessageType,
  ContentUtils,
  DecodeUtils,
  MaximalMessageFilter,
  MessageFilterFactory,
  MessageProcessor,
  SlyDataRedactor,
  StructureMessageProcessor,
  TracedMessage
};
