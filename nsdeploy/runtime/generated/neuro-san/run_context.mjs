import { exposeClassAttributes } from "../browser/shims.mjs";
import { len, TOP_LEVEL_DIR, dict, suppress, Limits, AsyncClient, PythonChatOpenAI, contains, isclass, issubclass, BaseModel, set, signature, is_dict, frozenset, Lock, callable, Field, create_model, format_exc, deepcopy, ContextVar, ConfigDict, Lock$1, contextmanager, copy_context, wait_for, TimeoutError, messages_to_dict, message_chunk_to_message, AgentMiddleware, create_agent, gethostname } from "./stubs.mjs";
import { isinstance2, iter2, hasattr2, getattr2, tuple2, type2, getLogger, getenv, BaseLanguageModel, slice2, sorted2, copy, warning, at2, uuid4, format2, any2, repr2, StructuredTool, MultiServerMCPClient, all2, BaseCallbackHandler, ToolMessage, registerConfigureHook, time, AIMessage, RunnablePassthrough, environ, max2, mergeConfigs, ensureConfig, reversed2, AIMessageChunk, enumerate2, SystemMessage, HumanMessage, BaseMessage, string2, loads, datetime } from "../vendor/libraries.mjs";
import { Resolver, ConfigUtil, ResolverUtil, DictionaryOverlay, DictionaryExtractor, DictionaryConverter, SensitiveLogger, ExceptionUtil } from "./leaf_common.mjs";
import { EnvironmentConfiguration, LingeringResource, AbstractAsyncConfigRestorer, ContextTypeLlmFactory, ContextTypeToolboxFactory, ExternalAgentParsing, ToolArgumentReporting, OriginatingJournal, Origination, MetadataUtil, AccumulatingAgentReservationist, ProgressJournal, ErrorDetector, InterceptingJournal, TracingContext, ContextTypeTracingContextFactory } from "./internals.mjs";
import { ContentUtils, AgentMessage, AgentToolResultMessage, AgentFrameworkMessage, BaseMessageDictionaryConverter } from "./message.mjs";
import { process } from "../browser/process.mjs";
class AgentNetworkInspector {
  /**
   * :return: The entire config dictionary given to the instance.
   */
  get_config() {
    throw Error("Method not implemented");
  }
  /**
   * :param name: The name of the agent tool to get out of the registry
   * :return: The dictionary representing the spec registered agent
   */
  get_agent_tool_spec(name) {
    throw Error("Method not implemented");
  }
  /**
   * :param agent_spec: A single agent to register
   * :return: The agent name as per the spec
   */
  get_name_from_spec(agent_spec) {
    throw Error("Method not implemented");
  }
  /**
   * :return: A single tool name to use as the root of the chat agent.
   * This guy will be user facing.  If there are none or > 1,
   * an exception will be raised.
   */
  find_front_man() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The size in Uint8Array of this AgentNetwork
   */
  get_size_in_bytes() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentNetworkInspector);
class LangChainLlmFactory extends EnvironmentConfiguration {
  /**
   * Create a LangChainLlmResources instance from the fully-specified llm config.
   *
   * This method is provided for backwards compatibility.
   * Prefer create_llm_resources() instead,
   * as this allows server infrastructure to better account for outstanding
   * connections to LLM providers when connections drop.
   *
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A BaseLanguageModel (can be Chat or LLM)
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_base_chat_model(config) {
    throw Error("Method not implemented");
  }
  /**
   * Create a LangChainLlmResources instance from the fully-specified llm config.
   *
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A LangChainLlmResources instance containing
   * a BaseLanguageModel (can be Chat or LLM) and a ClientPolicy
   * object that contains all related resources
   * necessary for managing the model run-time lifecycle.
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_llm_resources(config) {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(LangChainLlmFactory);
class LangChainLlmResources extends LingeringResource {
  /**
   * Constructor.
   * :param model: Language model used.
   * :param llm_policy: optional LlmPolicy object to manage connections to LLM host.
   */
  constructor(model, llm_policy) {
    super();
    this.model = model;
    this.llm_policy = llm_policy;
    this.child_resources = [];
  }
  /**
   * :return: Effectively this is the BaseLanguageModel to use.
   * Most of the time this is the model that was passed into the constructor,
   * however if add_fallback_resources() is employed, this can become a
   * a composite RunnableWithFallbacks.  The common ancestor of both
   * BaseLanguageModel and RunnableWithFallbacks is RunnableSerializable.
   */
  get_model() {
    return this.model;
  }
  /**
   * :return: the LlmPolicy used by the model
   */
  get_llm_policy() {
    return this.llm_policy;
  }
  /**
   * Add a child resource to this one.
   * :param llm_resources: a list of child LlmResources to use as fallbacks (in order)
   */
  add_fallback_resources(llm_resources) {
    if (llm_resources == null || !isinstance2(llm_resources, Array)) {
      return;
    }
    if (len(llm_resources) == 0) {
      return;
    }
    this.child_resources.push(...llm_resources);
    if (this.model) {
      let fallback_models = [];
      for (const one_resource of iter2(llm_resources)) {
        fallback_models.push(one_resource.get_model());
      }
      this.model = this.model.withFallbacks(fallback_models);
    }
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
    if (this.llm_policy != null) {
      await this.llm_policy.delete_resources();
    }
    for (const child_resource of this.child_resources) {
      await child_resource.close_of_work(this);
    }
  }
}
exposeClassAttributes(LangChainLlmResources);
class LlmInfoRestorer extends AbstractAsyncConfigRestorer {
  /**
   * Constructor
   */
  constructor() {
    super("llm_info");
  }
  /**
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: a string representing the file path to use
   */
  get_file_path(file_reference) {
    let use_file = file_reference;
    if (file_reference == null || len(file_reference) == 0) {
      use_file = TOP_LEVEL_DIR.get_file_in_basis("internals/run_context/langchain/llms/default_llm_info.hocon");
    }
    return use_file;
  }
}
exposeClassAttributes(LlmInfoRestorer);
class LlmPolicy extends EnvironmentConfiguration {
  /**
   * Constructor.
   *
   * :param llm: BaseLanguageModel
   */
  constructor(llm) {
    super();
    this.llm = llm;
    this.resolver = new Resolver();
  }
  /**
   * Creates the web client to used by a BaseLanguageModel to be
   * constructed in the future.  Neuro SAN infrastructures prefers that this
   * be an asynchronous client, however we realize some BaseLanguageModels
   * do not support that (even though they should!).
   *
   * Implementations should retain any references to state that needs to be cleaned up
   * in the delete_resources() method.
   *
   * :param config: The fully specified llm config
   * :return: The web client that accesses the LLM.
   * By default this is null, as many BaseLanguageModels
   * do not allow a web client to be passed in as an arg.
   */
  create_client(config) {
    let _ = config;
    return null;
  }
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    throw Error("Method not implemented");
  }
  /**
   * Release the run-time resources used by the instance.
   *
   * Unfortunately for many BaseLanguageModels, this tends to involve
   * a reach-in to its private internals in order to shutting down
   * any web client references in there.
   */
  async delete_resources() {
    throw Error("Method not implemented");
  }
  /**
   * Basic policy framework method.
   * Most LLMs will not need to override this.
   *
   * :param config: The fully specified llm config
   * :return: The components that go into populating an LlmResources instance.
   * This is a tuple of (BaseLanguageModel, LlmPolicy).
   * It's entirely fine if the LlmPolicy is not the same instance as this one.
   */
  create_llm_resources_components(config) {
    let client = null;
    try {
      client = this.create_client(config);
    } catch (e) {
      client = null;
    }
    let model_name = dict.get(config, "model_name") || dict.get(config, "model") || dict.get(config, "model_id");
    let llm = this.create_llm(config, model_name, client);
    if (client == null) {
      this.llm = llm;
    }
    return llm;
  }
}
exposeClassAttributes(LlmPolicy);
class AnthropicLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let ChatAnthropic = this.resolver.resolve_class_in_module("ChatAnthropic", { module_name: "langchain_anthropic.chat_models", install_if_missing: "langchain-anthropic" });
    let llm = new ChatAnthropic({ model_name, max_tokens: dict.get(config, "max_tokens"), temperature: dict.get(config, "temperature"), top_k: dict.get(config, "top_k"), top_p: dict.get(config, "top_p"), default_request_timeout: dict.get(config, "default_request_timeout"), max_retries: dict.get(config, "max_retries"), stop_sequences: dict.get(config, "stop_sequences"), anthropic_api_url: AnthropicLlmPolicy.get_value_or_env(config, "anthropic_api_url", "ANTHROPIC_API_URL"), anthropic_api_key: AnthropicLlmPolicy.get_value_or_env(config, "anthropic_api_key", "ANTHROPIC_API_KEY"), default_headers: dict.get(config, "default_headers"), betas: dict.get(config, "betas"), streaming: ConfigUtil.get_bool(config, "streaming"), stream_usage: ConfigUtil.get_bool(config, "streaming"), thinking: dict.get(config, "thinking"), effort: dict.get(config, "effort"), mcp_servers: dict.get(config, "mcp_servers"), context_management: dict.get(config, "context_management"), verbose: false });
    return llm;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    let anthropic_async_client = this.llm._async_client;
    if (anthropic_async_client != null) {
      const _resource = suppress(Error);
      try {
        await anthropic_async_client.aclose();
      } finally {
        _resource.close?.();
      }
    }
    this.llm = null;
  }
}
exposeClassAttributes(AnthropicLlmPolicy);
class AnthropicBedrockLlmPolicy extends AnthropicLlmPolicy {
  /**
   * Create a ChatAnthropicBedrock BaseLanguageModel.
   *
   * :param config: The fully specified llm config
   * :param model_name: The Bedrock inference-profile id, e.g.
   * "us.anthropic.claude-sonnet-4-6" or
   * "anthropic.claude-sonnet-4-5-20250929-v1:0".
   * :param client: Ignored — ChatAnthropicBedrock builds its own client.
   * :return: A BaseLanguageModel
   */
  create_llm(config, model_name, client) {
    const _ = client;
    const ChatAnthropicBedrock = this.resolver.resolve_class_in_module("ChatAnthropicBedrock", {
      module_name: "langchain_aws.chat_models.anthropic",
      install_if_missing: "langchain-aws[anthropic]"
    });
    const llm = new ChatAnthropicBedrock({
      model_name,
      max_tokens: dict.get(config, "max_tokens"),
      temperature: dict.get(config, "temperature"),
      top_k: dict.get(config, "top_k"),
      top_p: dict.get(config, "top_p"),
      default_request_timeout: dict.get(config, "default_request_timeout"),
      max_retries: dict.get(config, "max_retries"),
      stop_sequences: dict.get(config, "stop_sequences"),
      default_headers: dict.get(config, "default_headers"),
      betas: dict.get(config, "betas"),
      region_name: AnthropicBedrockLlmPolicy.get_value_or_env(config, "region_name", "AWS_REGION"),
      aws_access_key_id: AnthropicBedrockLlmPolicy.get_value_or_env(config, "aws_access_key_id", "AWS_ACCESS_KEY_ID"),
      aws_secret_access_key: AnthropicBedrockLlmPolicy.get_value_or_env(config, "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"),
      aws_session_token: AnthropicBedrockLlmPolicy.get_value_or_env(config, "aws_session_token", "AWS_SESSION_TOKEN"),
      streaming: ConfigUtil.get_bool(config, "streaming"),
      stream_usage: ConfigUtil.get_bool(config, "streaming"),
      thinking: dict.get(config, "thinking"),
      effort: dict.get(config, "effort"),
      mcp_servers: dict.get(config, "mcp_servers"),
      context_management: dict.get(config, "context_management"),
      verbose: false
    });
    return llm;
  }
}
exposeClassAttributes(AnthropicBedrockLlmPolicy);
class OpenAILlmPolicy extends LlmPolicy {
  static {
    this.LIMITS = new Limits({ max_connections: null, max_keepalive_connections: null });
  }
  /**
   * Constructor.
   */
  constructor(llm) {
    super();
    this.http_client = null;
    this.async_openai_client = null;
  }
  /**
   * Creates the web client to used by a BaseLanguageModel to be
   * constructed in the future.  Neuro SAN infrastructures prefers that this
   * be an asynchronous client, however we realize some BaseLanguageModels
   * do not support that (even though they should!).
   *
   * Implementations should retain any references to state that needs to be cleaned up
   * in the delete_resources() method.
   *
   * :param config: The fully specified llm config
   * :return: The web client that accesses the LLM.
   * By default this is null, as many BaseLanguageModels
   * do not allow a web client to be passed in as an arg.
   */
  create_client(config) {
    let AsyncOpenAI = this.resolver.resolve_class_in_module("AsyncOpenAI", { module_name: "openai", install_if_missing: "langchain-openai" });
    this.create_http_client(config);
    this.async_openai_client = new AsyncOpenAI({ api_key: OpenAILlmPolicy.get_value_or_env(config, "openai_api_key", "OPENAI_API_KEY"), base_url: OpenAILlmPolicy.get_value_or_env(config, "openai_api_base", "OPENAI_API_BASE"), organization: OpenAILlmPolicy.get_value_or_env(config, "openai_organization", "OPENAI_ORG_ID"), timeout: dict.get(config, "request_timeout"), max_retries: dict.get(config, "max_retries"), http_client: this.http_client });
    return this.async_openai_client.chat.completions;
  }
  /**
   * Creates the http client from the given config.
   *
   * :param config: The fully specified llm config
   */
  create_http_client(config) {
    let openai_proxy = OpenAILlmPolicy.get_value_or_env(config, "openai_proxy", "OPENAI_PROXY");
    let request_timeout = dict.get(config, "request_timeout");
    this.http_client = new AsyncClient({ proxy: openai_proxy, timeout: request_timeout, limits: this.LIMITS });
  }
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let ChatOpenAI = PythonChatOpenAI;
    let llm = new ChatOpenAI({ async_client: client, root_async_client: this.async_openai_client, model_name, temperature: dict.get(config, "temperature"), openai_api_key: OpenAILlmPolicy.get_value_or_env(config, "openai_api_key", "OPENAI_API_KEY", client), openai_api_base: OpenAILlmPolicy.get_value_or_env(config, "openai_api_base", "OPENAI_API_BASE", client), openai_organization: OpenAILlmPolicy.get_value_or_env(config, "openai_organization", "OPENAI_ORG_ID", client), openai_proxy: OpenAILlmPolicy.get_value_or_env(config, "openai_proxy", "OPENAI_PROXY", client), request_timeout: OpenAILlmPolicy.get_value_or_env(config, "request_timeout", null, client), max_retries: OpenAILlmPolicy.get_value_or_env(config, "max_retries", null, client), presence_penalty: dict.get(config, "presence_penalty"), frequency_penalty: dict.get(config, "frequency_penalty"), seed: dict.get(config, "seed"), logprobs: dict.get(config, "logprobs"), top_logprobs: dict.get(config, "top_logprobs"), logit_bias: dict.get(config, "logit_bias"), streaming: ConfigUtil.get_bool(config, "streaming"), top_p: dict.get(config, "top_p"), max_tokens: dict.get(config, "max_tokens"), tiktoken_model_name: dict.get(config, "tiktoken_model_name"), stop: dict.get(config, "stop"), reasoning: dict.get(config, "reasoning"), reasoning_effort: dict.get(config, "reasoning_effort"), verbosity: dict.get(config, "verbosity"), use_responses_api: dict.get(config, "use_responses_api"), verbose: false, stream_usage: ConfigUtil.get_bool(config, "streaming") });
    return llm;
  }
  /**
   * Release the run-time resources used by the instance.
   */
  async delete_resources() {
    this.async_openai_client = null;
    if (this.http_client != null) {
      const _resource = suppress(Error);
      try {
        await this.http_client.aclose();
      } finally {
        _resource.close?.();
      }
    }
    this.http_client = null;
  }
}
exposeClassAttributes(OpenAILlmPolicy);
class AzureLlmPolicy extends OpenAILlmPolicy {
  /**
   * Creates the web client to used by a BaseLanguageModel to be
   * constructed in the future.  Neuro SAN infrastructures prefers that this
   * be an asynchronous client, however we realize some BaseLanguageModels
   * do not support that (even though they should!).
   *
   * Implementations should retain any references to state that needs to be cleaned up
   * in the delete_resources() method.
   *
   * :param config: The fully specified llm config
   * :return: The web client that accesses the LLM.
   * By default this is null, as many BaseLanguageModels
   * do not allow a web client to be passed in as an arg.
   */
  create_client(config) {
    let AsyncAzureOpenAI = this.resolver.resolve_class_in_module("AsyncAzureOpenAI", { module_name: "openai", install_if_missing: "langchain-openai" });
    this.create_http_client(config);
    let openai_api_key = AzureLlmPolicy.get_value_or_env(config, "openai_api_key", "AZURE_OPENAI_API_KEY");
    if (openai_api_key == null) {
      openai_api_key = AzureLlmPolicy.get_value_or_env(config, "openai_api_key", "OPENAI_API_KEY");
    }
    let empty = {};
    let default_headers = dict.get(config, "default_headers", empty);
    Object.assign(default_headers, { "User-Agent": "langchain-partner-python-azure-openai" });
    this.async_openai_client = new AsyncAzureOpenAI({ azure_endpoint: AzureLlmPolicy.get_value_or_env(config, "azure_endpoint", "AZURE_OPENAI_ENDPOINT"), azure_deployment: AzureLlmPolicy.get_value_or_env(config, "deployment_name", "AZURE_OPENAI_DEPLOYMENT_NAME"), api_version: AzureLlmPolicy.get_value_or_env(config, "openai_api_version", "OPENAI_API_VERSION"), api_key: openai_api_key, azure_ad_token: AzureLlmPolicy.get_value_or_env(config, "azure_ad_token", "AZURE_OPENAI_AD_TOKEN"), organization: AzureLlmPolicy.get_value_or_env(config, "openai_organization", "OPENAI_ORG_ID"), base_url: AzureLlmPolicy.get_value_or_env(config, "openai_api_base", "OPENAI_API_BASE"), timeout: dict.get(config, "request_timeout"), max_retries: dict.get(config, "max_retries"), default_headers, http_client: this.http_client });
    return this.async_openai_client.chat.completions;
  }
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let AzureChatOpenAI = this.resolver.resolve_class_in_module("AzureChatOpenAI", { module_name: "langchain_openai.chat_models.azure", install_if_missing: "langchain-openai" });
    let openai_api_key = AzureLlmPolicy.get_value_or_env(config, "openai_api_key", "AZURE_OPENAI_API_KEY", client);
    if (openai_api_key == null) {
      openai_api_key = AzureLlmPolicy.get_value_or_env(config, "openai_api_key", "OPENAI_API_KEY", client);
    }
    let llm = new AzureChatOpenAI({ async_client: client, model_name, temperature: dict.get(config, "temperature"), openai_api_key, openai_api_base: AzureLlmPolicy.get_value_or_env(config, "openai_api_base", "OPENAI_API_BASE", client), openai_organization: AzureLlmPolicy.get_value_or_env(config, "openai_organization", "OPENAI_ORG_ID", client), openai_proxy: AzureLlmPolicy.get_value_or_env(config, "openai_proxy", "OPENAI_PROXY", client), request_timeout: AzureLlmPolicy.get_value_or_env(config, "request_timeout", null, client), max_retries: AzureLlmPolicy.get_value_or_env(config, "max_retries", null, client), presence_penalty: dict.get(config, "presence_penalty"), frequency_penalty: dict.get(config, "frequency_penalty"), seed: dict.get(config, "seed"), logprobs: dict.get(config, "logprobs"), top_logprobs: dict.get(config, "top_logprobs"), logit_bias: dict.get(config, "logit_bias"), streaming: ConfigUtil.get_bool(config, "streaming"), n: 1, top_p: dict.get(config, "top_p"), max_tokens: dict.get(config, "max_tokens"), tiktoken_model_name: dict.get(config, "tiktoken_model_name"), stop: dict.get(config, "stop"), verbose: false, azure_endpoint: AzureLlmPolicy.get_value_or_env(config, "azure_endpoint", "AZURE_OPENAI_ENDPOINT"), deployment_name: AzureLlmPolicy.get_value_or_env(config, "deployment_name", "AZURE_OPENAI_DEPLOYMENT_NAME", client), openai_api_version: AzureLlmPolicy.get_value_or_env(config, "openai_api_version", "OPENAI_API_VERSION"), azure_ad_token: AzureLlmPolicy.get_value_or_env(config, "azure_ad_token", "AZURE_OPENAI_AD_TOKEN", client), openai_api_type: AzureLlmPolicy.get_value_or_env(config, "openai_api_type", "OPENAI_API_TYPE", client), model_version: dict.get(config, "model_version") });
    return llm;
  }
}
exposeClassAttributes(AzureLlmPolicy);
class BedrockLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    const ChatBedrock = this.resolver.resolve_class_in_module("ChatBedrock", {
      module_name: "langchain_aws",
      install_if_missing: "langchain-aws"
    });
    const llm = new ChatBedrock({
      model: model_name,
      aws_access_key_id: BedrockLlmPolicy.get_value_or_env(config, "aws_access_key_id", "AWS_ACCESS_KEY_ID"),
      aws_secret_access_key: BedrockLlmPolicy.get_value_or_env(config, "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"),
      aws_session_token: BedrockLlmPolicy.get_value_or_env(config, "aws_session_token", "AWS_SESSION_TOKEN"),
      base_model_id: dict.get(config, "base_model_id"),
      beta_use_converse_api: dict.get(config, "beta_use_converse_api"),
      cache: dict.get(config, "cache"),
      config: dict.get(config, "config"),
      credentials_profile_name: dict.get(config, "credentials_profile_name"),
      custom_get_token_ids: dict.get(config, "custom_get_token_ids"),
      endpoint_url: dict.get(config, "endpoint_url"),
      guardrails: dict.get(config, "guardrails"),
      max_tokens: dict.get(config, "max_tokens"),
      metadata: dict.get(config, "metadata"),
      provider: dict.get(config, "provider"),
      rate_limiter: dict.get(config, "rate_limiter"),
      region_name: dict.get(config, "region_name"),
      stop_sequences: dict.get(config, "stop_sequences"),
      streaming: ConfigUtil.get_bool(config, "streaming"),
      system_prompt_with_tools: dict.get(config, "system_prompt_with_tools"),
      tags: dict.get(config, "tags"),
      temperature: dict.get(config, "temperature"),
      verbose: false
    });
    return llm;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    if (this.llm.client != null) {
      this.llm.client.close();
    }
    if (this.llm.bedrock_client != null) {
      this.llm.bedrock_client.close();
    }
    this.llm = null;
  }
}
exposeClassAttributes(BedrockLlmPolicy);
class GeminiLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let ChatGoogleGenerativeAI = this.resolver.resolve_class_in_module("ChatGoogleGenerativeAI", { module_name: "langchain_google_genai.chat_models", install_if_missing: "langchain-google-genai" });
    let llm = new ChatGoogleGenerativeAI({ model: model_name, google_api_key: GeminiLlmPolicy.get_value_or_env(config, "google_api_key", "GOOGLE_API_KEY"), max_retries: dict.get(config, "max_retries"), max_tokens: dict.get(config, "max_tokens"), n: dict.get(config, "n"), temperature: dict.get(config, "temperature"), timeout: dict.get(config, "timeout"), top_k: dict.get(config, "top_k"), top_p: dict.get(config, "top_p"), thinking_level: dict.get(config, "thinking_level"), thinking_budget: dict.get(config, "thinking_budget"), include_thoughts: dict.get(config, "include_thoughts"), streaming: ConfigUtil.get_bool(config, "streaming"), verbose: false });
    return this._disable_afc(llm);
  }
  /**
   * Explicitly disable the google-genai SDK's Automatic Function Calling (AFC)
   * on the given llm, if the environment allows it.
   *
   * AFC is a client-side convenience feature of the google-genai SDK that can
   * only auto-execute tools passed to the SDK as Python callables.  LangChain
   * binds tools as function declarations (schemas), so AFC can never execute
   * anything here -- function calling is governed entirely by neuro-san's own
   * agent loop.  However, when AFC is not explicitly disabled, the SDK logs a
   * misleading "AFC is enabled with max remote calls: 10." INFO banner on
   * LLM calls made with no tools bound (e.g. by agents with no down-chain
   * tools).  Disabling AFC is behaviorally a no-op that silences that banner.
   * See https://github.com/cognizant-ai-lab/neuro-san/issues/1096
   *
   * ChatGoogleGenerativeAI has no constructor argument for this -- the setting
   * is only honored as a per-request kwarg -- hence bind().
   *
   * Note that requests with tools bound do not inherit bind() kwargs, so they
   * do not carry the explicit disable.  They are banner-free regardless:
   * google-genai >= 1.48 skips its AFC path entirely for declaration-style
   * tools, and langchain-google-genai >= 4.1.2 (our floor) requires
   * google-genai >= 1.56.
   *
   * :param llm: The ChatGoogleGenerativeAI instance to disable AFC on.
   * :return: llm.bind(...) with AFC disabled, which behaves like the original
   * llm.  The original llm is returned unchanged when the environment
   * cannot support the bind:
   * * Without the google-genai SDK (langchain-google-genai < 4.0 builds
   * on google-ai-generativelanguage), there is no AFC to disable.
   * * On langchain-core < 1.4, bind() returns a generic RunnableBinding
   * with no bind_tools() method, which would break agent creation for
   * agents with tools.  There the cosmetic banner is left alone.
   */
  _disable_afc(llm) {
    let AutomaticFunctionCallingConfig = this.resolver.resolve_class_in_module("AutomaticFunctionCallingConfig", { module_name: "google.genai.types", raise_if_not_found: false });
    if (AutomaticFunctionCallingConfig == null) {
      return llm;
    }
    let bound = llm.bind({ automatic_function_calling: new AutomaticFunctionCallingConfig({ disable: true }) });
    if (!hasattr2(bound, "bind_tools")) {
      return llm;
    }
    return bound;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    let base_llm = getattr2(this.llm, "bound", this.llm);
    if (base_llm.client != null) {
      const _resource = suppress(Error);
      try {
        base_llm.client.close();
      } finally {
        _resource.close?.();
      }
    }
    if (base_llm.async_client != null) {
      const _resource = suppress(Error);
      try {
        await base_llm.async_client.aclose();
      } finally {
        _resource.close?.();
      }
    }
    this.llm = null;
  }
}
exposeClassAttributes(GeminiLlmPolicy);
class NvidiaLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    const ChatNVIDIA = this.resolver.resolve_class_in_module("ChatNVIDIA", {
      module_name: "langchain_nvidia_ai_endpoints",
      install_if_missing: "langchain-nvidia-ai-endpoints"
    });
    const llm = new ChatNVIDIA({
      base_url: dict.get(config, "base_url"),
      model: model_name,
      temperature: dict.get(config, "temperature"),
      max_tokens: dict.get(config, "max_tokens"),
      top_p: dict.get(config, "top_p"),
      seed: dict.get(config, "seed"),
      stop: dict.get(config, "stop"),
      verbose: false,
      nvidia_api_key: NvidiaLlmPolicy.get_value_or_env(config, "nvidia_api_key", "NVIDIA_API_KEY"),
      nvidia_base_url: NvidiaLlmPolicy.get_value_or_env(config, "nvidia_base_url", "NVIDIA_BASE_URL")
    });
    return llm;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    this.llm = null;
  }
}
exposeClassAttributes(NvidiaLlmPolicy);
class OllamaLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let ChatOllama = this.resolver.resolve_class_in_module("ChatOllama", { module_name: "langchain_ollama", install_if_missing: "langchain-ollama" });
    let llm = new ChatOllama({ model: model_name, mirostat: dict.get(config, "mirostat"), mirostat_eta: dict.get(config, "mirostat_eta"), mirostat_tau: dict.get(config, "mirostat_tau"), num_ctx: dict.get(config, "num_ctx"), num_gpu: dict.get(config, "num_gpu"), num_thread: dict.get(config, "num_thread"), num_predict: dict.get(config, "num_predict", dict.get(config, "max_tokens")), reasoning: dict.get(config, "reasoning"), repeat_last_n: dict.get(config, "repeat_last_n"), repeat_penalty: dict.get(config, "repeat_penalty"), temperature: dict.get(config, "temperature"), seed: dict.get(config, "seed"), stop: dict.get(config, "stop"), tfs_z: dict.get(config, "tfs_z"), top_k: dict.get(config, "top_k"), top_p: dict.get(config, "top_p"), keep_alive: dict.get(config, "keep_alive"), base_url: dict.get(config, "base_url"), verbose: false });
    return llm;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    let ollama_async_client = this.llm._async_client;
    if (ollama_async_client != null) {
      const _resource = suppress(Error);
      try {
        await ollama_async_client._client.aclose();
      } finally {
        _resource.close?.();
      }
    }
    this.llm = null;
  }
}
exposeClassAttributes(OllamaLlmPolicy);
class OpenRouterLlmPolicy extends LlmPolicy {
  /**
   * Create a BaseLanguageModel instance from the fully-specified llm config
   * for the llm class that the implementation supports.  Chat models are usually
   * per-provider, where the specific model itself is an argument to its constructor.
   *
   * :param config: The fully specified llm config
   * :param model_name: The name of the model
   * :param client: The web client to use (if any)
   * :return: A BaseLanguageModel (can be Chat or LLM)
   */
  create_llm(config, model_name, client) {
    let ChatOpenRouter = this.resolver.resolve_class_in_module("ChatOpenRouter", { module_name: "langchain_openrouter.chat_models", install_if_missing: "langchain-openrouter" });
    let llm = new ChatOpenRouter({ model: model_name, api_key: OpenRouterLlmPolicy.get_value_or_env(config, "openrouter_api_key", "OPENROUTER_API_KEY"), base_url: OpenRouterLlmPolicy.get_value_or_env(config, "openrouter_api_base", "OPENROUTER_API_BASE"), timeout: dict.get(config, "request_timeout"), max_retries: dict.get(config, "max_retries"), temperature: dict.get(config, "temperature"), max_tokens: dict.get(config, "max_tokens"), top_p: dict.get(config, "top_p"), frequency_penalty: dict.get(config, "frequency_penalty"), presence_penalty: dict.get(config, "presence_penalty"), seed: dict.get(config, "seed"), stop_sequences: dict.get(config, "stop"), streaming: ConfigUtil.get_bool(config, "streaming"), stream_usage: ConfigUtil.get_bool(config, "streaming"), reasoning: dict.get(config, "reasoning"), openrouter_provider: dict.get(config, "openrouter_provider"), route: dict.get(config, "route"), session_id: dict.get(config, "session_id"), trace: dict.get(config, "trace"), verbose: false });
    return llm;
  }
  /**
   * Release the run-time resources used by the model
   */
  async delete_resources() {
    if (this.llm == null) {
      return;
    }
    let sdk_client = getattr2(this.llm, "client", null);
    if (sdk_client != null) {
      for (const attr of tuple2("aclose", "close")) {
        let method = getattr2(sdk_client, attr, null);
        if (method == null) {
          continue;
        }
        const _resource = suppress(Error);
        try {
          let result = method();
          if (hasattr2(result, "__await__")) {
            await result;
          }
        } finally {
          _resource.close?.();
        }
        break;
      }
    }
    this.llm = null;
  }
}
exposeClassAttributes(OpenRouterLlmPolicy);
class StandardLangChainLlmFactory extends LangChainLlmFactory {
  /**
   * Constructor
   *
   * :param class_to_llm_policy_type: A dictionary mapping llm class names
   * used in an llm_info.hocon file to python types that represent
   * the correspoinding LlmPolicy implementation.
   *
   * The default value is null, allowing for the stock lookup table
   * for the base library to be used for the instance.
   *
   * Subclasses can pass in their own lookup table if desired,
   * making the extension of the library easier.
   */
  constructor(class_to_llm_policy_type) {
    super();
    this.class_to_llm_policy_type = class_to_llm_policy_type;
    if (this.class_to_llm_policy_type == null) {
      this.class_to_llm_policy_type = { "anthropic": AnthropicLlmPolicy, "anthropic-bedrock": AnthropicBedrockLlmPolicy, "azure-openai": AzureLlmPolicy, "bedrock": BedrockLlmPolicy, "gemini": GeminiLlmPolicy, "nvidia": NvidiaLlmPolicy, "openai": OpenAILlmPolicy, "openrouter": OpenRouterLlmPolicy, "ollama": OllamaLlmPolicy };
    }
  }
  /**
   * Create a BaseLanguageModel from the fully-specified llm config.
   *
   * This method is provided for backwards compatibility.
   * Prefer create_llm_resources() instead,
   * as this allows server infrastructure to better account for outstanding
   * connections to LLM providers when connections drop.
   *
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A BaseLanguageModel (can be Chat or LLM)
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_base_chat_model(config) {
    throw Error("Method not implemented");
  }
  /**
   * Create a BaseLanguageModel from the fully-specified llm config.
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A LangChainLlmResources instance containing
   * a BaseLanguageModel (can be Chat or LLM) and all related resources
   * necessary for managing the model run-time lifecycle.
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_llm_resources(config) {
    let llm = null;
    let chat_class = dict.get(config, "class");
    if (chat_class != null) {
      chat_class = chat_class.toLowerCase();
    }
    let model_name = dict.get(config, "model_name") || dict.get(config, "model") || dict.get(config, "model_id");
    let llm_policy = null;
    let policy_class = dict.get(this.class_to_llm_policy_type, chat_class);
    if (policy_class != null) {
      let llm_policy_instance = new policy_class();
      llm = llm_policy_instance.create_llm_resources_components(config);
      llm_policy = llm_policy_instance;
    } else if (chat_class == null) {
      throw new Error(`Class name ${chat_class} for model_name ${model_name} is unspecified.`);
    } else {
      throw new Error(`Class ${chat_class} for model_name ${model_name} is unrecognized.`);
    }
    return new LangChainLlmResources(llm, llm_policy);
  }
}
exposeClassAttributes(StandardLangChainLlmFactory);
let API_KEY_EXCEPTIONS = { "OPENAI_API_KEY": ["OPENAI_API_KEY", "Incorrect API key provided"], "ANTHROPIC_API_KEY": ["ANTHROPIC_API_KEY", "anthropic_api_key", "invalid x-api-key", "credit balance"], "GOOGLE_API_KEY": ["Application Default Credentials", "default credentials", "Gemini: 400 API key not valid"], "OPENROUTER_API_KEY": ["OPENROUTER_API_KEY", "openrouter_api_key", "Missing Authentication header", "No auth credentials found", "Insufficient credits", "openrouter.ai/settings/credits"], "AZURE_OPENAI_API_KEY": ["invalid subscription key", "wrong API endpoint"], "AZURE_OPENAI_ENDPOINT": ["base_url", "azure_endpoint", "AZURE_OPENAI_ENDPOINT"], "OPENAI_API_VERSION": ["api_version", "OPENAI_API_VERSION"], "AZURE_OPENAI_DEPLOYMENT_NAME": ["API deployment for this resource does not exist"] };
let AZURE_DOCUMENTATION = "https://learn.microsoft.com/en-us/azure/ai-services/openai/";
"chatgpt-quickstart?tabs=keyless%2Ctypescript-keyless%2Cpython-new%2Ccommand-line&pivots=programming-language-python";
let API_KEY_DOCUMENTATION = { "AZURE_OPENAI_API_KEY": AZURE_DOCUMENTATION, "AZURE_OPENAI_ENDPOINT": AZURE_DOCUMENTATION, "OPENAI_API_VERSION": AZURE_DOCUMENTATION, "AZURE_OPENAI_DEPLOYMENT_NAME": AZURE_DOCUMENTATION };
let INTERNAL_ERRORS_LIST = ["bound to a different event loop"];
class ApiKeyErrorCheck {
  /**
   * :param exception: An exception to check
   * :return: A more helpful exception message if it relates to an API key or null
   * if it does not pertain to an API key.
   */
  static check_for_api_key_exception(exception) {
    let exception_message = String(exception);
    let matched_keys = [];
    let matched_documentation_link = "";
    for (const [api_key, string_list] of Object.entries(API_KEY_EXCEPTIONS)) {
      for (const find_string of iter2(string_list)) {
        if (contains(find_string, exception_message)) {
          matched_keys.push(api_key);
          matched_documentation_link = dict.get(API_KEY_DOCUMENTATION, api_key, "");
          break;
        }
      }
    }
    if (matched_keys) {
      let keys_str = matched_keys.join(", ");
      return `
A value for the ${keys_str} environment variable must be correctly set in the neuro-san
server or run-time environment in order to use this agent network.

Some things to try:
1) Double check that your value for ${keys_str} is set correctly
2) If you do not have a value for ${keys_str}, visit the LLM provider's website to get one ${matched_documentation_link}
3) It's possible that your credit balance on your account with the LLM provider is too low
   to make the request.  Check that.
4) Sometimes these errors happen because of firewall blockages to the site that hosts the LLM.
   Try checking that you can reach the regular UI for the LLM from a web browser
   on the same machine making this request.
`;
    }
    if (ApiKeyErrorCheck._is_pydantic_validation_error(exception)) {
      return ApiKeyErrorCheck._format_redacted_pydantic_error(exception);
    }
    return null;
  }
  /**
   * Return a log-safe representation of the exception. For pydantic
   * ValidationErrors, returns the structured-error-derived message
   * (with `input` redacted) so user-supplied values can't leak into
   * server logs. For all other exception types, returns String(exception),
   * which preserves useful debug detail (status codes, request IDs).
   */
  static get_safe_log_message(exception) {
    if (ApiKeyErrorCheck._is_pydantic_validation_error(exception)) {
      return ApiKeyErrorCheck._format_redacted_pydantic_error(exception);
    }
    return String(exception);
  }
  /**
   * Duck-typed check for pydantic_core.ValidationError to avoid a hard import
   * on pydantic_core from this util module.
   */
  static _is_pydantic_validation_error(exception) {
    let cls = type2(exception);
    return this.name == "ValidationError" && this.__module__.startsWith("pydantic");
  }
  /**
   * Build a message from a pydantic ValidationError using its structured
   * .errors() data, redacting the 'input' field entirely so user-supplied
   * values can't leak.
   */
  static _format_redacted_pydantic_error(exception) {
    let parts = [];
    for (const err of exception.errors()) {
      let loc = [...(function* () {
        for (const x of dict.get(err, "loc", tuple2()))
          yield String(x);
      })()].join(".");
      let msg = dict.get(err, "msg", "");
      let err_type = dict.get(err, "type", "");
      parts.push(`${loc}: ${msg} [type=${err_type}, input=<redacted>]`);
    }
    return `${len(parts)} validation error(s): ` + parts.join(";\n");
  }
  /**
   * Check if exception traceback points to some internal LLM stack problem,
   * not necessarily related to API keys being absent or invalid.
   * This function used as an additional check while using check_for_api_key_exception()
   * :param exception_traceback: exception traceback string;
   * :return: True if exception seems to be caused by some internal problems,
   * False otherwise
   */
  static check_for_internal_error(exception_traceback) {
    for (const err_msg of iter2(INTERNAL_ERRORS_LIST)) {
      if (contains(err_msg, exception_traceback)) {
        return true;
      }
    }
    return false;
  }
}
exposeClassAttributes(ApiKeyErrorCheck);
class ArgumentValidator {
  /**
   * Check for invalid arguments in a class constructor or method call.
   *
   * :param method_class: The class or method to validate against.
   * :param args: Dictionary of argument to check.
   * :raises Error: If any argument name is not accepted by the method or class.
   */
  static check_invalid_args(method_class, args) {
    let class_args_set = null;
    if (isclass(method_class) && issubclass(method_class, BaseModel)) {
      class_args_set = ArgumentValidator.get_base_model_args(method_class);
    } else {
      class_args_set = set(signature(method_class).parameters.keys());
    }
    let args_set = set(Object.keys(args));
    let invalid_args = new Set([...args_set].filter((one) => !class_args_set.has(one)));
    if (invalid_args) {
      throw new Error(`Arguments ${invalid_args} for '${method_class.name}' do not match any attributes of the class or any arguments of the method.`);
    }
  }
  /**
   * Extract all field names and aliases from a Pydantic BaseModel class.
   *
   * :param base_model_class: A class that inherits from `BaseModel`.
   * :return: A set of valid argument names, including both field names and aliases.
   */
  static get_base_model_args(base_model_class) {
    let fields_and_aliases = set();
    for (const [field_name, field_info] of Object.entries(base_model_class.model_fields)) {
      fields_and_aliases.add(field_name);
      if (field_info.alias) {
        fields_and_aliases.add(field_info.alias);
      }
    }
    return fields_and_aliases;
  }
}
exposeClassAttributes(ArgumentValidator);
let KEYS_TO_REMOVE_FOR_USER_CLASS = set(["class", "verbose"]);
let API_KEY_ERRORS = ResolverUtil.create_type_tuple(["google.auth.exceptions.DefaultCredentialsError", "openai.OpenAIError", "pydantic_core.ValidationError"]);
class DefaultLlmFactory extends ContextTypeLlmFactory {
  /**
   * Constructor
   *
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and agent_llm_info_file
   */
  constructor(config) {
    super();
    this.logger = getLogger(this.constructor.name);
    this.llm_infos = {};
    this.overlayer = new DictionaryOverlay();
    this.llm_factories = [new StandardLangChainLlmFactory()];
    let raw_llm_info_file = null;
    if (config) {
      raw_llm_info_file = dict.get(config, "llm_info_file") || getenv("AGENT_LLM_INFO_FILE");
    } else {
      raw_llm_info_file = getenv("AGENT_LLM_INFO_FILE");
    }
    if (raw_llm_info_file != null && !isinstance2(raw_llm_info_file, String)) {
      throw new Error(`The values of 'llm_info_file' and the 'AGENT_LLM_INFO_FILE' environment variable must be strings. Got ${type2(raw_llm_info_file)} instead.`);
    }
    this.llm_info_file = raw_llm_info_file;
  }
  /**
   * Loads the LLM information from hocon files.
   */
  load() {
    let restorer = new LlmInfoRestorer();
    this.llm_infos = restorer.restore();
    if (this.llm_info_file) {
      let extra_llm_infos = restorer.restore({ file_reference: this.llm_info_file });
      this.llm_infos = this.overlayer.overlay(this.llm_infos, extra_llm_infos);
    }
    let extractor = new DictionaryExtractor(this.llm_infos, ".");
    let llm_factory_classes = [];
    llm_factory_classes = extractor.get("classes.factories", llm_factory_classes);
    if (!isinstance2(llm_factory_classes, Array)) {
      throw new Error(`The classes.factories key in ${this.llm_info_file} must be a list of strings`);
    }
    for (const llm_factory_class_name of iter2(llm_factory_classes)) {
      let llm_factory = this.resolve_one_llm_factory(llm_factory_class_name, this.llm_info_file);
      this.llm_factories.push(llm_factory);
    }
  }
  /**
   * :param llm_factory_class_name: A single class name to resolve.
   * :param llm_info_file: The name of the hocon file with the class names, to reference
   * when exceptions are thrown.
   * :return: A LangChainLlmFactory instance as per the input
   */
  resolve_one_llm_factory(llm_factory_class_name, llm_info_file) {
    if (!isinstance2(llm_factory_class_name, String)) {
      throw new Error(`The value for the classes.factories key in ${llm_info_file} must be a list of strings`);
    }
    let llm_factory = ResolverUtil.create_instance({ class_name: llm_factory_class_name, class_name_source: llm_info_file, type_of_class: LangChainLlmFactory });
    return llm_factory;
  }
  /**
   * Creates a langchain LLM based on the 'model_name' value of
   * the config passed in.
   *
   * :param config: A dictionary which describes which LLM to use.
   * See the class comment for details.
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :return: A LangChainLlmResources instance containing
   * a BaseLanguageModel (can be Chat or LLM) and all related resources
   * necessary for managing the model run-time lifecycle.
   * Can also return a set of strings describing any required sly_data API keys that are not provided.
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_llm(config, sly_data) {
    let full_config = this.create_full_llm_config(config, sly_data);
    if (full_config == null || isinstance2(full_config, Set)) {
      return full_config;
    }
    let llm_resources = this.create_llm_resources(full_config);
    return llm_resources;
  }
  /**
   * :param config: The llm_config from the user
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :return: The fully specified config with defaults filled in.
   * Can also return a set of strings describing any required sly_data API keys that are not provided.
   */
  create_full_llm_config(config, sly_data) {
    let full_config = null;
    let class_from_llm_config = dict.get(config, "class");
    if (class_from_llm_config) {
      if (!isinstance2(class_from_llm_config, String)) {
        throw new Error("Value of 'class' has to be string.");
      }
      let config_from_class_in_llm_info = this.get_chat_class_args(class_from_llm_config);
      full_config = this.overlayer.overlay(config_from_class_in_llm_info, config);
      full_config = this.replace_any_required_api_keys(full_config, sly_data);
      return full_config;
    }
    let default_config = dict.get(this.llm_infos, "default_config");
    let use_config = this.overlayer.overlay(default_config, config);
    let model_name = dict.get(use_config, "model_name");
    let llm_entry = dict.get(this.llm_infos, model_name);
    if (llm_entry == null) {
      throw new Error(`No llm entry for model_name ${model_name}`);
    }
    let use_model_name = dict.get(llm_entry, "use_model_name", model_name);
    if (len(Object.keys(llm_entry)) <= 2 && use_model_name != null) {
      llm_entry = dict.get(this.llm_infos, use_model_name);
      if (llm_entry == null) {
        throw new Error(`No llm entry for use_model_name ${use_model_name} in ${model_name}`);
      }
    }
    let chat_class_name = dict.get(llm_entry, "class");
    if (chat_class_name == null) {
      throw new Error(`llm info entry for ${use_model_name} requires a 'class' key/value pair.`);
    }
    let chat_args = this.get_chat_class_args(chat_class_name, use_model_name);
    default_config = this.overlayer.overlay(chat_args, default_config);
    full_config = this.overlayer.overlay(default_config, config);
    full_config["class"] = chat_class_name;
    full_config["model_name"] = dict.get(llm_entry, "use_model_name", use_model_name);
    full_config = this.replace_any_required_api_keys(full_config, sly_data);
    if (full_config != null && !isinstance2(full_config, Set)) {
      full_config["max_tokens"] = this.get_max_prompt_tokens(full_config);
    }
    return full_config;
  }
  /**
   * :param chat_class_name: string name of the chat class to look up.
   * :param use_model_name: the original model name that prompted the chat class lookups
   * :return: A dictionary of default arguments for the chat class.
   * Can throw an exception if the chat class does not exist.
   */
  get_chat_class_args(chat_class_name, use_model_name) {
    let chat_classes = dict.get(this.llm_infos, "classes");
    let chat_class = dict.get(chat_classes, chat_class_name);
    if (chat_class == null) {
      if (use_model_name != null) {
        throw new Error(`llm info entry for ${use_model_name} uses a 'class' of ${chat_class_name} which is not defined in the 'classes' table.`);
      }
      return {};
    }
    let args = dict.get(chat_class, "args");
    let _extends = dict.get(chat_class, "extends");
    if (_extends != null) {
      let extends_args = this.get_chat_class_args(_extends, use_model_name);
      args = this.overlayer.overlay(args, extends_args);
    }
    return args;
  }
  /**
   * Get any required api keys into the config.
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :return: The config with any required api keys replaced, or a set of missing
   * required config field names if any required api keys were not provided.
   */
  replace_any_required_api_keys(config, sly_data) {
    let use_api_keys = {};
    if (sly_data != null && is_dict(sly_data)) {
      use_api_keys = dict.get(sly_data, "llm_config", use_api_keys);
    }
    let required_set = set();
    for (const [key, value] of Object.entries(config)) {
      let small_value = String(value).toLowerCase();
      if (small_value == "sly_data") {
        let new_value = dict.get(use_api_keys, key);
        if (new_value != null) {
          if (isinstance2(new_value, String)) {
            new_value = new_value.trim();
          }
          config[key] = new_value;
        } else {
          required_set.add(key);
        }
      }
    }
    if (len(required_set) > 0) {
      return required_set;
    }
    return config;
  }
  /**
   * Create a BaseLanguageModel from the fully-specified llm config.
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A BaseLanguageModel (can be Chat or LLM)
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_base_chat_model(config) {
    throw Error("Method not implemented");
  }
  /**
   * Create a BaseLanguageModel from the fully-specified llm config either from standard LLM factory,
   * user-defined LLM factory, or user-specified langchain model class.
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   * :return: A LangChainLlmResources instance containing
   * a BaseLanguageModel (can be Chat or LLM) and all related resources
   * necessary for managing the model run-time lifecycle.
   * Can raise a Error if the config's class or model_name value is
   * unknown to this method.
   */
  create_llm_resources(config) {
    let llm_resources = null;
    let found_exception = null;
    for (const llm_factory of this.llm_factories) {
      try {
        llm_resources = llm_factory.create_llm_resources(config);
        if (llm_resources != null && isinstance2(llm_resources, LangChainLlmResources)) {
          found_exception = null;
          break;
        }
        found_exception = null;
      } catch (e) {
        if (e instanceof Error) {
          let llm = llm_factory.create_base_chat_model(config);
          if (llm != null) {
            if (isinstance2(llm, LangChainLlmResources)) {
              found_exception = null;
              break;
            }
            if (isinstance2(llm, BaseLanguageModel)) {
              llm_resources = new LangChainLlmResources(llm, null);
              found_exception = null;
              break;
            }
          }
          found_exception = null;
        } else if (e instanceof Error) {
          const exception = e;
          let message = ApiKeyErrorCheck.check_for_api_key_exception(exception);
          if (message != null) {
            throw new Error(message);
          }
          found_exception = exception;
        } else if (e instanceof Error) {
          const exception = e;
          found_exception = exception;
        }
      }
    }
    let class_path = dict.get(config, "class");
    let default_llm_classes = set(dict.get(this.llm_infos, "classes"));
    if (llm_resources == null && found_exception != null && !contains(class_path, default_llm_classes)) {
      let llm = this.create_base_chat_model_from_user_class(class_path, config);
      llm_resources = new LangChainLlmResources(llm);
      found_exception = null;
    }
    if (found_exception != null) {
      throw found_exception;
    }
    return llm_resources;
  }
  /**
   * Create a BaseLanguageModel from the user-specified langchain model class.
   * :param class_path: A string in the form of <package>.<module>.<Class>
   * :param config: The fully specified llm config which is a product of
   * _create_full_llm_config() above.
   *
   * :return: A BaseLanguageModel
   */
  create_base_chat_model_from_user_class(class_path, config) {
    if (!isinstance2(class_path, String)) {
      throw new Error("'class' in llm_config must be a string");
    }
    let llm_class = ResolverUtil.create_class({ class_name: class_path, class_name_source: "agent network hocon file", type_of_class: BaseLanguageModel });
    let user_config = {};
    for (const [llm_config_key, llm_config_value] of Object.entries(config)) {
      if (!contains(llm_config_key, KEYS_TO_REMOVE_FOR_USER_CLASS)) {
        user_config[llm_config_key] = llm_config_value;
      }
    }
    ArgumentValidator.check_invalid_args(llm_class, user_config);
    return llm_class(user_config);
  }
  /**
   * :param config: A dictionary which describes which LLM to use.
   * :return: The maximum number of tokens given the 'model_name' in the
   * config dictionary, or null if the llm entry does not declare a
   * fixed max_output_tokens (e.g. OpenRouter meta-routers where the
   * underlying model is chosen per-request).
   */
  get_max_prompt_tokens(config) {
    let model_name = dict.get(config, "model_name");
    let llm_entry = dict.get(this.llm_infos, model_name);
    if (llm_entry == null) {
      throw new Error(`No llm entry for model_name ${model_name}`);
    }
    let use_model_name = dict.get(llm_entry, "use_model_name", model_name);
    if (len(Object.keys(llm_entry)) <= 2 && use_model_name != null) {
      llm_entry = dict.get(this.llm_infos, use_model_name);
    }
    let entry_max_tokens = dict.get(llm_entry, "max_output_tokens");
    let prompt_token_fraction = dict.get(config, "prompt_token_fraction");
    let use_max_tokens = null;
    if (entry_max_tokens != null && prompt_token_fraction != null) {
      use_max_tokens = Number(entry_max_tokens * prompt_token_fraction);
    }
    let max_prompt_tokens = dict.get(config, "max_tokens", use_max_tokens);
    if (max_prompt_tokens == null) {
      max_prompt_tokens = use_max_tokens;
    }
    return max_prompt_tokens;
  }
  /**
   * :param config: A dictionary which describes which LLM to use, perhaps with fallbacks specified.
   * :param sly_data: A user-provided dictionary of private data,
   * from which we might extract API keys to use for user billing.
   * Can be null indicating no API keys are provided at all and the system defaults will be used.
   * :param num_fallbacks: The number of fallbacks to try. Default value of null implies all.
   * :param randomize_peers: If True, randomize the order of the fallbacks within the group.
   * :return: A LangChainLlmResources instance or if no valid llm was found or
   * a dictionary whose keys are error types and whose values are lists of error strings
   * for that type.  If there were valid and useable fallbacks specified,
   * those will be set up as fallbacks for the model on the LlmResources object.
   */
  create_llm_withFallbacks(config, sly_data, num_fallbacks, randomize_peers) {
    let fallbacks = [config];
    fallbacks = dict.get(config, "fallbacks", fallbacks);
    let main_llm_resources = null;
    let fallback_llm_resources = [];
    let required_sly_data = set();
    let api_key_errors = set();
    let construction_errors = set();
    if (num_fallbacks != null) {
      if (num_fallbacks < 0) {
        fallbacks = slice2(fallbacks, num_fallbacks, void 0);
      } else {
        fallbacks = slice2(fallbacks, void 0, num_fallbacks);
      }
    }
    for (const fallback of iter2(fallbacks)) {
      let one_llm_resources = null;
      if (isinstance2(fallback, Array)) {
        let sub_config = { "fallbacks": fallback };
        one_llm_resources = this.create_llm_withFallbacks(sub_config, { sly_data, num_fallbacks: null, randomize_peers: true });
        if (is_dict(one_llm_resources)) {
          Object.assign(api_key_errors, dict.get(one_llm_resources, "api_key_errors", []));
          Object.assign(construction_errors, dict.get(one_llm_resources, "construction_errors", []));
          Object.assign(required_sly_data, dict.get(one_llm_resources, "required_sly_data_errors", []));
          continue;
        }
      }
      try {
        if (one_llm_resources == null) {
          one_llm_resources = this.create_llm(fallback, sly_data);
        }
      } catch (exception) {
        if (exception.__cause__ != null) {
          let cause = exception.__cause__;
          let message = ApiKeyErrorCheck.check_for_api_key_exception(cause);
          if (message != null) {
            message = ApiKeyErrorCheck.get_safe_log_message(exception);
            api_key_errors.add(message);
            continue;
          }
        }
        construction_errors.add(String(exception));
        continue;
      }
      if (one_llm_resources == null) {
        continue;
      }
      if (isinstance2(one_llm_resources, Set)) {
        Object.assign(required_sly_data, one_llm_resources);
        continue;
      }
      if (main_llm_resources == null) {
        main_llm_resources = one_llm_resources;
      } else {
        fallback_llm_resources.push(one_llm_resources);
      }
    }
    if (main_llm_resources == null) {
      return { "api_key_errors": sorted2(api_key_errors), "construction_errors": sorted2(construction_errors), "required_sly_data_errors": sorted2(required_sly_data) };
    }
    if (len(fallback_llm_resources) > 0) {
      if (randomize_peers) {
        let randomized = copy(fallback_llm_resources);
        randomized.push(main_llm_resources);
        shuffle(randomized);
        main_llm_resources = randomized.pop();
        fallback_llm_resources = randomized;
      }
      main_llm_resources.add_fallback_resources(fallback_llm_resources);
    }
    return main_llm_resources;
  }
}
exposeClassAttributes(DefaultLlmFactory);
class MasterLlmFactory {
  /**
   * Creates an appropriate ContextTypeLlmFactory
   *
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default llm_config
   * :return: A ContextTypeLlmFactory appropriate for the context_type in the config.
   */
  static create_llm_factory(config) {
    let llm_factory = null;
    let context_type = MasterLlmFactory.get_context_type(config);
    if (context_type.startsWith("openai")) {
      llm_factory = null;
    } else if (context_type.startsWith("langchain")) {
      llm_factory = new DefaultLlmFactory(config);
    } else {
      llm_factory = new DefaultLlmFactory(config);
    }
    return llm_factory;
  }
  /**
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default llm_config
   * :return: The context type for the config
   */
  static get_context_type(config) {
    let empty = {};
    let use_config = config;
    if (use_config == null) {
      use_config = empty;
    }
    let context_type = dict.get(use_config, "context_type");
    if (context_type == null) {
      context_type = "langchain";
    }
    let lower_context_type = context_type.toLowerCase();
    return lower_context_type;
  }
}
exposeClassAttributes(MasterLlmFactory);
class ToolboxInfoRestorer extends AbstractAsyncConfigRestorer {
  /**
   * Constructor
   */
  constructor() {
    super("toolbox_info");
  }
  /**
   * :param file_reference: The file reference to use when restoring.
   * Default is null, implying the file reference is up to the
   * implementation.
   * :return: a string representing the file path to use
   */
  get_file_path(file_reference) {
    let use_file = file_reference;
    if (file_reference == null || len(file_reference) == 0) {
      use_file = TOP_LEVEL_DIR.get_file_in_basis("internals/run_context/langchain/toolbox/toolbox_info.hocon");
    }
    return use_file;
  }
}
exposeClassAttributes(ToolboxInfoRestorer);
class ToolboxFactory extends ContextTypeToolboxFactory {
  static {
    this.REMOVED_TOOLS = frozenset(set(["requests_get", "requests_post", "requests_patch", "requests_put", "requests_delete", "requests_toolkit"]));
  }
  /**
   * Constructor
   *
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and toolbox_info_file
   */
  constructor(config) {
    super();
    this.toolbox_infos = {};
    this.overlayer = new DictionaryOverlay();
    this.loaded = false;
    this.load_lock = new Lock();
    let raw_toolbox_info_file = null;
    if (config) {
      raw_toolbox_info_file = dict.get(config, "toolbox_info_file") || getenv("AGENT_TOOLBOX_INFO_FILE");
    } else {
      raw_toolbox_info_file = getenv("AGENT_TOOLBOX_INFO_FILE");
    }
    if (raw_toolbox_info_file != null && !isinstance2(raw_toolbox_info_file, String)) {
      throw new Error(`The values of 'toolbox_info_file' and the 'AGENT_TOOLBOX_INFO_FILE' environment variable must be strings. Got ${type2(raw_toolbox_info_file)} instead.`);
    }
    this.toolbox_info_file = raw_toolbox_info_file;
  }
  /**
   * Loads the base tool information from hocon files.
   *
   * Only the first call does any work.  Subsequent calls on the same
   * instance are no-ops, so a shared factory can be load()-ed cheaply
   * on every use, even from multiple threads.
   */
  load() {
    if (this.loaded) {
      return;
    }
    const _resource = this.load_lock;
    try {
      if (this.loaded) {
        return;
      }
      let restorer = new ToolboxInfoRestorer();
      let toolbox_infos = restorer.restore();
      if (this.toolbox_info_file) {
        let extra_toolbox_infos = restorer.restore({ file_reference: this.toolbox_info_file });
        toolbox_infos = this.overlayer.overlay(toolbox_infos, extra_toolbox_infos);
      }
      this.toolbox_infos = toolbox_infos;
      this.loaded = true;
    } finally {
      _resource.close?.();
    }
  }
  /**
   * Resolves dependencies and instantiates the requested tool.
   *
   * :param tool_name: The name of the tool to instantiate.
   * :param user_args: Arguments provided by the user, which override the config file.
   * :param agent_name: The name of the agent to prefix each BaseTool's name in BaseToolkit with,
   * ensuring tool names are unique and traceable to their agent.
   * :return: - Instantiated tool if "class" of tool_name points to a BaseTool class
   * - A list of tools if "class of "tool_name points to a BaseToolkit class.
   * - A dict of tool's "description" and "parameters" if tool_name points to a CodedTool
   */
  create_tool_from_toolbox(tool_name, user_args, agent_name) {
    let empty = {};
    let tool_info = this._require_tool_info(tool_name);
    if (contains("description", tool_info)) {
      return tool_info;
    }
    let tool_class_name = dict.get(tool_info, "class");
    if (tool_class_name.startsWith("langchain_community.")) {
      warning("Tool '%s' uses a class from langchain-community, which has been sunset (https://github.com/langchain-ai/langchain-community/issues/674). Consider a tool from a maintained, dedicated integration package instead: https://docs.langchain.com/oss/python/integrations/tools", tool_name);
    }
    let tool_class = this._resolve_class(tool_class_name);
    let resolved_args = this._resolve_args(dict.get(tool_info, "args", empty));
    let final_args = user_args ? this.overlayer.overlay(resolved_args, user_args) : resolved_args;
    let callable_obj = this._get_from_api_wrapper_method(tool_class) || tool_class;
    ArgumentValidator.check_invalid_args(callable_obj, final_args);
    let instance = callable_obj(final_args);
    if (hasattr2(instance, "get_tools") && callable(instance.get_tools)) {
      let toolkit = instance.get_tools();
      for (const tool of iter2(toolkit)) {
        if (agent_name) {
          tool.name = `${agent_name}_${tool.name}`;
        }
        tool.tags = ["langchain_tool"];
      }
      return toolkit;
    }
    if (agent_name) {
      instance.name = agent_name;
    }
    instance.tags = ["langchain_tool"];
    return instance;
  }
  /**
   * Looks up a tool's entry in the loaded toolbox infos, raising when absent
   * or malformed so that every toolbox entry point reports problems the
   * same way.
   *
   * :param tool_name: The name of the tool to look up.
   * :return: The toolbox dictionary entry for the tool name, guaranteed
   * to be a dictionary with a "class" key.
   * Can raise a Error with migration guidance if the tool was
   * removed from the default toolbox, one naming the searched
   * sources if the tool is simply unknown, or one describing how
   * the entry is malformed.
   */
  _require_tool_info(tool_name) {
    let tool_info = dict.get(this.toolbox_infos, tool_name);
    if (tool_info == null) {
      if (contains(tool_name, this.REMOVED_TOOLS)) {
        throw ToolboxFactory._removed_tool_error(tool_name);
      }
      let sources = "the default toolbox info file";
      if (this.toolbox_info_file) {
        sources += ` or in ${this.toolbox_info_file}`;
      }
      throw new Error(`Tool '${tool_name}' is not defined in ${sources}.`);
    }
    if (!is_dict(tool_info)) {
      throw new Error(`The value for the ${tool_name} key must be a dictionary.`);
    }
    if (!contains("class", tool_info)) {
      if (contains(tool_name, this.REMOVED_TOOLS)) {
        throw ToolboxFactory._removed_tool_error(tool_name);
      }
      throw new Error(`Tool '${tool_name}' is missing required key: 'class'.
Each tool must include a 'class' key:
- For Langchain base tools: use the full class path (e.g., 'some_package.some_module.SomeTool')
- For shared CodedTools: use 'module.Class' format (e.g., 'some_module.SomeCodedTool')`);
    }
    let tool_class_name = dict.get(tool_info, "class");
    if (!isinstance2(tool_class_name, String) || !tool_class_name) {
      throw new Error(`Value for '${tool_name}.class' must be a non-empty string.`);
    }
    return tool_info;
  }
  /**
   * :param tool_name: The name of a tool in REMOVED_TOOLS.
   * :return: A Error explaining the removal and how to migrate.
   */
  static _removed_tool_error(tool_name) {
    return new Error(`Tool '${tool_name}' was removed from the default toolbox because it was built on the deprecated langchain-community package. To keep using it, define it in your own toolbox info file and register that file with the AGENT_TOOLBOX_INFO_FILE environment variable or the 'toolbox_info_file' key in the agent network hocon file. See https://github.com/cognizant-ai-lab/neuro-san/blob/main/docs/toolbox_info_hocon_reference.md`);
  }
  /**
   * Recursive resolves arguments when there is a wrapper class as an argument,
   * otherwise return args as a dictionary.
   *
   * :param args: The arguments to resolve.
   * :return: A dictionary of resolved arguments.
   */
  _resolve_args(args) {
    let empty = {};
    let resolved_args = {};
    for (const [key, value] of Object.entries(args)) {
      if (is_dict(value) && contains("class", value)) {
        let nested_class = this._resolve_class(dict.get(value, "class"));
        let nested_args = this._resolve_args(dict.get(value, "args", empty));
        ArgumentValidator.check_invalid_args(nested_class, nested_args);
        resolved_args[key] = nested_class(nested_args);
      } else {
        resolved_args[key] = value;
      }
    }
    return resolved_args;
  }
  /**
   * Uses Resolver to dynamically import a class.
   *
   * :param class_path: Full class path (e.g., "package.module.ClassName").
   * :return: The resolved class type.
   */
  _resolve_class(class_path) {
    let class_split = class_path.split(".");
    if (len(class_split) <= 2) {
      throw new Error(`Value in 'class' in ${this.toolbox_info_file} must be of the form '<package_name>.<module_name>.<ClassName>'`);
    }
    let packages = [slice2(class_split, void 0, -2).join(".")];
    let class_name = at2(class_split, -1);
    let resolver = new Resolver(packages);
    try {
      return resolver.resolve_class_in_module(class_name, { module_name: at2(class_split, -2) });
    } catch (exception) {
      throw new Error(`Class ${class_path} not found in PYTHONPATH`);
    }
  }
  /**
   * Get a 'from_{tool_name}_api_wrapper' class method from the tool class if available.
   *
   * :param tool_class: BaseTool or BaseToolkit class to check for the method.
   * :return: The method if found, null otherwise.
   */
  _get_from_api_wrapper_method(tool_class) {
    for (const attr_name of dir(tool_class)) {
      if (attr_name.startsWith("from") && attr_name.endsWith("api_wrapper")) {
        let attr = getattr2(tool_class, attr_name);
        if (callable(attr)) {
          return attr;
        }
      }
    }
    return null;
  }
  /**
   * Get class of the shared coded tool
   *
   * :param tool_name: The name of the tool
   * :return: The class of the coded tool.
   * Can raise a Error if the tool_name is unknown to the toolbox,
   * just like create_tool_from_toolbox().
   */
  get_shared_coded_tool_class(tool_name) {
    let tool_info = this._require_tool_info(tool_name);
    return dict.get(tool_info, "class");
  }
  /**
   * :param tool_name: The name of the tool.
   * :return: The toolbox dictionary entry for the tool name
   */
  get_tool_info(tool_name) {
    let tool_info = dict.get(this.toolbox_infos, tool_name);
    return tool_info;
  }
}
exposeClassAttributes(ToolboxFactory);
class MasterToolboxFactory {
  /**
   * Creates an appropriate ContextTypeToolboxFactory
   *
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default toolbox_config
   * :return: A ContextTypeToolboxFactory appropriate for the context_type in the config.
   */
  static create_toolbox_factory(config) {
    let toolbox_factory = null;
    let context_type = MasterLlmFactory.get_context_type(config);
    if (context_type.startsWith("openai")) {
      toolbox_factory = null;
    } else if (context_type.startsWith("langchain")) {
      toolbox_factory = new ToolboxFactory(config);
    } else {
      toolbox_factory = new ToolboxFactory(config);
    }
    return toolbox_factory;
  }
}
exposeClassAttributes(MasterToolboxFactory);
class AgentSpecProvider {
  /**
   * :return: the dictionary describing the data-driven agent
   */
  get_agent_tool_spec() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(AgentSpecProvider);
class RunContext extends AgentSpecProvider {
  /**
   * Creates resources to be used during a run of an agent.
   * The result is stored as a member in this instance for future use.
   * :param agent_name: String name for the agent.
   * :param instructions: string instructions that are used to create the agent
   * :param assignments: string assignments of function parameters that are used as input
   * :param tool_names: The list of registered tool names to use.
   * Default is null implying no tool is to be called.
   */
  async create_resources(agent_name, instructions, assignments, tool_names) {
    throw Error("Method not implemented");
  }
  /**
   * Submits a message to create a run.
   * :param user_message: The message to submit
   * :return: The Run instance which is processing the agent's message
   */
  async submit_message(user_message) {
    throw Error("Method not implemented");
  }
  /**
   * Loops on the given run's status for service-side processing
   * to be done.
   * :param run: The Run instance to wait on
   * :param journal: The Journal which captures the "thinking" messages.
   * :return: An potentially updated Run instance
   */
  async wait_on_run(run, journal) {
    throw Error("Method not implemented");
  }
  /**
   * :return: The list of messages from the instance's thread.
   */
  get_response() {
    throw Error("Method not implemented");
  }
  /**
   * :param run: The Run instance handling the execution of the agent
   * :param tool_outputs: The tool outputs to submit
   * The component dictionaries can have the following keys:
   * "origin"        A List of origin dictionaries indicating the origin of the run.
   * "output"        A string representing the output of the tool call
   * "sly_data"      Optional sly_data dictionary that might have returned from an external tool.
   * "tool_call_id"  The string id of the tool_call being executed
   * :return: A potentially updated run instance handle
   */
  async submit_tool_outputs(run, tool_outputs) {
    throw Error("Method not implemented");
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
  /**
   * :return: the dictionary describing the data-driven agent
   */
  get_agent_tool_spec() {
    throw Error("Method not implemented");
  }
  /**
   * :return: The InvocationContext policy container that pertains to the invocation
   * of the agent.
   */
  get_invocation_context() {
    throw Error("Method not implemented");
  }
  /**
   * :return: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   * Can be null when a new conversation has been started.
   */
  get_chat_context() {
    throw Error("Method not implemented");
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
    throw Error("Method not implemented");
  }
  /**
   * Update internal state based on the InvocationContext instance passed in.
   * :param invocation_context: The context policy container that pertains to the invocation
   */
  update_invocation_context(invocation_context) {
    throw Error("Method not implemented");
  }
  /**
   * :return: The Journal associated with the instance
   */
  get_journal() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(RunContext);
class Run {
  /**
   * :return: The string id of this run
   */
  get_id() {
    throw Error("Method not implemented");
  }
  /**
   * :return: True if the status of the run requires external action.
   * False otherwise
   */
  requires_action() {
    throw Error("Method not implemented");
  }
  /**
   * :return: A list of ToolCalls.
   */
  get_tool_calls() {
    throw Error("Method not implemented");
  }
  /**
   * :return: This object as a JSON string
   */
  model_dump_json() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(Run);
class ToolCall {
  /**
   * :return: The string id of this run
   */
  get_id() {
    throw Error("Method not implemented");
  }
  /**
   * :return: Returns a dictionary of the function arguments for the tool call
   */
  get_function_arguments() {
    throw Error("Method not implemented");
  }
  /**
   * :return: Returns the string name of the tool
   */
  get_function_name() {
    throw Error("Method not implemented");
  }
  /**
   * :return: String describing how the tool wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   */
  get_invocation() {
    throw Error("Method not implemented");
  }
}
exposeClassAttributes(ToolCall);
class LangChainToolCall extends ToolCall {
  /**
   * Constructor
   *
   * :param tool_name: The name of the tool to be called
   * :param args: The arguments the tool is requested to be called with
   * So far we've only seen this as Record<string, unknown>, but the langchain
   * typing is, unknown, so we stick with that.
   * :param run_id: The string id of the parent run so that the tool's
   * ids can be associated with that.
   * :param invocation: String describing how the tool wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   */
  constructor(tool_name, args, run_id, invocation) {
    super();
    this.tool_name = tool_name;
    this.args = args;
    this.id = `tool_call_${run_id}_${uuid4()}`;
    this.invocation = invocation;
    if (invocation == null) {
      this.invocation = "chatbot";
    }
  }
  /**
   * :return: The string id of this run
   */
  get_id() {
    return this.id;
  }
  /**
   * :return: Returns a dictionary of the function arguments for the tool call
   */
  get_function_arguments() {
    return this.args;
  }
  /**
   * :return: Returns the string name of the tool
   */
  get_function_name() {
    return this.tool_name;
  }
  /**
   * :return: String describing how the tool wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   */
  get_invocation() {
    return this.invocation;
  }
}
exposeClassAttributes(LangChainToolCall);
class LangChainRun extends Run {
  /**
   * Constructor
   *
   * :param run_id_base: The basis string for run ids.
   * :param chat_history: The chat history so far
   * :param tool_name: The name of the tool to call
   * :param args: The arguments used for the tool during the run
   * represented by this instance.
   * :param tool_message: The most recent tool message produced during the run
   * represented by this instance.
   * :param invocation: String describing how the tool wants to be invoked.
   * Can be: "chatbot" - implies waiting for an answer.
   * "event" - implies no answer needed
   * null - implies chatbot
   */
  constructor(...positional) {
    super();
    const names = ["run_id_base", "chat_history", "tool_name", "args", "tool_message", "invocation"];
    const last = positional[positional.length - 1];
    const bound = {};
    if (positional.length > 2 && last != null && Object.getPrototypeOf(last) === Object.prototype && Object.keys(last).length > 0 && Object.keys(last).every((key) => names.indexOf(key) >= positional.length - 1)) {
      Object.assign(bound, positional.pop());
    }
    names.forEach((name, i) => {
      if (!(name in bound)) bound[name] = positional[i];
    });
    const { run_id_base, chat_history, tool_name, args, tool_message, invocation } = bound;
    this.id = LangChainRun._create_run_id(run_id_base, chat_history);
    this.chat_history = chat_history;
    this.tool_name = tool_name;
    this.args = args;
    this.tool_message = tool_message;
    this.invocation = invocation;
  }
  /**
   * :return: A run id string based on the uuid in run_id_base and
   * the length of the chat history so far.
   */
  static _create_run_id(run_id_base, chat_history) {
    let chat_length = len(chat_history);
    let run_id = `run_${run_id_base}_${format2(chat_length, "04")}`;
    return run_id;
  }
  /**
   * :return: The string id of this run
   */
  get_id() {
    return this.id;
  }
  /**
   * :return: True if the status of the run requires external action.
   * False otherwise
   */
  requires_action() {
    return false;
  }
  /**
   * :return: A list of ToolCalls.
   */
  get_tool_calls() {
    let tool_calls = [];
    if (this.args != null) {
      let tool_call = new LangChainToolCall(this.tool_name, this.args, this.id, { invocation: this.invocation });
      tool_calls.push(tool_call);
    }
    return tool_calls;
  }
  /**
   * :return: This object as a JSON string
   */
  model_dump_json() {
    return `{ 'id': '${this.id}' }`;
  }
  /**
   * Get the most recent chat history.
   * :return: The list of messages comprising the chat history
   */
  get_chat_history() {
    return this.chat_history;
  }
  /**
   * This is used when the LangChainOpenAIFunctionTool wants to
   * know what the most recent message was from the tool as
   * its output.
   * :return: The tool message comprising the tool output
   */
  get_tool_message() {
    return this.tool_message;
  }
}
exposeClassAttributes(LangChainRun);
class ToolSpecError extends Error {
}
exposeClassAttributes(ToolSpecError);
class BaseModelDictionaryConverter extends DictionaryConverter {
  static {
    this.TYPE_LOOKUP = { "string": String, "int": Number, "float": Number, "boolean": Boolean, "array": Array, "integer": Number, "number": Number, "bool": Boolean, "object": Object };
  }
  /**
   * Constructor
   *
   * :param top_level_field_name: The field name for the top-level object
   */
  constructor(top_level_field_name) {
    super();
    this.top_level_field_name = top_level_field_name;
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
    if (obj_dict == null) {
      return null;
    }
    let base_model = this.openai_function_to_pydantic(this.top_level_field_name, obj_dict);
    return base_model;
  }
  /**
   * Turns an openai function spec dictionary into a pydantic BaseModel
   * See: https://docs.pydantic.dev/latest/concepts/models/#dynamic-model-creation
   *
   * :param name: The string name of the object/field undergoing conversion
   * :param function_dict: The dictionary describing the OpenAI function to
   * be converted into a pydantic BaseModel
   * :return: The pydantic BaseModel that corresponds to the OpenAI function spec.
   */
  openai_function_to_pydantic(name, function_dict) {
    let properties = dict.get(function_dict, "properties");
    if (properties == null) {
      properties = {};
    }
    if (!is_dict(properties)) {
      throw new ToolSpecError(`'properties' must be an object, got ${type2(properties)}`);
    }
    let required = dict.get(function_dict, "required");
    if (required == null) {
      required = [];
    }
    if (!isinstance2(required, Array)) {
      throw new ToolSpecError(`'required' must be a list of field names, got ${type2(required)}`);
    }
    if (any2((function* () {
      for (const entry of required)
        yield !isinstance2(entry, String);
    })())) {
      throw new ToolSpecError(`'required' must contain only field-name strings, got ${repr2(required)}`);
    }
    let fields = {};
    for (const [field_name, one_property] of Object.entries(properties)) {
      this.validate_field_name(field_name);
      if (!is_dict(one_property)) {
        throw new ToolSpecError(`Property '${field_name}' must be an object describing the field, got ${type2(one_property)}`);
      }
      let description = dict.get(one_property, "description");
      let field_type = this.get_type_from_property_dict(field_name, one_property);
      let field_kwargs = {};
      if (description != null) {
        field_kwargs["description"] = description;
      }
      if (!contains(field_name, required)) {
        field_kwargs["default"] = null;
        field_type = field_type | void 0;
      }
      let field = new Field(field_kwargs);
      fields[field_name] = tuple2(field_type, field);
    }
    let model = null;
    try {
      model = create_model(name, fields);
    } catch (exception) {
      throw new ToolSpecError(`Could not create pydantic model '${name}': ${exception}`);
    }
    return model;
  }
  /**
   * :param field_name: The string name of a single parameter/field.
   * Raises ToolSpecError for parameter names that pydantic v2's
   * create_model() cannot accept as field names.
   *
   * Pydantic v1 tolerated all of the names rejected here (it merely
   * warned about and dropped underscore-prefixed names), but pydantic v2
   * fails on them with cryptic NameError/TypeError at model-creation
   * time.  The invalid names are:
   *
   * * Names with a leading underscore (e.g. "_internal", "__config__"):
   * pydantic v2 reserves these for private attributes, and dunder
   * names collide with create_model()'s own keyword arguments.
   * * "model_config": silently consumed as create_model()'s model
   * configuration argument instead of becoming a field.
   * * Names that shadow a BaseModel method inside pydantic's protected
   * namespaces "model_dump" and "model_validate" (e.g. "model_dump",
   * "model_dump_json", "model_validate_json").  Other "model_"-prefixed
   * names (e.g. "model_name") are fine.
   *
   * Deliberately NOT rejected here: names that shadow BaseModel
   * attributes outside the protected namespaces, such as "schema",
   * "json", "dict" or "copy".  Pydantic v2 creates those fields and only
   * emits a shadowing UserWarning, so they work.  This is itself a
   * behavior change from the v1-based converter: v1's create_model
   * raised NameError for them, which made network validation reject
   * such specs - they now pass.
   */
  validate_field_name(field_name) {
    let message = null;
    if (field_name.startsWith("_")) {
      message = `Parameter name '${field_name}' must not start with an underscore.`;
    } else if (field_name == "model_config") {
      message = "Parameter name 'model_config' is reserved by pydantic for model configuration.";
    } else if (field_name.startsWith(tuple2("model_dump", "model_validate")) && hasattr2(BaseModel, field_name)) {
      message = `Parameter name '${field_name}' shadows a pydantic BaseModel method.`;
    }
    if (message != null) {
      throw new ToolSpecError(message);
    }
  }
  /**
   * :param field_name: The string name of the field undergoing conversion
   * :param one_property: The property dictionary of the field whose type we are looking for.
   * :return: the any of the property to be used with pydantic Fields
   * This type may be a BaseModel if object specification is
   * deep enough.
   */
  get_type_from_property_dict(field_name, one_property) {
    let type_from_dict = dict.get(one_property, "type");
    if (type_from_dict == null) {
      throw new ToolSpecError(`Field '${field_name}' has no 'type' key. Composite schemas (anyOf/oneOf/enum/$ref) are not supported.`);
    }
    if (!isinstance2(type_from_dict, String)) {
      throw new ToolSpecError(`Field '${field_name}' has a non-string 'type' (${repr2(type_from_dict)}). Union type lists are not supported; use a single type name.`);
    }
    let field_type = dict.get(this.TYPE_LOOKUP, type_from_dict);
    if (field_type == null) {
      throw new ToolSpecError(`Unrecognized type '${type_from_dict}' for field '${field_name}'`);
    }
    if (type_from_dict == "object") {
      let object_props = dict.get(one_property, "properties");
      if (object_props != null && object_props) {
        field_type = this.openai_function_to_pydantic(field_name, one_property);
      }
    } else if (type_from_dict == "array") {
      let items = dict.get(one_property, "items");
      if (!is_dict(items)) {
        let got = items == null ? "nothing" : type2(items);
        throw new ToolSpecError(`Array field '${field_name}' needs an 'items' object describing its element type, got ${got}`);
      }
      let item_type = this.get_type_from_property_dict(`${field_name}_component`, items);
      field_type = [];
    }
    return field_type;
  }
}
exposeClassAttributes(BaseModelDictionaryConverter);
class PydanticArgumentDictionaryConverter extends DictionaryConverter {
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
    let base_dict = dict(obj);
    let new_dict = {};
    for (const [key, value] of Object.entries(base_dict)) {
      new_dict[key] = this._convert_value(value);
    }
    return new_dict;
  }
  /**
   * Recursively convert a single value, descending into dicts, pydantic
   * BaseModel instances, and lists thereof.
   */
  _convert_value(value) {
    if (is_dict(value) || this.is_pydantic_object(value)) {
      return this.to_dict(value);
    }
    if (isinstance2(value, Array)) {
      let converted_list = [];
      for (const item of iter2(value)) {
        converted_list.push(this._convert_value(item));
      }
      return converted_list;
    }
    return value;
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
  /**
   * :param value: the value to test
   * :return: True if the object is a pydantic object. False otherwise.
   *
   * An isinstance() check is correct now that BaseModelDictionaryConverter
   * creates native pydantic v2 models.  The previous duck-typed check
   * (hasattr(value, "parse_obj")) dated from when the values here were
   * pydantic v1 models: it keyed off an API that is deprecated in
   * pydantic v2 and slated for removal in v3, and it returned a wrong
   * False whenever a model had a field literally named "parse_obj"
   * (buildable under v2), which let nested models through unflattened.
   */
  is_pydantic_object(value) {
    return isinstance2(value, BaseModel);
  }
}
exposeClassAttributes(PydanticArgumentDictionaryConverter);
class LangChainOpenAIFunctionTool extends StructuredTool {
  static {
    this.parameters = null;
  }
  static {
    this.args_schema = null;
  }
  static {
    this.function_json = null;
  }
  static {
    this.tool_caller = null;
  }
  static {
    this.invocation = null;
  }
  /**
   * :param function_json: The function json description of the tool.
   * Must have at least:
   * * A name
   * * A description
   * * A parameters dictionary with at least one entry in its properties dict
   */
  static verify_function_json(function_json) {
    let message = "";
    let name = dict.get(function_json, "name");
    if (name == null) {
      message = "function dictionary has no 'name' defined.";
      throw new ToolSpecError(message);
    }
    if (dict.get(function_json, "description") == null) {
      message = `Function for ${name} has no description.
`;
    }
    let parameters = dict.get(function_json, "parameters");
    if (parameters != null && !is_dict(parameters)) {
      message = `Function for ${name} needs its parameters to be a dictionary, got ${type2(parameters)}.
`;
    } else if (parameters) {
      if (dict.get(parameters, "type") == null) {
        message = `Function for ${name} needs to have a parameters.type set to 'object'.
`;
      }
      let properties = dict.get(parameters, "properties");
      if (properties == null) {
        message = `Function for ${name} needs to have a properties dictionary as part of its parameters.
`;
      } else if (!is_dict(properties) || len(Object.keys(properties)) == 0) {
        message = `Function for ${name} needs to have at least one argument dictionary in its properties.
`;
      }
    }
    if (len(message) > 0) {
      message += `
This most often happens when calling an /external agent for the first time
and the hocon file for the agent network does not have a full function definition
specified for its front man for it to be called by another agent.
`;
      throw new ToolSpecError(message);
    }
  }
  /**
   * Creates an instance of this tool from prepared OpenAI Function JSON.
   */
  static from_function_json(function_json, tool_caller) {
    LangChainOpenAIFunctionTool.verify_function_json(function_json);
    let tool = null;
    try {
      tool = new LangChainOpenAIFunctionTool(function_json);
    } catch (exception) {
      let message = `
Could not create tool to call extenal agent ${dict.get(function_json, "name")}.
It's function_json is described thusly:
${function_json}
`;
      throw new ToolSpecError(message);
    }
    let name = dict.get(function_json, "name");
    if (ExternalAgentParsing.is_external_agent(name)) {
      tool.name = ExternalAgentParsing.get_safe_agent_name(name);
    }
    let use_function_json = dict.get(function_json, "parameters", function_json);
    tool.function_json = use_function_json;
    let converter = new BaseModelDictionaryConverter("parameters");
    let schema_source = use_function_json != function_json ? use_function_json : {};
    if (schema_source == null) {
      schema_source = {};
    }
    tool.args_schema = converter.from_dict(schema_source);
    tool.tool_caller = tool_caller;
    return tool;
  }
  async _run(...args) {
    let kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    throw Error("Method not implemented");
  }
  /**
   * Comment from lanchain's BaseTool:
   * Use the tool.
   *
   * Add run_manager: AsyncCallbackManagerForToolRun | undefined = null
   * to child implementations to enable tracing,
   *
   *
   * This method actually does the work when the tool is called
   * via the AgentExecutor framework.
   * It uses the tool_caller member as a basis to call the
   * make_tool_function_calls() method. That guy
   * is going to go through all the impending calls to Tools
   * and do them all in a separate AgentExecutor context.
   * Since this method is a langchain "a" method, all of these
   * calls to another llm/agent instance happen asynchronously.
   * ("a" is for asynchronous).
   *
   * :return: The text of the BaseMessage that tells us the "answer"
   * from the tool. Block content is projected to text
   * (data blocks become a short reference) so the calling LLM's
   * tool result never carries reasoning or data blocks.
   * Can be null if the tool produced no message.
   * On failure, returns the string form of the exception so the
   * calling LLM can verbally recognize the problem.
   */
  async _arun(...args) {
    let kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    let run = null;
    try {
      let converter = new PydanticArgumentDictionaryConverter();
      kwargs = converter.to_dict(kwargs);
      let initial_run = new LangChainRun("tool_base", [""], this.name, kwargs, { invocation: this.invocation });
      run = await this.tool_caller.make_tool_function_calls(initial_run);
    } catch (exception) {
      let logger = getLogger(this.constructor.name);
      let sensitive_logger = new SensitiveLogger(logger);
      sensitive_logger.error("Tool._arun() got Exception: %s", String(exception));
      sensitive_logger.error(format_exc());
      run = null;
      return String(exception);
    }
    let the_answer = run.get_tool_message();
    if (the_answer == null) {
      return null;
    }
    return ContentUtils.history_safe_text(the_answer);
  }
}
exposeClassAttributes(LangChainOpenAIFunctionTool);
class McpServersInfoRestorer extends AbstractAsyncConfigRestorer {
  constructor() {
    super("MCP servers info", "MCP_SERVERS_INFO_FILE", false);
  }
  /**
   * :param basis_config: A dictionary with MCP servers information
   * :param file_path: The path to the MCP servers info file
   * :return: a dictionary with MCP servers information or null if there is no config (no file, or file not found)
   */
  filter_config(basis_config, file_path) {
    let use_basis_config = super.filter_config(basis_config, file_path);
    if (use_basis_config == null) {
      return null;
    }
    let result_dict = {};
    for (const [key, value] of Object.entries(use_basis_config)) {
      let use_key = key.trim();
      result_dict[use_key] = value;
    }
    return result_dict;
  }
}
exposeClassAttributes(McpServersInfoRestorer);
class McpToolErrorHandler {
  /**
   * Constructor
   *
   * Captures the tool's original coroutine, so instances must be created
   * *before* their async_invoke method is assigned as the tool's coroutine.
   * If the assignment happened first, this.original_coroutine would refer
   * back to async_invoke itself and recurse forever.
   *
   * :param tool: The MCP-backed LangChain tool whose coroutine is to be wrapped.
   * The tool itself is kept (not just its coroutine) because error
   * reporting needs its name and response_format at call time.
   */
  constructor(tool) {
    this.tool = tool;
    this.original_coroutine = tool.coroutine;
    this.sensitive_logger = new SensitiveLogger(getLogger(this.constructor.name));
  }
  /**
   * Invoke the original tool coroutine, converting any exception into
   * a concise "Error: ..." tool output.
   *
   * LangChain calls this with only the tool arguments produced by the LLM,
   * exactly as it would have called the original coroutine.
   *
   * :return: Whatever the original coroutine returns, or an error string
   * (paired with a null artifact when the tool's response_format
   * is "content_and_artifact") if the call raised.
   */
  async async_invoke(...args) {
    const kwargs = args.length > 0 && args[args.length - 1] != null && typeof args[args.length - 1] === "object" && !Array.isArray(args[args.length - 1]) && Object.keys(args[args.length - 1]).length === 0 ? args.pop() : {};
    try {
      return await this.original_coroutine(...args, kwargs);
    } catch (exception) {
      this.sensitive_logger.error("Error invoking MCP tool %s: %s", this.tool.name, String(exception));
      this.sensitive_logger.error("%s", format_exc());
      let error_output = `Error: ${ExceptionUtil.get_exception_details(exception).trimEnd()}`;
      if (this.tool.response_format == "content_and_artifact") {
        return error_output;
      }
      return error_output;
    }
  }
}
exposeClassAttributes(McpToolErrorHandler);
class LangChainMcpAdapter {
  static {
    this._mcp_info_lock = new Lock();
  }
  static {
    this._mcp_servers_info = null;
  }
  /**
   * Constructor
   */
  constructor() {
    this.client_allowed_tools = [];
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Loads MCP servers information from a configuration file if not already loaded.
   */
  _load_mcp_servers_info() {
    const _resource = LangChainMcpAdapter._mcp_info_lock;
    try {
      if (LangChainMcpAdapter._mcp_servers_info == null) {
        try {
          LangChainMcpAdapter._mcp_servers_info = new McpServersInfoRestorer().restore();
        } catch (value_error) {
          this.logger.warning("Error occurred while loading MCP servers info: %s", value_error);
          this.logger.info("Proceeding with empty MCP servers info.");
        }
        if (LangChainMcpAdapter._mcp_servers_info == null) {
          LangChainMcpAdapter._mcp_servers_info = {};
        }
      }
    } finally {
      _resource.close?.();
    }
  }
  /**
   * Fetches tools from the given MCP server and returns them as a list of LangChain-compatible tools.
   *
   * :param server_url: URL of the MCP server, e.g. https://mcp.deepwiki.com/mcp or http://localhost:8000/mcp/
   * :param allowed_tools: Optional list of tool names to filter from the server's available tools.
   * If null, all tools from the server will be returned.
   * :param headers: Optional dictionary of HTTP headers to include in the MCP requests.
   *
   * :return: A list of LangChain BaseTool instances retrieved from the MCP server.
   */
  async get_mcp_tools(server_url, allowed_tools, headers) {
    if (this._mcp_servers_info == null) {
      this._load_mcp_servers_info();
    }
    let mcp_tool_dict = { "url": server_url, "transport": "streamable_http" };
    let headers_dict = headers || dict.get(dict.get(this._mcp_servers_info, server_url, {}), "http_headers");
    if (headers_dict) {
      if (is_dict(headers_dict)) {
        mcp_tool_dict["headers"] = copy(headers_dict);
      } else {
        this.logger.error("MCP client headers for server %s must be a dictionary.", server_url);
      }
    }
    let client = new MultiServerMCPClient({ "server": mcp_tool_dict });
    let mcp_tools = await client.get_tools();
    let client_allowed_tools = allowed_tools;
    if (client_allowed_tools == null) {
      client_allowed_tools = dict.get(dict.get(this._mcp_servers_info, server_url, {}), "tools", []);
    }
    if (client_allowed_tools) {
      mcp_tools = mcp_tools.filter((tool) => contains(tool.name, client_allowed_tools)).map((tool) => tool);
    }
    this.client_allowed_tools = client_allowed_tools;
    for (const tool of iter2(mcp_tools)) {
      tool.tags = ["langchain_tool"];
      if (getattr2(tool, "coroutine", null) != null) {
        tool.coroutine = new McpToolErrorHandler(tool).async_invoke;
      }
    }
    return mcp_tools;
  }
}
exposeClassAttributes(LangChainMcpAdapter);
class ExternalToolAdapter {
  /**
   * Constructor
   *
   * :param agent_url: The URL describing where to find the desired agent.
   */
  constructor(session_factory, agent_url) {
    this.agent_url = agent_url;
    this.session_factory = session_factory;
    this.function_json = null;
  }
  /**
   * :param invocation_context: The context policy container that pertains to the invocation
   * :return: The function json for the agent, as specified by the external agent.
   */
  async get_function_json(invocation_context) {
    if (this.function_json == null) {
      let session = this.session_factory.create_session(this.agent_url, { invocation_context });
      let request_dict = {};
      try {
        let function_response = await session.function(request_dict);
        this.function_json = dict.get(function_response, "function");
      } catch (exception) {
        let message = `Problem accessing external agent ${this.agent_url}.

The server (which could be your own localhost) is currently not serving up
an agent network by that name. Try these hints:
1. Check to see that you do not have a typo in your reference to the external agent
   in the calling hocon file.
2. If you have control over the server, check to see that the agent network your are trying
   to reach has an entry in the manifest.hocon file whose value is set to true.
3. Consider restarting the server, as perhaps a server does not continually look
   for changes to hocon files or manifest files during normal operation.
4. If you are new to calling external agent networks, know that:
    a. Simply referencing an agent within your own hocon file with a / prefix
       does not mean the server is serving that agent up separately.
    b. Every agent that is externally referenceable needs its own hocon file
       which must also have an entry in the manifest.hocon file for the server.
    c. There is one and only one "front man" agent note in each network described
       by a hocon file that receives input on behalf of the network.
    d. In order to be called by external agents, that front man must have a
       "function" definition which includes a description. Declaring at least
       one parameter is recommended, as parameters are how calling agents know
       what to pass; when none are declared, a single "inquiry" string parameter
       is synthesized on the calling side so the caller's request still gets through.
`;
        throw new Error(message);
      }
    }
    return this.function_json;
  }
}
exposeClassAttributes(ExternalToolAdapter);
class BaseToolFactory {
  static {
    this.DEFAULT_EXTERNAL_PARAMETER_NAME = "inquiry";
  }
  static {
    this.DEFAULT_EXTERNAL_PARAMETERS = { "type": "object", "properties": { [this.DEFAULT_EXTERNAL_PARAMETER_NAME]: { "type": "string", "description": "The request to send to this agent network." } }, "required": [this.DEFAULT_EXTERNAL_PARAMETER_NAME] };
  }
  static {
    this.synthesis_warned = set();
  }
  /**
   * Constructor
   *
   * :param tool_caller: The ToolCaller creating tools
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param journal: The journal to use when sending framework-level messages to the client
   */
  constructor(tool_caller, invocation_context, journal) {
    this.tool_caller = tool_caller;
    this.invocation_context = invocation_context;
    this.journal = journal;
    this.logger = getLogger(this.constructor.name);
    this.sensitive_logger = new SensitiveLogger(this.logger);
  }
  /**
   * Create base tools for the agent to call.
   * :param name: The name of the tool to create
   * :return: The BaseTools associated with the name
   */
  async create_base_tool(name) {
    let inspector = this.tool_caller.get_inspector();
    let agent_spec = inspector.get_agent_tool_spec(name);
    if (agent_spec == null) {
      return await this.create_external_tool(name);
    }
    return await this.create_internal_tool(name, agent_spec);
  }
  /**
   * Create external agent/tool.
   * :param name: The name of the external agent/tool
   * :return: External agent as base tools
   */
  async create_external_tool(name) {
    if (!isinstance2(name, [String, Object])) {
      throw new Error(`Tools must be string or dict, got ${type2(name)}`);
    }
    if (ExternalAgentParsing.is_mcp_tool(name)) {
      return await this.create_mcp_tool(name);
    }
    if (!ExternalAgentParsing.is_external_agent(name)) {
      return null;
    }
    let session_factory = this.invocation_context.get_async_session_factory();
    let adapter = new ExternalToolAdapter(session_factory, name);
    let function_json = null;
    try {
      function_json = await adapter.get_function_json(this.invocation_context);
    } catch (exception) {
      let message = `Agent/tool ${name} was unreachable. Not including it as a tool.
`;
      message += String(exception);
      await this.report_tool_exclusion(message);
      return null;
    }
    try {
      let use_function_json = await this.ensure_external_parameters(function_json, name);
      return this.create_function_tool(use_function_json, name);
    } catch (exception) {
      let message = `Agent/tool ${name} reported an invalid function definition. Not including it as a tool.
`;
      message += String(exception);
      await this.report_tool_exclusion(message);
      return null;
    }
  }
  /**
   * Report to both the client journal and the server logs that a tool
   * is being left out of the calling agent's tool list.
   *
   * :param message: The message describing which tool and why
   */
  async report_tool_exclusion(message) {
    let agent_message = new AgentMessage(message, {}, null);
    await this.journal.write_message(agent_message, null);
    this.sensitive_logger.info(message);
  }
  /**
   * Guarantee that an external agent's function spec declares parameters.
   *
   * The tool-call arguments are the only message channel through which a
   * calling agent passes its request to an external agent network
   * (sly_data is a separate, opt-in channel for private data).
   * An external front-man that declares no function.parameters would
   * therefore be presented to the calling LLM as a zero-argument tool,
   * which the LLM would invoke with an empty {} - and the external network
   * would silently never receive the caller's request (issue #1228).
   *
   * Note this is external-tools-only on purpose: internal tools without
   * parameters (e.g. no-argument coded tools) legitimately take no
   * arguments and are left alone.
   *
   * :param function_json: The function spec reported by the external agent.
   * Can be null when the agent was unreachable.
   * :param name: The name of the external agent, for reporting.
   * :return: The function_json as-is when it already declares parameters,
   * otherwise a copy with DEFAULT_EXTERNAL_PARAMETERS substituted in.
   */
  async ensure_external_parameters(function_json, name) {
    if (function_json == null) {
      return null;
    }
    if (dict.get(function_json, "description") == null) {
      return function_json;
    }
    let raw_parameters = dict.get(function_json, "parameters");
    if (raw_parameters != null && !is_dict(raw_parameters)) {
      return function_json;
    }
    let parameters = raw_parameters || {};
    let properties = dict.get(parameters, "properties") || {};
    if (properties) {
      BaseToolFactory.synthesis_warned.discard(name);
      return function_json;
    }
    if (parameters && !set.isSuperset(set(["type", "properties", "required"]), Object.keys(parameters))) {
      return function_json;
    }
    if (!contains(name, BaseToolFactory.synthesis_warned)) {
      BaseToolFactory.synthesis_warned.add(name);
      let message = `The front-man of external agent ${name} declares no parameters in its function definition, so a single required '${this.DEFAULT_EXTERNAL_PARAMETER_NAME}' string parameter is being synthesized for it to receive the calling agent's request. To control what this agent network receives, declare at least one parameter in the function definition of its front-man.`;
      let agent_message = new AgentMessage(message, {}, null);
      await this.journal.write_message(agent_message, null);
      this.logger.warning(message);
    }
    let use_function_json = dict(function_json);
    use_function_json["parameters"] = deepcopy(this.DEFAULT_EXTERNAL_PARAMETERS);
    return use_function_json;
  }
  /**
   * Create internal agent/tool.
   * :param name: The name of the agent or coded tool
   * :return: Agent as base tools
   */
  async create_internal_tool(name, agent_spec) {
    let toolbox = dict.get(agent_spec, "toolbox");
    if (toolbox) {
      return await this.create_toolbox_tool(toolbox, agent_spec, name);
    }
    let function_json = dict.get(agent_spec, "function");
    if (function_json == null) {
      return null;
    }
    return this.create_function_tool(function_json, name);
  }
  /**
   * Create MCP tools from the provided MCP configuration.
   *
   * The configuration can be one of:
   * - **String**: A canonical MCP server URI (see
   * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#canonical-server-uri).
   * Must use http(s), no fragment, with "mcp" appearing either as a host label
   * (e.g. "mcp.example.com") or as a path segment (e.g. "/mcp", "/mcp/free", "/server/mcp").
   * - **Dictionary**:
   * - "url" (str): MCP server URL.
   * - "tools" (List<string>, optional): List of tool names to allow from the server.
   *
   * :param mcp_info: MCP server URL (string) or a configuration dictionary
   * :return: A list of MCP tools as base tools
   */
  async create_mcp_tool(mcp_info) {
    let allowed_tools = null;
    let http_headers = dict.get(this.tool_caller.get_sly_data(), "http_headers", {});
    let server_url = null;
    if (isinstance2(mcp_info, String)) {
      server_url = mcp_info;
    } else {
      server_url = dict.get(mcp_info, "url");
      allowed_tools = dict.get(mcp_info, "tools");
    }
    let headers = dict.get(http_headers, server_url);
    let mcp_adapter = null;
    let mcp_tools = null;
    try {
      mcp_adapter = new LangChainMcpAdapter();
      mcp_tools = await mcp_adapter.get_mcp_tools(server_url, allowed_tools, headers);
    } catch (nested_exception) {
      let message = `The URL ${server_url} was unreachable. Not including it as a tool.
`;
      message += ExceptionUtil.get_exception_details(nested_exception);
      let agent_message = new AgentMessage(message, {}, null);
      await this.journal.write_message(agent_message, null);
      this.sensitive_logger.info(message);
      return null;
    }
    let use_allowed_tools = mcp_adapter.client_allowed_tools;
    let tool_names = mcp_tools.map((tool) => tool.name);
    let invalid_names = set(use_allowed_tools) - set(tool_names);
    if (invalid_names) {
      let message = `The following tools cannot be found in ${server_url}: ${invalid_names}`;
      let agent_message = new AgentMessage(message, {}, null);
      await this.journal.write_message(agent_message, null);
      this.logger.info(message);
    }
    return mcp_tools;
  }
  /**
   * Create tool from toolbox
   */
  async create_toolbox_tool(toolbox, agent_spec, name) {
    let toolbox_factory = this.invocation_context.get_toolbox_factory();
    try {
      let tool_from_toolbox = toolbox_factory.create_tool_from_toolbox(toolbox, dict.get(agent_spec, "args"), name);
      if (isinstance2(tool_from_toolbox, StructuredTool) || isinstance2(tool_from_toolbox, Array) && all2((function* () {
        for (const tool of tool_from_toolbox)
          yield isinstance2(tool, StructuredTool);
      })())) {
        return tool_from_toolbox;
      }
      return this.create_function_tool(tool_from_toolbox, name);
    } catch (tool_spec_exception) {
      if (tool_spec_exception instanceof Error) {
        let message = `Agent/tool '${name}' has an invalid function spec: ${tool_spec_exception}`;
        let agent_message = new AgentMessage(message, {}, null);
        await this.journal.write_message(agent_message, null);
        this.sensitive_logger.warning(message);
        return null;
      } else if (tool_spec_exception instanceof Error) {
        const tool_creation_exception = tool_spec_exception;
        let message = `Failed to create Agent/tool '${name}': ${tool_creation_exception}`;
        let agent_message = new AgentMessage(message, {}, null);
        await this.journal.write_message(agent_message, null);
        this.sensitive_logger.warning(message);
        return null;
      }
    }
  }
  /**
   * Create a function tool from JSON specification
   */
  create_function_tool(function_json, name) {
    if (function_json == null) {
      let message = `Could not create tool to call external agent '${name}'. Its function_json is null.`;
      throw new Error(message);
    }
    let use_function_json = dict(function_json);
    use_function_json["name"] = name;
    return LangChainOpenAIFunctionTool.from_function_json(use_function_json, this.tool_caller);
  }
}
exposeClassAttributes(BaseToolFactory);
let journaling_callback_var = new ContextVar("journaling_callback", { default: null });
class JournalingCallbackHandler extends BaseCallbackHandler {
  static {
    this.model_config = new ConfigDict({ arbitrary_types_allowed: true });
  }
  /**
   * Constructor
   *
   * :param calling_agent_journal: The journal of the calling agent
   * :param base_journal: The Journal instance that allows message reporting during the course of the AgentSession.
   * This is used to construct the langchain_tool_journal.
   * :param parent_origin: A List of origin dictionaries indicating the origin of the run
   * This is used to construct the langchain_tool_journal.
   * :param origination: The Origination instance carrying state about tool instantation
   * during the course of the AgentSession. This is used to construct the langchain_tool_journal.
   */
  constructor(calling_agent_journal, base_journal, parent_origin, origination) {
    super();
    this.calling_agent_journal = calling_agent_journal;
    this.base_journal = base_journal;
    this.parent_origin = parent_origin;
    this.origination = origination;
    this._tool_journals = {};
    this._tool_origins = {};
  }
  /**
   * Mark this handler as the nearest active agent's journaling scope.
   *
   * :return: A context manager that restores the previous scope on exit.
   */
  *scope() {
    let token = journaling_callback_var.set(this);
    try {
      yield;
    } finally {
      journaling_callback_var.reset(token);
    }
  }
  /**
   * Determine whether the callback belongs to this handler's agent scope.
   *
   * LangChain propagates callback handlers to descendant agent runs. At event
   * time, the context variable holds the handler for the nearest agent scope,
   * allowing an ancestor handler to ignore a descendant agent's events. If no
   * scope is set, preserve the historical behavior for direct callback use.
   *
   * :return: True for this handler's events or when no agent scope is active.
   */
  _is_own_call() {
    let current_handler = dict.get(journaling_callback_var);
    return current_handler == null || current_handler === this;
  }
  async on_llm_end(response, kwargs = {}) {
    if (!this._is_own_call()) {
      return;
    }
    let generations = response.generations[0];
    let first_generation = generations[0];
    if (isinstance2(first_generation, ChatGeneration)) {
      let content = ContentUtils.flatten_to_text(first_generation.message);
      if (len(content) > 0) {
        let message = new AgentMessage(content.trim(), {}, null);
        await this.calling_agent_journal.write_message_if_next_not_dupe(message);
      }
    }
  }
  on_chain_end(outputs, kwargs = {}) {
    return;
  }
  /**
   * Callback triggered when a tool starts execution.
   *
   * If the tool is identified as a LangChain tool (via the "langchain_tool" tag),
   * this method creates a journal entry containing the tool's input arguments,
   * origin metadata, and full tool name.
   *
   * :param serialized: Serialized representation of the tool, including its name and description.
   * :param input_str: String representation of the tool's input.
   * :param run_id: Unique identifier for the tool execution instance.
   * :param tags: List of tags associated with the tool. Used to determine whether it is a LangChain tool.
   * :param inputs: Structured dictionary of input arguments
   * passed to the tool.
   */
  async on_tool_start(serialized, input_str, run_id, tags, inputs, kwargs = {}) {
    if (!this._is_own_call()) {
      return;
    }
    let agent_name = dict.get(serialized, "name");
    let tool_start_dict = ToolArgumentReporting.prepare_tool_start_dict(inputs);
    let caller_structure = { "invoking_start": true, "invoked_agent_name": agent_name, "params": dict.get(tool_start_dict, "tool_args") };
    let display_name = agent_name ? agent_name : "<unnamed tool>";
    let message = new AgentMessage({ content: `Invoking: \`${display_name}\` with:`, structure: caller_structure });
    await this.calling_agent_journal.write_message(message, null);
    if (contains("langchain_tool", tags)) {
      let origin = this.origination.add_spec_name_to_origin(this.parent_origin, agent_name);
      this._tool_origins[run_id] = origin;
      tool_start_dict = ToolArgumentReporting.prepare_tool_start_dict(inputs, origin);
      let langchain_tool_journal = new OriginatingJournal(this.base_journal, origin);
      this._tool_journals[run_id] = langchain_tool_journal;
      message = new AgentMessage("Received arguments:", tool_start_dict, null);
      await langchain_tool_journal.write_message(message, null);
    }
  }
  /**
   * Callback triggered when a tool finishes execution.
   *
   * If the tool is identified as a LangChain tool (via the "langchain_tool" tag),
   * this method logs the tool's output to both the calling agent's journal and the
   * LangChain tool's specific journal.
   *
   * :param output: The result produced by the tool after execution.
   * :param run_id: Unique identifier for the tool execution instance.
   * :param tags: List of tags associated with the tool. Used to determine whether it is a LangChain tool.
   */
  async on_tool_end(output, run_id, tags, kwargs = {}) {
    if (!this._is_own_call()) {
      return;
    }
    if (contains("langchain_tool", tags)) {
      if (isinstance2(output, ToolMessage)) {
        output = output.content;
      }
      let origin = dict.get(this._tool_origins, run_id);
      let langchain_tool_journal = dict.get(this._tool_journals, run_id);
      let result_content = "";
      if (ContentUtils.looks_like_blocks(output)) {
        result_content = ContentUtils.to_json_safe(output);
      } else {
        result_content = String(output);
      }
      await this.calling_agent_journal.write_message(new AgentToolResultMessage({ content: result_content, tool_result_origin: origin }));
      let tool_output = output;
      if (isinstance2(result_content, Array)) {
        tool_output = result_content;
      }
      let output_dict = { "tool_end": true, "tool_output": tool_output };
      let message = new AgentMessage("Got result:", output_dict, null);
      await langchain_tool_journal.write_message(message, null);
    }
  }
  on_agent_action(action, kwargs = {}) {
    return;
  }
  on_agent_finish(finish, kwargs = {}) {
    return;
  }
  on_retriever_end(documents, kwargs = {}) {
    return;
  }
}
exposeClassAttributes(JournalingCallbackHandler);
let llm_token_callback_var = new ContextVar("llm_token_callback", { default: null });
registerConfigureHook(llm_token_callback_var, { inheritable: true });
let EMPTY = "";
let CLASS_TABLE = { "AzureChatOpenAI": "azure-openai", "ChatAnthropic": "anthropic", "ChatBedrock": "bedrock", "ChatGoogleGenerativeAI": "gemini", "ChatNVIDIA": "nvidia", "ChatOllama": "ollama", "ChatOpenAI": "openai" };
class LlmTokenCallbackHandler extends BaseCallbackHandler {
  static {
    this.total_tokens = 0;
  }
  static {
    this.prompt_tokens = 0;
  }
  static {
    this.completion_tokens = 0;
  }
  static {
    this.successful_requests = 0;
  }
  static {
    this.empty_responses = 0;
  }
  static {
    this.total_cost = 0;
  }
  /**
   * Initialize the CallbackHandler.
   */
  constructor(llm_infos) {
    super();
    this._lock = new Lock$1();
    this.llm_infos = llm_infos;
    this.provider_class = null;
    this.start_time = null;
    this.models_token_dict = {};
  }
  toString() {
    return `Tokens Used: ${this.total_tokens}
	Prompt Tokens: ${this.prompt_tokens}
	Completion Tokens: ${this.completion_tokens}
Successful Requests: ${this.successful_requests}
Empty Responses: ${this.empty_responses}
Total Cost (USD): $${this.total_cost}
Model Info: ${this.models_token_dict}`;
  }
  /**
   * :return: True if the event being handled belongs to an LLM call made by this
   * handler's own agent.  False for calls made by downstream agents, whose
   * events this handler also receives because handlers are inheritable
   * callbacks.  At event time, llm_token_callback_var holds the handler
   * of the nearest enclosing agent scope - the call's owner - so for any
   * given LLM call this is True for exactly one of the handlers listening
   * to it.  That exactly-once ownership is what keeps the request-wide
   * merge in LangChainTokenCounter.report() free of double-counting.
   */
  _is_own_call() {
    return dict.get(llm_token_callback_var) === this;
  }
  /**
   * Extract the LLM class and start timer when chat model starts.
   * :param serialized: Dictionary of metadata of the invoked model
   */
  on_chat_model_start(serialized, messages, kwargs = {}) {
    if (!this._is_own_call()) {
      return;
    }
    let chat_model_class = at2(dict.get(serialized, "id"), -1);
    this.provider_class = dict.get(CLASS_TABLE, chat_model_class);
    if (!this.provider_class) {
      this.provider_class = chat_model_class;
    }
    if (!contains(this.provider_class, this.models_token_dict)) {
      this.models_token_dict[this.provider_class] = {};
    }
    this.start_time = time();
  }
  /**
   * Pull usage information out of an LLMResult.
   * :param response: Output from chat model
   * :return: A tuple of (usage_metadata, model_name, is_empty_response).
   * usage_metadata is null when the response carries none.
   */
  static _extract_usage(response) {
    let generation = null;
    try {
      generation = response.generations[0][0];
    } catch (e) {
      generation = null;
    }
    let usage_metadata = null;
    let response_metadata = null;
    let model_name = EMPTY;
    let is_empty_response = false;
    if (isinstance2(generation, ChatGeneration)) {
      try {
        let message = generation.message;
        if (isinstance2(message, AIMessage)) {
          usage_metadata = message.usage_metadata;
          is_empty_response = LlmTokenCallbackHandler._is_empty_response(message);
          response_metadata = message.response_metadata;
          if (response_metadata) {
            if (contains("model_name", response_metadata)) {
              model_name = dict.get(response_metadata, "model_name");
            } else if (contains("model_id", response_metadata)) {
              model_name = dict.get(response_metadata, "model_id");
            } else if (contains("model", response_metadata)) {
              model_name = dict.get(response_metadata, "model");
            }
          }
        }
      } catch {
      }
    }
    return usage_metadata;
  }
  /**
   * Collect token usage when llm ends.
   * :param response: Output from chat model
   */
  async on_llm_end(response, kwargs = {}) {
    let is_own_call = this._is_own_call();
    let time_taken_in_seconds = 0;
    if (is_own_call && this.start_time != null) {
      time_taken_in_seconds = time() - this.start_time;
    }
    let usage_metadata, model_name, is_empty_response = LlmTokenCallbackHandler._extract_usage(response);
    if (usage_metadata) ;
  }
  /**
   * Calculate token costs from prices in the LLM info file.
   * :param model_name: Model to calculate the cost
   * :param completion_tokens: Number of output tokens
   * :param prompt_tokens: Number of input tokens
   * :return: Total cost
   */
  calculate_token_costs(model_name, completion_tokens, prompt_tokens) {
    let completion_token_cost = this._get_cost_from_info(model_name, completion_tokens, "price_per_1k_output_tokens");
    let prompt_token_cost = this._get_cost_from_info(model_name, prompt_tokens, "price_per_1k_input_tokens");
    if (completion_token_cost == null && prompt_token_cost == null) {
      let logger = getLogger("__name__");
      logger.warning("No price info found for model %s in llm info. Token cost defaults to 0.", model_name);
    }
    return (completion_token_cost || 0) + (prompt_token_cost || 0);
  }
  /**
   * Get cost from llm_infos if available.
   * :param model_name: Model to calculate the cost
   * :param num_tokens: Amount of tokens
   * :param price_key: keyword to look in llm info for price
   * :return: Token cost
   */
  _get_cost_from_info(model_name, num_tokens, price_key) {
    let llm_info = dict.get(this.llm_infos, model_name);
    if (llm_info == null) {
      return null;
    }
    let price = dict.get(llm_info, price_key);
    if (price == null) {
      let use_model_name = dict.get(llm_info, "use_model_name");
      if (use_model_name != null) {
        price = dict.get(dict.get(this.llm_infos, use_model_name, {}), price_key);
      }
    }
    return price != null ? num_tokens / 1e3 * price : null;
  }
  /**
   * Initialize a new model entry in the tracking dictionary.
   * :param model_name: LLM model name to put in the dictionary
   */
  _init_model_entry(model_name) {
    this.models_token_dict[this.provider_class][model_name] = { "total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "successful_requests": 0, "empty_responses": 0, "total_cost": 0, "time_taken_in_seconds": 0 };
  }
  /**
   * Determine whether a single list-content item carries no visible text.
   * :param item: One element of an AIMessage's list content
   * :return: True for a whitespace-only string or an empty/whitespace text
   * block ({"type": "text"}); any other block type counts as content
   */
  static _is_blank_content_block(item) {
    if (isinstance2(item, String)) {
      return item.trim() == EMPTY;
    }
    if (is_dict(item) && dict.get(item, "type") == "text") {
      return String(dict.get(item, "text", EMPTY)).trim() == EMPTY;
    }
    return false;
  }
  /**
   * Determine whether an AIMessage carried no actionable output, i.e. neither
   * text content nor a tool call. Such a response still counts as a successful
   * request, so it is tracked separately as "empty_responses".
   * :param message: The AIMessage returned by the chat model
   * :return: True if the message has no content and no tool calls
   */
  static _is_empty_response(message) {
    let content = message.content;
    let has_content = false;
    if (isinstance2(content, String)) {
      has_content = content.trim() != EMPTY;
    } else if (isinstance2(content, Array)) {
      has_content = !all2((function* () {
        for (const item of content)
          yield LlmTokenCallbackHandler._is_blank_content_block(item);
      })());
    } else {
      has_content = Boolean(content);
    }
    return !has_content && !getattr2(message, "tool_calls", null);
  }
}
exposeClassAttributes(LlmTokenCallbackHandler);
const get_llm_token_callback = contextmanager(function* (llm_infos) {
  const cb = new LlmTokenCallbackHandler(llm_infos);
  const token = llm_token_callback_var.set(cb);
  try {
    yield cb;
  } finally {
    llm_token_callback_var.reset(token);
  }
});
let ORIGIN_INFO = new ContextVar("origin_info", { default: null });
let ZERO_TOKEN_STATS = { "total_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0, "successful_requests": 0, "empty_responses": 0, "total_cost": 0 };
let COMMON_CAVEATS = ["Token counts are approximate and estimated using tiktoken.", "time_taken_in_seconds includes overhead from Langchain and Neuro SAN"];
let MAIN_NETWORK_CAVEAT = "Token usage from agents of the main agent network only. Usage from external agents is not included.";
let TOTAL_CAVEAT = "Request total: includes token usage from external agents invoked via direct sessions on this server. Usage from external agents reached over the network is not included.";
class LangChainTokenCounter {
  /**
   * Constructor
   *
   * :param llm: The Llm to monitor for tokens
   * :param invocation_context: The InvocationContext
   * :param journal: The OriginatingJournal which through which this
   * will send token count AGENT messages
   * :param origin: The origin that will be applied to all messages.
   */
  constructor(llm, invocation_context, journal, origin) {
    this.llm = llm;
    this.invocation_context = invocation_context;
    this.journal = journal;
    this.origin = origin;
    this.debug = false;
  }
  /**
   * Counts the tokens (if possible) from what happens inside the awaitable
   * within a separate context.  If tokens are counted, they are added to
   * the InvocationContext's request_reporting and sent over the message queue
   * via the journal
   *
   * Recall awaitables are a full async method call with args.  That is, where you would expect to
   * baz = await myinstance.foo(bar)
   * you instead do
   * baz = await token_counter.count_tokens(myinstance.foo(bar)).
   *
   * :param awaitable: The awaitable whose tokens we wish to count.
   * :param max_execution_seconds: The maximum amount of time to execute the awaitable.
   * If null, the awaitable is executed to completion.
   * :return: Whatever the awaitable would return
   */
  async count_tokens(awaitable, max_execution_seconds) {
    let retval = null;
    let llm_factory = this.invocation_context.get_llm_factory();
    let llm_infos = llm_factory.llm_infos;
    let start_time = time();
    let origin_str = Origination.get_full_name_from_origin(this.origin);
    ORIGIN_INFO.set(origin_str);
    let timed_out = false;
    const callback = get_llm_token_callback(llm_infos);
    try {
      let new_context = copy_context();
      let task = new_context.run(this.create_task.bind(this), awaitable);
      try {
        retval = await wait_for(task, max_execution_seconds);
      } catch (e) {
        let timeout_output = `Agent timed out: max_execution_seconds=${max_execution_seconds}s exceeded.`;
        if (this.journal != null) {
          await this.journal.write_message(new AIMessage({ content: timeout_output == null ? "" : timeout_output }));
        }
        retval = null;
        timed_out = true;
      }
    } finally {
      callback.close?.();
    }
    let end_time = time();
    let time_taken_in_seconds = end_time - start_time;
    await this.report(callback, time_taken_in_seconds);
    if (timed_out) {
      throw new TimeoutError(`Agent '${origin_str}' exceeded max_execution_seconds=${max_execution_seconds}s`);
    }
    return retval;
  }
  /**
   * Riffed from:
   * https://stackoverflow.com/questions/78659844/async-version-of-context-run-for-context-vars-in-python-asyncio
   */
  create_task(awaitable) {
    let executor = this.invocation_context.get_asyncio_executor();
    let origin_str = dict.get(ORIGIN_INFO);
    let task = executor.create_task(awaitable, origin_str);
    if (this.debug) {
      let oai_call = dict.get(llm_token_callback_var);
      console.log(`origin is ${origin_str} callback var is ${Number(oai_call)}`);
    }
    return task;
  }
  /**
   * Report on the token accounting results of the callback
   *
   * :param callback: An AsyncCallbackHandler or BaseCallbackHandle instance that contains token counting information
   * :param time_taken_in_seconds: The amount of time the awaitable took in count_tokens()
   */
  async report(callback, time_taken_in_seconds) {
    let request_reporting = this.invocation_context.get_request_reporting();
    let total_accounting = dict.get(request_reporting, "total_token_accounting", {});
    let models_token_dict = this.merge_dicts(dict.get(total_accounting, "models", {}), callback.models_token_dict);
    let total_time = time_taken_in_seconds;
    if (this.invocation_context.is_cloned()) {
      total_time = dict.get(total_accounting, "time_taken_in_seconds", time_taken_in_seconds);
    }
    let network_token_dict = this.sum_all_tokens(models_token_dict, total_time);
    network_token_dict["caveats"] = [TOTAL_CAVEAT, ...COMMON_CAVEATS];
    let main_accounting = dict.get(request_reporting, "token_accounting", {});
    if (!this.invocation_context.is_cloned()) {
      let contribution = this.sum_all_tokens(callback.models_token_dict, time_taken_in_seconds);
      main_accounting = this.merge_dicts(main_accounting, contribution);
      main_accounting["time_taken_in_seconds"] = time_taken_in_seconds;
      main_accounting["caveats"] = [MAIN_NETWORK_CAVEAT, ...COMMON_CAVEATS];
    } else if (!main_accounting) {
      main_accounting = this.sum_all_tokens({}, 0);
      main_accounting["caveats"] = [MAIN_NETWORK_CAVEAT, ...COMMON_CAVEATS];
    }
    request_reporting["token_accounting"] = main_accounting;
    request_reporting["total_token_accounting"] = new Map([...network_token_dict, ["models", models_token_dict]]);
    let is_main_front_man = this.origin != null && len(this.origin) == 1 && !this.invocation_context.is_cloned();
    if (is_main_front_man) {
      let total_token_dict = request_reporting["total_token_accounting"];
      let unattributed_tokens = callback.total_tokens - total_token_dict["total_tokens"];
      if (unattributed_tokens > 0) {
        total_token_dict["caveats"] = total_token_dict["caveats"] + [`An additional ${unattributed_tokens} tokens were used by agents that did not complete and are not included.`];
      }
    }
    if (this.journal != null) {
      if (is_main_front_man) {
        await this.journal.write_message(new AgentMessage("", request_reporting["token_accounting"], null));
        await this.journal.write_message(new AgentMessage("", request_reporting["total_token_accounting"], null));
      } else {
        let agent_token_dict = this._generate_agent_token_dict(callback, time_taken_in_seconds);
        await this.journal.write_message(new AgentMessage("", agent_token_dict, null));
      }
    }
  }
  /**
   * Generate the token counting dictionary for journals
   *
   * :param callback: An AsyncCallbackHandler or BaseCallbackHandler instance that contains
   * token counting information
   * :param time_taken_in_seconds: The amount of time the awaitable took in count_tokens()
   * :param agent_name: Name of the agent responsible for the token dictionary
   * :return: Formatted token dictionary
   */
  _generate_agent_token_dict(callback, time_taken_in_seconds) {
    let agent_token_dict = { "total_tokens": callback.total_tokens, "prompt_tokens": callback.prompt_tokens, "completion_tokens": callback.completion_tokens, "successful_requests": callback.successful_requests, "empty_responses": getattr2(callback, "empty_responses", 0), "total_cost": callback.total_cost, "time_taken_in_seconds": time_taken_in_seconds, "caveats": ["Token usage is tracked at the agent level. Counts include usage from any downstream agents called on this agent's behalf.", ...COMMON_CAVEATS] };
    return agent_token_dict;
  }
  /**
   * Sum all token metrics across providers and models, **excluding time**.
   * :param token_dict: Models token dict to aggregate into network stats
   * :param time_value: Time taken for frontman to finish
   * :return: Token stats of the entire network, either cumulative or single iteration.
   * Always contains the standard metric keys (zeros when there is
   * nothing to aggregate) so downstream consumers can rely on them.
   */
  sum_all_tokens(token_dict, time_value) {
    let aggregated = dict(ZERO_TOKEN_STATS);
    for (const models of Object.values(token_dict)) {
      for (const model_stats of Object.values(models)) {
        for (const [metric, value] of Object.entries(model_stats)) {
          if (metric != "time_taken_in_seconds") {
            aggregated[metric] = dict.get(aggregated, metric, 0) + value;
          }
        }
      }
    }
    aggregated["time_taken_in_seconds"] = time_value;
    return aggregated;
  }
  /**
   * Recursively merge two dictionaries.
   *
   * If both dictionaries contain the same key:
   * - If the corresponding values are dictionaries, they are merged recursively.
   * - Otherwise, the values are assumed to be numeric and are summed.
   *
   * Keys that exist only in one dictionary are carried over unchanged.
   *
   * :param dict_1: The base dictionary.
   * :param dict_2: The dictionary whose values will be merged into `dict_1`.
   * :return: A new dictionary containing the merged result.
   */
  merge_dicts(dict_1, dict_2) {
    let result = dict(dict_1);
    for (const [key, value] of Object.entries(dict_2)) {
      if (contains(key, result)) {
        if (is_dict(result[key]) && is_dict(value)) {
          result[key] = this.merge_dicts(result[key], value);
        } else {
          result[key] += value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
exposeClassAttributes(LangChainTokenCounter);
class NeuroSanRunnable extends RunnablePassthrough {
  static {
    this.invocation_context = null;
  }
  static {
    this.interceptor = null;
  }
  static {
    this.origin = null;
  }
  static {
    this.session_id = null;
  }
  static {
    this.logger = null;
  }
  static {
    this.sensitive_logger = null;
  }
  static {
    this.run_target = null;
  }
  static {
    this.tracing_context = null;
  }
  static {
    this.model_config = new ConfigDict({ arbitrary_types_allowed: true });
  }
  /**
   * Constructor
   */
  constructor(kwargs = {}) {
    let run_target = dict.get(kwargs, "run_target", null);
    super({ ...kwargs });
    Object.assign(this, kwargs);
    if (this.run_target == null) {
      this.run_target = this;
    }
    this.logger = getLogger(this.constructor.name);
    this.sensitive_logger = new SensitiveLogger(this.logger);
  }
  async invoke(input, config) {
    await this.run_target.run_it(input);
    let outputs = this.get_intercepted_outputs();
    return outputs;
  }
  /**
   * Transform a single input into an output.
   *
   * @param inputs - The input to the `Runnable`.
   * @returns The output of the `Runnable`.
   */
  async run_it(inputs) {
    throw Error("Method not implemented");
  }
  /**
   * Prepare a RunnableConfig for a Runnable invocation.  See:
   * https://python.langchain.com/api_reference/core/runnables/langchain_core.runnables.config.RunnableConfig.html
   *
   * :param session_id: An id for the run
   * :param callbacks: A list of BaseCallbackHandlers to use for the run
   * :param recursion_limit: Maximum number of times a call can recurse.
   * :return: A dictionary to be used for a Runnable's invoke config.
   */
  prepare_runnable_config(session_id, callbacks, recursion_limit, use_run_name) {
    let agent_name = this.invocation_context.get_agent_name();
    let run_name = null;
    if (use_run_name) {
      let agent_prefix = "";
      if (agent_name) {
        agent_prefix = agent_name;
      }
      let origin_name = "";
      if (this.origin) {
        let full_name = Origination.get_full_name_from_origin(this.origin);
        origin_name = `${full_name}`;
      }
      let delimiter = "";
      if (agent_prefix && origin_name) {
        delimiter = ":";
      }
      run_name = `${agent_prefix}${delimiter}${origin_name}`;
    }
    let runnable_config = {};
    if (session_id) {
      runnable_config["configurable"] = { "session_id": session_id };
    }
    if (run_name) {
      runnable_config["run_name"] = run_name;
    }
    if (callbacks) {
      runnable_config["callbacks"] = callbacks;
    }
    if (recursion_limit) {
      runnable_config["recursion_limit"] = recursion_limit;
    }
    let runnable_metadata = this.prepare_tracing_metadata();
    if (runnable_metadata) {
      runnable_config["metadata"] = runnable_metadata;
    }
    if (this.tracing_context) {
      runnable_config = this.tracing_context.augment_config(runnable_config);
    }
    return runnable_config;
  }
  /**
   * Prepare a dictionary of metadata for tracing purposes.
   *
   * :return: A dictionary of metadata for run tracing
   */
  prepare_tracing_metadata() {
    let runnable_metadata = {};
    let env_vars_str = process.env["AGENT_TRACING_METADATA_ENV_VARS"] ?? "POD_NAME POD_NAMESPACE POD_IP NODE_NAME";
    let to_add = MetadataUtil.minimize_metadata(environ, env_vars_str);
    Object.assign(runnable_metadata, to_add);
    let request_keys = process.env["AGENT_TRACING_METADATA_REQUEST_KEYS"] ?? getenv("AGENT_FORWARDED_REQUEST_METADATA", "request_id user_id");
    let request_metadata = this.invocation_context.get_metadata();
    let use_to_add = MetadataUtil.minimize_metadata(request_metadata, request_keys);
    Object.assign(runnable_metadata, use_to_add);
    return runnable_metadata;
  }
  /**
   * :return: the intercepted outputs
   */
  get_intercepted_outputs() {
    let intercepted_messages = this.interceptor.get_messages();
    let messages = messages_to_dict(intercepted_messages);
    let outputs = { "messages": messages };
    return outputs;
  }
}
exposeClassAttributes(NeuroSanRunnable);
let MINUTES = 60;
let RATE_LIMIT_ERROR_TYPES = ResolverUtil.create_type_tuple(["openai.RateLimitError", "anthropic.RateLimitError", "google.genai._interactions.RateLimitError", "openrouter.errors.TooManyRequestsResponseError"]);
let API_ERROR_TYPES = ResolverUtil.create_type_tuple(["openai.APIError", "anthropic.APIError", "langchain_google_genai.chat_models.ChatGoogleGenerativeAIError", "openrouter.errors.OpenRouterError"]);
class RunContextRunnable extends NeuroSanRunnable {
  static {
    this.model_config = new ConfigDict({ arbitrary_types_allowed: true });
  }
  /**
   * Transform a single input into an output.
   *
   * @param inputs - The input to the `Runnable`.
   * @returns The output of the `Runnable`.
   */
  async run_it(inputs) {
    let agent_spec = this.tool_caller.get_agent_tool_spec();
    let max_execution_seconds = dict.get(agent_spec, "max_execution_seconds", 5 * MINUTES);
    let max_iterations = dict.get(agent_spec, "max_iterations");
    if (max_iterations != null) {
      this.logger.warning("Agent config for '%s' of '%s' network contains 'max_iterations' which is deprecated. Please use 'max_steps' instead.", this.tool_caller.get_name(), this.invocation_context.get_agent_name());
    }
    let max_steps = dict.get(agent_spec, "max_steps") || max_iterations || 1e4;
    let journaling_callback = new JournalingCallbackHandler({ calling_agent_journal: this.journal, base_journal: this.invocation_context.get_journal(), parent_origin: this.origin, origination: this.invocation_context.get_origination() });
    let callbacks = [journaling_callback];
    agent_spec = this.tool_caller.get_agent_tool_spec();
    let verbose = dict.get(agent_spec, "verbose", false);
    if (isinstance2(verbose, String) && contains(verbose.toLowerCase(), tuple2("true", "extra", "logging"))) {
      let LoggingCallbackHandler = ResolverUtil.create_type("langchain_classic.callbacks.tracers.logging.LoggingCallbackHandler", { install_if_missing: "langchain-classic" });
      callbacks.push(new LoggingCallbackHandler(this.logger));
    }
    let max_attempts = dict.get(agent_spec, "max_attempts", 3);
    max_attempts = max2(max_attempts, 1);
    let runnable_config = this.prepare_runnable_config(null, callbacks, max_steps, false);
    runnable_config = mergeConfigs(ensureConfig(), runnable_config);
    let token_counter = new LangChainTokenCounter(this.primary_llm, this.invocation_context, this.journal, this.origin);
    try {
      const _resource = journaling_callback.scope();
      try {
        await token_counter.count_tokens(this.invoke_agent_chain(inputs, runnable_config, max_attempts), max_execution_seconds);
      } finally {
        _resource.close?.();
      }
    } catch (e) {
      this.logger.warning("Agent '%s' timed out: exceeded max_execution_seconds=%ss and was cancelled.", Origination.get_full_name_from_origin(this.origin), max_execution_seconds);
    }
    return inputs;
  }
  /**
   * Set the agent in motion
   *
   * :param inputs: The inputs to the agent_executor
   * :param runnable_config: The runnable_config to send to the agent_executor
   * :param max_attempts: The maximum number of attempts to make allowing for errors of any kind.
   */
  async invoke_agent_chain(inputs, runnable_config, max_attempts) {
    let chain_result = null;
    let attempts = max_attempts;
    let exception = null;
    let backtrace = null;
    while (chain_result == null && attempts > 0) {
      backtrace = null;
      try {
        chain_result = await this.agent_chain.invoke(inputs, runnable_config);
      } catch (rate_limit_error) {
        if (rate_limit_error instanceof Error) {
          await this.journal_retry_reason(rate_limit_error, "the LLM provider rate-limited the request");
          attempts = attempts - 1;
          exception = rate_limit_error;
        } else if (rate_limit_error instanceof Error) {
          const api_error = rate_limit_error;
          backtrace = format_exc();
          let message = null;
          if (!ApiKeyErrorCheck.check_for_internal_error(backtrace)) {
            message = ApiKeyErrorCheck.check_for_api_key_exception(api_error);
          }
          if (message != null) {
            exception = null;
            backtrace = null;
            chain_result = { "output": message };
            this.logger.error("API KEY error detected: %s", ApiKeyErrorCheck.get_safe_log_message(api_error));
            break;
          }
          await this.journal_retry_reason(api_error, "the LLM API returned an error");
          attempts = attempts - 1;
          exception = api_error;
        } else if (rate_limit_error instanceof Error) {
          const key_error = rate_limit_error;
          await this.journal_retry_reason(key_error, "the response was missing an expected field");
          attempts = attempts - 1;
          exception = key_error;
          backtrace = format_exc();
        } else if (rate_limit_error instanceof Error) {
          const value_error = rate_limit_error;
          let response = String(value_error);
          let find_string = "An output parsing error occurred. In order to pass this error back to the agent and have it try again, pass `handle_parsing_errors=True` to the AgentExecutor. This is the error: Could not parse LLM output: `";
          if (response.startsWith(find_string)) {
            chain_result = { "output": response.removeprefix(find_string).removesuffix("`") };
          } else {
            await this.journal_retry_reason(value_error, "the model's output could not be parsed");
            attempts = attempts - 1;
            exception = value_error;
            backtrace = format_exc();
          }
        } else if (rate_limit_error instanceof Error) {
          const exception_error = rate_limit_error;
          this.sensitive_logger.error("Got exception in  %s. Error: %s", this.constructor.name, exception_error);
          attempts = 0;
          exception = exception_error;
          backtrace = format_exc();
        }
      }
    }
    if (chain_result == null && backtrace != null) {
      this.sensitive_logger.error("%s", backtrace);
    }
    let output = this.parse_chain_result(chain_result, exception);
    let return_message = this.build_return_message(chain_result, output);
    await this.journal.write_message(return_message, null);
  }
  /**
   * Surface the reason for a recoverable-error retry on the journal so clients
   * see *why* a step is being retried instead of an unexplained stall. The reason
   * is written as an AgentFrameworkMessage: it carries this agent's origin (so it
   * is never mistaken for the final answer) and is excluded from chat history (so
   * it does not bloat the tokens sent back to the LLM). Backtraces stay in the
   * server log only.
   *
   * :param error: The recoverable exception triggering the retry.
   * :param reason: A concise, client-facing description of what went wrong.
   */
  async journal_retry_reason(error, reason) {
    let text = `Retrying: ${reason} (${error.constructor.name}) - ${error}`;
    this.sensitive_logger.warning(text);
    if (this.sensitive_logger.should_log()) {
      await this.journal.write_message(new AgentFrameworkMessage(text));
    }
  }
  /**
   * Locate the provider-native AIMessage that carries the chain's answer.
   *
   * :param chain_result: The result from invoking the agent chain
   * (see parse_chain_result() for the possible shapes)
   * :return: The last AIMessage in a dict result's "messages", the result
   * itself when it is an AIMessage, or null when the result carries
   * no AIMessage at all (exception, API-key error text, bare "output")
   */
  static find_ai_message(chain_result) {
    let use_result = chain_result;
    if (use_result != null && use_result.constructor && use_result.constructor.name === "AgentFinish") {
      use_result = use_result.return_values;
    }
    if (isinstance2(use_result, AIMessage)) {
      return use_result;
    }
    if (is_dict(use_result)) {
      let messages = dict.get(use_result, "messages", []);
      for (const message of reversed2(messages)) {
        if (isinstance2(message, AIMessage)) {
          return message;
        }
      }
    }
    return null;
  }
  /**
   * Parse the result from the langchain chain.
   *
   * :param chain_result: The result from invoking the agent chain.
   * Can be:
   * * An AgentFinish instance whose return_values can be any one of the following
   * * A dictionary whose keys might be:
   * "output" - the actual output to use
   * "messages" - effectively a chat history
   * * An AIMessage whose content is the output to use
   * * null, when every attempt to invoke the chain failed
   * :param exception: unknown exception that happened along the way,
   * or null if the chain invocation succeeded
   * :return: A string value to return as the result of the run.
   */
  parse_chain_result(chain_result, exception) {
    let output = null;
    if (chain_result == null && exception != null) {
      output = `Agent stopped due to exception ${exception}`;
    } else {
      let ai_message = RunContextRunnable.find_ai_message(chain_result);
      if (ai_message != null) {
        output = ai_message.content;
      } else {
        let use_result = chain_result;
        if (use_result != null && use_result.constructor && use_result.constructor.name === "AgentFinish") {
          use_result = use_result.return_values;
        }
        if (is_dict(use_result)) {
          output = dict.get(use_result, "output");
        }
      }
    }
    if (output != null && typeof output !== "string") {
      output = ContentUtils.flatten_to_text(output);
    }
    output = this.error_detector.handle_error(output);
    return output;
  }
  /**
   * Build the AIMessage that is journaled as this agent's answer for the turn.
   *
   * Plain-string answers, error paths, and anything the ErrorDetector
   * rewrote keep the exact shape they have always had: a fresh AIMessage
   * carrying only the parsed text. When the provider-native message
   * carries block content (Anthropic thinking, OpenAI Responses reasoning,
   * ...), that message is preserved instead, with its content normalized
   * to standard v1 blocks (see ContentUtils.normalize_message) so the
   * blocks and its usage_metadata reach the journal. The wire is the
   * same either way: the converter projects block content to the same
   * text and emits nothing else for it in this phase.
   *
   * The chat history does not depend on which shape is chosen:
   * OriginatingJournal.write_message appends a text-only copy of any
   * block-content AI message, so what is handed to a provider (or a
   * fallback provider) stays provider-agnostic.
   *
   * :param chain_result: The result from invoking the agent chain
   * :param output: The parsed, error-checked text from parse_chain_result()
   * :return: The BaseMessage to journal as the answer
   */
  build_return_message(chain_result, output) {
    let ai_message = RunContextRunnable.find_ai_message(chain_result);
    if (ai_message == null) {
      return new AIMessage({ content: output == null ? "" : output });
    }
    if (output != ContentUtils.flatten_to_text(ai_message)) {
      return new AIMessage({ content: output == null ? "" : output });
    }
    if (isinstance2(ai_message, AIMessageChunk)) {
      ai_message = message_chunk_to_message(ai_message);
    }
    let preserved = ContentUtils.normalize_message(ai_message);
    if (isinstance2(preserved.content, String)) {
      return new AIMessage({ content: output == null ? "" : output });
    }
    if (ContentUtils.flatten_to_text(preserved) != output) {
      return new AIMessage({ content: output == null ? "" : output });
    }
    return preserved;
  }
}
exposeClassAttributes(RunContextRunnable);
class MiddlewareFactory {
  /**
   * :param invocation_context: The invocation context for the request.
   * :param origin: A list of dictionaries containing origin information as to which agent
   * is creating the middleware.
   * :param chat_history: The chat history of the RunContext that the middleware is being created for.
   * :param activation_capsule: An instance of ActivationCapsule that allows for
   * access to agents to be called during middleware invocation.
   */
  constructor(invocation_context, origin, chat_history, activation_capsule) {
    this.invocation_context = invocation_context;
    this.origin = origin;
    this.chat_history = chat_history;
    this.activation_capsule = activation_capsule;
    this.logger = getLogger(this.constructor.name);
  }
  /**
   * Create instances of AgentMiddleware based on the config.
   * :param config: A list of dictionaries containing specific middleware configurations.
   * Order matters.
   * :param sly_data: The private sly_data dictionary for the agent invocation
   * :return: A tuple of:
   * * A list of instances of AgentMiddleware.
   * Can be an empty list if there is no middleware to create.
   * * A Checkpointer instance if required by the config. Can be null.
   */
  create_agent_middleware(config, sly_data) {
    let checkpointer = null;
    let all_middleware = [];
    if (config == null || len(config) == 0) {
      return [all_middleware, checkpointer];
    }
    for (const [middleware_index, one_config] of enumerate2(config)) {
      let middleware = null;
      let created_checkpointer = null;
      [middleware, created_checkpointer] = this.create_middleware(one_config, sly_data, middleware_index);
      if (middleware != null) {
        all_middleware.push(middleware);
      }
      if (created_checkpointer != null) {
        if (checkpointer != null) {
          this.logger.warning("Multiple Checkpointers specified. Using the first one.");
        } else {
          checkpointer = created_checkpointer;
        }
      }
    }
    return [all_middleware, checkpointer];
  }
  /**
   * Create an instance of AgentMiddleware based on the config.
   *
   * :param config: A dictionary containing specific middleware configurations.
   * :param sly_data: The private sly_data dictionary for the agent invocation.
   * :param index: The index of the middleware in the config
   * :return:
   * Can be null if there is no middleware to create.
   * :return: A tuple of:
   * * An instance of AgentMiddleware per the config.
   * Can be null if there is no middleware to create.
   * * A Checkpointer instance if required by the config. Can be null.
   */
  create_middleware(config, sly_data, index) {
    let checkpointer = null;
    let middleware = this.create_class("AgentMiddleware", AgentMiddleware, config, sly_data, index);
    let checkpointer_config = dict.get(config, "checkpointer");
    if (checkpointer_config != null) {
      checkpointer = this.create_class("Checkpointer", Checkpointer, checkpointer_config, sly_data, index);
    }
    return middleware;
  }
  /**
   * Create an instance of a class based on the config.
   *
   * :param what_we_are_creating: A string to describe what we are creating.
   * :param create_type: The type of class to create.
   * :param config: A dictionary containing specific class configurations.
   * :param sly_data: The private sly_data dictionary for the agent invocation.
   * :param index: The index of the class in the config.
   * :return: An instance of the class or null if class creation fails.
   */
  create_class(what_we_are_creating, create_type, config, sly_data, index) {
    let error_context = this._build_error_context(what_we_are_creating, index);
    let class_name = this._get_class_name(config, error_context);
    if (class_name == null) {
      return null;
    }
    let created_class = this._resolve_class(class_name, error_context, create_type);
    let middleware_origin, middleware_origin_str, reservationist = this._prepare_middleware_context(class_name, config);
    let args = this._prepare_args(config, sly_data, middleware_origin, middleware_origin_str, reservationist);
    return this._instantiate_class(created_class, args, what_we_are_creating, class_name);
  }
  /**
   * Build a descriptive error context string.
   */
  _build_error_context(what_we_are_creating, index) {
    let origin_str = Origination.get_full_name_from_origin(this.origin);
    return `${what_we_are_creating} at index ${index} of ${origin_str}`;
  }
  /**
   * Validate config and extract the class name.
   * :return: The class name, or null if config is invalid.
   */
  _get_class_name(config, error_context) {
    if (!is_dict(config)) {
      this.logger.warning("%s is missing a configuration dictionary. Skipping it.", error_context);
      return null;
    }
    let class_name = dict.get(config, "class");
    if (class_name == null) {
      this.logger.warning("%s is missing the 'class' field. Skipping it.", error_context);
      return null;
    }
    return class_name;
  }
  /**
   * Resolve and return the class from the class name.
   */
  _resolve_class(class_name, error_context, create_type) {
    try {
      return ResolverUtil.create_class(class_name, error_context, create_type);
    } catch (exception) {
      let message = `
Problems loading class ${class_name}: ${String(exception)}

Check these things:
1. Is the class findable from what is set in your PYTHONPATH?
`;
      this.logger.error(message);
      throw new Error(message);
    }
  }
  /**
   * Prepare the origin and reservationist for the middleware.
   * :param class_name: The class name of the middleware.
   * :param config: The middleware configuration dictionary.
   * :return: A tuple of (middleware_origin, middleware_origin_str, reservationist).
   */
  _prepare_middleware_context(class_name, config) {
    let tool_name_for_class = at2(class_name.split("."), -1);
    let origination = this.invocation_context.get_origination();
    let middleware_origin = origination.add_spec_name_to_origin(this.origin, tool_name_for_class);
    let middleware_origin_str = Origination.get_full_name_from_origin(middleware_origin);
    let reservationist = null;
    let config_extractor = new DictionaryExtractor(config, ".");
    if (config_extractor.get("allow.reservations")) {
      let real_reservationist = this.invocation_context.get_reservationist();
      if (real_reservationist != null) {
        reservationist = new AccumulatingAgentReservationist(real_reservationist, middleware_origin_str);
      }
    }
    return middleware_origin;
  }
  /**
   * Prepare the args dict, injecting framework-provided values for special keys.
   */
  _prepare_args(config, sly_data, middleware_origin, middleware_origin_str, reservationist) {
    let args = dict(dict.get(config, "args", {}));
    let special_args = { "origin": middleware_origin, "origin_str": middleware_origin_str, "reservationist": reservationist, "sly_data": sly_data, "chat_history": this.chat_history, "activation_capsule": this.activation_capsule };
    for (const [key, value] of Object.entries(special_args)) {
      if (contains(key, args)) {
        args[key] = value;
      }
    }
    if (contains("journal", args) || contains("progress_reporter", args)) {
      let journal = new OriginatingJournal(this.invocation_context.get_journal(), middleware_origin);
      if (contains("journal", args)) {
        args["journal"] = journal;
      }
      if (contains("progress_reporter", args)) {
        args["progress_reporter"] = new ProgressJournal(journal);
      }
    }
    return args;
  }
  /**
   * Instantiate the resolved class with the prepared args.
   */
  _instantiate_class(created_class, args, what_we_are_creating, class_name) {
    try {
      return created_class(args);
    } catch (exception) {
      let message = `
Problems creating ${what_we_are_creating} instance of ${class_name}: ${String(exception)}

Check these things:
1. Is the class findable from what is set in your PYTHONPATH?
2. Are the args correct?
`;
      this.logger.error(message);
      throw new Error(message);
    }
  }
}
exposeClassAttributes(MiddlewareFactory);
class ActivationCapsule extends LingeringResource {
  /**
   * :param parent_run_context: The RunContext of the agent calling this method
   * :param parent_agent_spec: The spec of the agent calling this method.
   * :param agent_tool_factory: A factory that will be used to create the agent tool
   */
  constructor(parent_run_context, parent_agent_spec, agent_tool_factory) {
    super();
    this.parent_run_context = parent_run_context;
    this.parent_agent_spec = parent_agent_spec;
    this.factory = agent_tool_factory;
    this.lingerers = [];
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
    for (const lingering_resource of this.lingerers) {
      await lingering_resource.close_of_work(this);
    }
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
    if (this.factory == null || this.parent_agent_spec == null) {
      throw new Error("ActivationCapsule.use_tool() requires an AgentToolFactory and parent_agent_spec; this capsule was created without them.");
    }
    let invocation_context = this.parent_run_context.get_invocation_context();
    let invocation = invocation_context.get_effective_invocation();
    let callable_activation = this.factory.create_agent_activation(this.parent_run_context, this.parent_agent_spec, tool_name, sly_data, tool_args, this.factory, invocation);
    this.lingerers.push(callable_activation);
    let message = null;
    try {
      message = await callable_activation.build();
    } catch (exception) {
      invocation_context = this.parent_run_context.get_invocation_context();
      let async_factory = invocation_context.get_async_session_factory();
      if (!async_factory.is_use_direct() && tool_name.startsWith("/")) {
        throw new Error(`
Attempt to call ${tool_name} as an external agent network over http failed.
If you are getting this from the agent_cli command line, consider adding the --local_externals_direct
flag to your invocation.
`);
      }
      throw exception;
    }
    return ContentUtils.flatten_to_text(message);
  }
  /**
   * :param llm_config: The llm config dictionary
   * :param sly_data: The private sly_data dictionary. This is needed for bring-your-own-key scenarios.
   * :param num_fallbacks: The number of fallbacks to try. Default value of null implies all.
   * :return: The llm model to use given the context type (usually langchain)
   */
  create_chat_model(llm_config, sly_data, num_fallbacks) {
    let invocation_context = this.parent_run_context.get_invocation_context();
    let llm_factory = invocation_context.get_llm_factory();
    let llm_resources = llm_factory.create_llm_withFallbacks(llm_config, sly_data, num_fallbacks);
    if (llm_resources == null) {
      throw new Error("Unable to create LLM from llm_config (missing required configuration and/or sly_data).");
    }
    if (is_dict(llm_resources)) {
      let required_sly_data = dict.get(llm_resources, "required_sly_data_errors", []);
      let required = sorted2(required_sly_data).join("\n");
      throw new Error(`LLM operation for this agent requires at least one of the following set in sly_data.llm_config:
${required}
`);
    }
    this.lingerers.push(llm_resources);
    let model = llm_resources.get_model();
    return model;
  }
}
exposeClassAttributes(ActivationCapsule);
class LangChainRunContext extends RunContext {
  /**
   * Constructor
   *
   * :param llm_config: The default llm_config to use as an overlay
   * for the tool-specific llm_config
   * :param parent_run_context: The parent RunContext that is calling this one. Can be null.
   * :param tool_caller: The tool caller to use
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param chat_context: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   * :param middleware_config: An ordered list of middleware configurations
   * :param tracing_context: A TracingContext for the request
   */
  constructor(llm_config, parent_run_context, tool_caller, invocation_context, chat_context, middleware_config, tracing_context) {
    super();
    this.chat_history = [];
    this.middleware_config = middleware_config;
    this.journal = null;
    this.interceptor = null;
    this.llm_resources = null;
    this.agent_chain = null;
    this.llm_config = llm_config;
    this.run_id_base = String(uuid4());
    this.tools = [];
    this.error_detector = null;
    this.recent_human_message = null;
    this.tool_caller = tool_caller;
    this.invocation_context = invocation_context;
    this.chat_context = chat_context;
    this.origin = [];
    this.resources_created = false;
    this.logger = getLogger(this.constructor.name);
    this.tracing_context = tracing_context;
    this.capsule = null;
    this.create_capsule();
    this.update_from_parent_run_context(parent_run_context);
    this.update_from_chat_context(this.chat_context);
    if (this.origin != null && len(this.origin) > 0) {
      let full_name = Origination.get_full_name_from_origin(this.origin);
      this.logger = getLogger(full_name);
    }
    if (this.invocation_context != null) {
      this.update_invocation_context(this.invocation_context);
    }
  }
  /**
   * Create the ActivationCapsule
   */
  create_capsule() {
    if (this.tool_caller != null) {
      let agent_spec = this.tool_caller.get_agent_tool_spec();
      let factory = this.tool_caller.get_inspector();
      this.capsule = new ActivationCapsule(this, agent_spec, factory);
    } else {
      this.capsule = new ActivationCapsule(this);
    }
  }
  /**
   * Update from parent run context
   * :param parent_run_context: The parent RunContext
   */
  update_from_parent_run_context(parent_run_context) {
    if (parent_run_context == null) {
      return;
    }
    if (this.invocation_context == null) {
      this.invocation_context = parent_run_context.get_invocation_context();
    }
    if (this.chat_context == null) {
      this.chat_context = parent_run_context.get_chat_context();
    }
    this.tracing_context = parent_run_context.get_tracing_context().clone();
    let parent_origin = parent_run_context.get_origin();
    let agent_name = this.tool_caller.get_name();
    let origination = this.invocation_context.get_origination();
    this.origin = origination.add_spec_name_to_origin(parent_origin, agent_name);
  }
  /**
   * :param chat_context: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   */
  update_from_chat_context(chat_context) {
    this.chat_context = chat_context;
    if (this.chat_context == null) {
      return;
    }
    let empty = [];
    let chat_histories = dict.get(this.chat_context, "chat_histories", empty);
    let our_origin_str = Origination.get_full_name_from_origin(this.origin);
    for (const one_chat_history of iter2(chat_histories)) {
      let test_origin = dict.get(one_chat_history, "origin", empty);
      let test_origin_str = Origination.get_full_name_from_origin(test_origin);
      if (test_origin_str != our_origin_str) {
        continue;
      }
      let one_messages = dict.get(one_chat_history, "messages", empty);
      if (!one_messages) {
        break;
      }
      let converter = new BaseMessageDictionaryConverter(null, true);
      this.chat_history = [];
      for (const chat_message of iter2(one_messages)) {
        let base_message = converter.from_dict(chat_message);
        if (base_message != null) {
          this.chat_history.push(base_message);
        }
      }
      break;
    }
  }
  /**
   * Creates resources for later use within the RunContext instance.
   * Results are stored as a member in this instance for future use.
   *
   * Note that even though this method is labeled as async, we don't
   * really do any async method calls in here for this implementation.
   *
   * :param agent_name: String name of the agent
   * :param instructions: string instructions that are used
   * to create the agent
   * :param assignments: string assignments of function parameters that are used as input
   * :param tool_names: The list of registered tool names to use.
   * Default is null implying no tool is to be called.
   */
  async create_resources(agent_name, instructions, assignments, tool_names) {
    if (this.resources_created) {
      return;
    }
    let _ = agent_name;
    let full_name = Origination.get_full_name_from_origin(this.origin);
    let agent_spec = this.tool_caller.get_agent_tool_spec();
    this.error_detector = new ErrorDetector(full_name, { error_formatter_name: dict.get(agent_spec, "error_formatter"), system_error_fragments: ["Agent stopped"], agent_error_fragments: dict.get(agent_spec, "error_fragments") });
    if (tool_names != null) {
      let factory = new BaseToolFactory(this.tool_caller, this.invocation_context, this.journal);
      for (const tool_name of iter2(tool_names)) {
        let tool = await factory.create_base_tool(tool_name);
        if (tool != null) {
          if (isinstance2(tool, Array)) {
            this.tools.push(...tool);
          } else {
            this.tools.push(tool);
          }
        }
      }
    }
    if (!this.chat_history) {
      await this.journal.write_message(new SystemMessage(instructions));
    }
    this.agent_chain = this.create_agent_withFallbacks(instructions);
    this.resources_created = true;
  }
  /**
   * Creates an agent with potential fallback llms to use.
   * :param instructions: The instructions to use for the agent
   * :return: An Agent (Runnable)
   */
  create_agent_withFallbacks(instructions) {
    let llm_factory = this.invocation_context.get_llm_factory();
    let sly_data = this.tool_caller.get_sly_data();
    let main_llm_resources = llm_factory.create_llm_withFallbacks(this.llm_config, sly_data);
    if (is_dict(main_llm_resources)) {
      let error = "No fully-specified LLM found in llm_config or fallbacks.";
      let error_dict = main_llm_resources;
      let required_sly_data = dict.get(error_dict, "required_sly_data_errors", []);
      if (len(required_sly_data) > 0) {
        error += "\nLLM operation for this agent requires at least one ";
        error += "of the following set in sly_data.llm_config:\n";
        error += sorted2(required_sly_data).join("\n    ") + "\n";
      }
      let construction_errors = dict.get(error_dict, "construction_errors", []);
      if (len(construction_errors) > 0) {
        error += "\nThe following errors occurred while constructing LLMs:\n";
        error += construction_errors.join("\n    ") + "\n";
      }
      let api_key_errors = dict.get(error_dict, "api_key_errors", []);
      if (len(api_key_errors) > 0) {
        error += "\n\nLLM operation for this agent requires at least one LLM provider API key";
        error += " to be set as an environment variable.";
        error += "\nThe following errors occurred while looking for LLM API keys:\n";
        error += api_key_errors.join("\n    ");
        for (const api_key_error of iter2(api_key_errors)) {
          let sensitive_logger = new SensitiveLogger(this.logger);
          sensitive_logger.error("API KEY error detected: %s", api_key_error);
        }
      }
      throw new Error(error);
    }
    this.llm_resources = main_llm_resources;
    let agent = this.create_agent(instructions, main_llm_resources.get_model());
    return agent;
  }
  /**
   * Creates an agent.
   * :param instructions: The instructions to use for the agent
   * :param llm: The BaseLanguageModel to use for the agent
   * :return: An Agent (Runnable)
   */
  create_agent(instructions, llm) {
    let middleware_factory = new MiddlewareFactory(this.invocation_context, this.origin, this.chat_history, this.capsule);
    let sly_data = this.tool_caller.get_sly_data();
    let [middleware, checkpointer] = middleware_factory.create_agent_middleware(this.middleware_config, sly_data);
    return create_agent({ model: llm, tools: this.tools, middleware, checkpointer, system_prompt: instructions });
  }
  /**
   * Submits a message to the model used by this instance.
   *
   * Note that even though this method is labeled as async, we don't
   * really do any async method calls in here for this implementation.
   *
   * :param user_message: The message to submit
   * :return: The run which is processing the agent's message
   */
  async submit_message(user_message) {
    try {
      this.recent_human_message = new HumanMessage(user_message);
    } catch (exception) {
      let full_name = Origination.get_full_name_from_origin(this.origin);
      let message = `ValidationError in ${full_name} with message: ${user_message}`;
      throw new Error(message);
    }
    let run = new LangChainRun(this.run_id_base, this.chat_history);
    return run;
  }
  /**
   * Loops on the given run's status for model invokation.
   *
   * This truly is an asynchronous method.
   *
   * :param run: The run to wait on
   * :param journal: The Journal which captures the "thinking" messages.
   * :return: An potentially updated run
   */
  async wait_on_run(run, journal) {
    let _ = [run, journal];
    let previous_chat_history = copy(this.chat_history);
    let inputs = { "messages": [...previous_chat_history, this.recent_human_message] };
    await this.journal.write_message(this.recent_human_message, null);
    let use_run = new LangChainRun(this.run_id_base, this.chat_history);
    let session_id = use_run.get_id();
    let runnable = new RunContextRunnable({ agent_chain: this.agent_chain, primary_llm: this.llm_resources.get_model(), invocation_context: this.invocation_context, journal: this.journal, interceptor: this.interceptor, origin: this.origin, tool_caller: this.tool_caller, error_detector: this.error_detector, session_id, tracing_context: this.tracing_context });
    let runnable_config = runnable.prepare_runnable_config(session_id, null, null, true);
    let chain = new RunnablePassthrough().pipe(runnable);
    await chain.invoke(inputs, runnable_config);
    return use_run;
  }
  /**
   * :return: The list of messages from the instance's thread.
   */
  get_response() {
    return this.chat_history;
  }
  /**
   * :param run: The Run handling the execution of the agent
   * :param tool_outputs: The tool outputs to submit
   * The component dictionaries can have the following keys:
   * "origin"        A List of origin dictionaries indicating the origin of the run.
   * "output"        A string representing the output of the tool call
   * "sly_data"      Optional sly_data dictionary that might have returned from an external tool.
   * "tool_call_id"  The string id of the tool_call being executed
   * :return: A potentially updated run handle
   */
  async submit_tool_outputs(run, tool_outputs) {
    let _ = run;
    let tool_message = null;
    if (tool_outputs != null && len(tool_outputs) > 0) {
      for (const tool_output of iter2(tool_outputs)) {
        tool_message = this.parse_tool_output(tool_output);
        if (tool_message != null) {
          await this.journal.write_message(tool_message, null);
        }
      }
    }
    let use_run = new LangChainRun(this.run_id_base, this.chat_history, { tool_message });
    return use_run;
  }
  /**
   * Parse a single tool_output dictionary for its results
   * :return: A message representing the output from the tool.
   */
  parse_tool_output(tool_output) {
    let tool_chat_list_string = dict.get(tool_output, "output", null);
    if (tool_chat_list_string == null) {
      return null;
    }
    if (isinstance2(tool_chat_list_string, tuple2)) {
      tool_chat_list_string = tool_chat_list_string[0];
    }
    let tool_message = null;
    if (isinstance2(tool_chat_list_string, String)) {
      tool_message = this.parse_tool_chat_list_String(tool_chat_list_string, dict.get(tool_output, "origin"));
    } else if (isinstance2(tool_chat_list_string, BaseMessage)) {
      tool_message = new AgentToolResultMessage({ content: tool_chat_list_string.content, tool_result_origin: dict.get(tool_output, "origin") });
    } else if (isinstance2(tool_chat_list_string, Array) && isinstance2(at2(tool_chat_list_string, -1), BaseMessage)) {
      let last_message = at2(tool_chat_list_string, -1);
      tool_message = new AgentToolResultMessage({ content: last_message.content, tool_result_origin: dict.get(tool_output, "origin") });
    } else {
      this.logger.warning("Dunno what to do with %s tool output %s", String(tool_chat_list_string.constructor.name), String(tool_chat_list_string));
      return null;
    }
    let tool_sly_data = dict.get(tool_output, "sly_data");
    if (tool_sly_data && tool_sly_data != this.tool_caller.get_sly_data()) {
      Object.assign(this.tool_caller.get_sly_data(), tool_sly_data);
    }
    return tool_message;
  }
  /**
   * Parse a tool output string into a list of messages
   * :param tool_chat_list_string: The string to parse
   * :param origin: The origin of the tool
   * :return: A list of messages representing the output from the tool.
   */
  parse_tool_chat_list_String(tool_chat_list_string, origin) {
    while (tool_chat_list_string[0] == '"' && at2(tool_chat_list_string, -1) == '"' || tool_chat_list_string[0] == "'" && at2(tool_chat_list_string, -1) == "'") {
      tool_chat_list_string = slice2(tool_chat_list_string, 1, -1);
    }
    let intermediate_tool_chat_list_string = string2.replace(tool_chat_list_string, '\\"', '"');
    let use_tool_chat_list_string = string2.replace(intermediate_tool_chat_list_string, '\\"', '\\\\"');
    let tool_chat_list = null;
    try {
      tool_chat_list = loads(use_tool_chat_list_string);
    } catch (exception) {
      let sensitive_logger = new SensitiveLogger(this.logger);
      sensitive_logger.error("Exception: %s parsing %s", String(exception), String(use_tool_chat_list_string));
      throw exception;
    }
    let tool_result_dict = at2(tool_chat_list, -1);
    let tool_message = new AgentToolResultMessage({ content: dict.get(tool_result_dict, "content"), tool_result_origin: origin });
    return tool_message;
  }
  /**
   * Release resources owned by this context when the work is all done.
   * This can happen later than when the request is complete.
   *
   * :param parent_resource: parent resource, if any
   */
  async close_of_work(parent_resource) {
    if (this.llm_resources) {
      await this.llm_resources.close_of_work();
    }
    if (this.capsule) {
      await this.capsule.close_of_work();
    }
    this.chat_history = [];
    this.middleware_config = null;
    this.journal = null;
    this.interceptor = null;
    this.llm_resources = null;
    this.agent_chain = null;
    this.llm_config = null;
    this.run_id_base = null;
    this.tools = [];
    this.error_detector = null;
    this.recent_human_message = null;
    this.tool_caller = null;
    this.chat_context = null;
    this.origin = [];
    this.resources_created = false;
    this.tracing_context = null;
    this.capsule = null;
  }
  /**
   * :return: the dictionary describing the data-driven agent
   */
  get_agent_tool_spec() {
    if (this.tool_caller == null) {
      return null;
    }
    return this.tool_caller.get_agent_tool_spec();
  }
  /**
   * :return: The InvocationContext policy container that pertains to the invocation
   * of the agent.
   */
  get_invocation_context() {
    return this.invocation_context;
  }
  /**
   * :return: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   * Can be null when a new conversation has been started.
   */
  get_chat_context() {
    return this.chat_context;
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
    return this.origin;
  }
  /**
   * Update internal state based on the InvocationContext instance passed in.
   * :param invocation_context: The context policy container that pertains to the invocation
   */
  update_invocation_context(invocation_context) {
    let old_interceptor = this.interceptor;
    this.invocation_context = invocation_context;
    let base_journal = this.invocation_context.get_journal();
    this.interceptor = new InterceptingJournal(base_journal, this.origin);
    if (old_interceptor != null) {
      for (const message of old_interceptor.get_messages()) {
        this.interceptor.write_unwrapped_message(message, this.origin);
      }
    }
    this.journal = new OriginatingJournal(this.interceptor, this.origin, this.chat_history);
  }
  /**
   * :return: The Journal associated with the instance
   */
  get_journal() {
    return this.journal;
  }
  /**
   * :return: The TracingContext associated with the instance
   */
  get_tracing_context() {
    return this.tracing_context;
  }
}
exposeClassAttributes(LangChainRunContext);
class RunContextFactory {
  /**
   * Creates an appropriate RunContext
   *
   * :param parent_run_context: The parent RunContext (if any) to pass
   * down its resources to a new RunContext created by
   * this call.
   * :param tool_caller: The ToolCaller whose lifespan matches that
   * of the newly created RunContext
   * :param invocation_context: The context policy container that pertains to the invocation
   * of the agent.
   * :param chat_context: A ChatContext dictionary that contains all the state necessary
   * to carry on a previous conversation, possibly from a different server.
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default llm_config
   * :param tracing_context: A TracingContext for the request
   */
  static create_run_context(parent_run_context, tool_caller, invocation_context, chat_context, config, tracing_context) {
    let run_context = null;
    let empty = {};
    let use_config = config;
    if (use_config == null) {
      use_config = empty;
    }
    let default_llm_config = { "model_name": "gpt-5.2", "verbose": false };
    let use_llm_config = dict.get(use_config, "llm_config") || default_llm_config;
    let context_type = MasterLlmFactory.get_context_type(use_config);
    let use_invocation_context = invocation_context;
    if (use_invocation_context == null && parent_run_context != null) {
      use_invocation_context = parent_run_context.get_invocation_context();
    }
    if (context_type.startsWith("openai")) {
      throw new Error("OpenAI Assistants implementation is no longer supported by OpenAI.");
    }
    if (context_type.startsWith("langchain")) {
      run_context = new LangChainRunContext(use_llm_config, parent_run_context, tool_caller, use_invocation_context, chat_context, dict.get(use_config, "middleware_config"), tracing_context);
    } else {
      run_context = new LangChainRunContext(use_llm_config, parent_run_context, tool_caller, use_invocation_context, chat_context, dict.get(use_config, "middleware_config"), tracing_context);
    }
    return run_context;
  }
}
exposeClassAttributes(RunContextFactory);
class LangChainTracingContext extends TracingContext {
  /**
   * Constructor
   *
   * :param run_target: The RunTarget instance to be traced
   * :param config: The configuration for the tracing context
   */
  constructor(run_target, config) {
    super();
    this.run_target = run_target;
    this.config = config;
  }
  /**
   * Entry point method for the run.
   *
   * :param inputs: A list of inputs from the user.
   * :return: The outputs of the run.
   */
  async run_it(inputs) {
    let runnable = new NeuroSanRunnable({ ...this.config, run_target: this.run_target, tracing_context: this });
    let runnable_config = runnable.prepare_runnable_config(null, null, null, true);
    let chain = new RunnablePassthrough().pipe(runnable);
    await this.ainvoke(chain, inputs, runnable_config);
    return inputs;
  }
  /**
   * Invoke the chain with the inputs and config
   * :param chain: The chain to invoke
   * :param inputs: The inputs to the chain
   * :param runnable_config: The config for the runnable
   */
  async ainvoke(chain, inputs, runnable_config) {
    await chain.invoke(inputs, runnable_config);
  }
  /**
   * Creates a copy the tracing context.
   *
   * :return: A clone of the tracing context.
   */
  clone() {
    let clone = new LangChainTracingContext(this.run_target, this.config);
    return clone;
  }
  /**
   * Augment the configuration however the implementation sees fit (if at all).
   * :param runnable_config: The config for the runnable
   * :return: The augmented config
   */
  augment_config(runnable_config) {
    return runnable_config;
  }
  /**
   * Flush the tracing context.
   */
  flush() {
  }
}
exposeClassAttributes(LangChainTracingContext);
let LANGFUSE_HANDLER_VAR_NAME = "langfuse_handler";
class LangfuseTracingContext extends LangChainTracingContext {
  static {
    this.HANDLER_CONTEXT_VAR = null;
  }
  static {
    this._REGISTER_LOCK = Lock();
  }
  /**
   * Globally register the Langfuse CallbackHandler, if available.
   * This is really the only way we can do this with langchain managing span parentage.
   *
   * Called from the constructor rather than at class-load time so that
   * registration (and the Langfuse client the handler constructs from the
   * LANGFUSE_* env vars) only happens when a LangfuseTracingContext is
   * actually created - that is, when LANGFUSE_ENABLED is true per the
   * LangChainTracingContextFactory.  Merely installing langfuse with keys
   * in the environment must not start exporting traces.
   *
   * Caveat: registration is a process-lifetime one-way door.  Once the
   * first enabled request has registered the handler with langchain,
   * flipping LANGFUSE_ENABLED to false in the same process only stops the
   * per-request wrapping (root AGENT span, session/user metadata) - the
   * already-registered handler keeps exporting bare traces until the
   * process is restarted.  For LANGFUSE_ENABLED to fully disable tracing
   * it must be false before the process constructs its first
   * LangfuseTracingContext - operationally, false from process start.
   *
   * :return: The ContextVar carrying the langfuse callback handler.
   * :raises Error: (from ResolverUtil) when langfuse tracing is
   * wanted but the langfuse package is not installed, with the
   * standard "pip install" guidance in the message.  Nothing is
   * cached in that case, so the next construction retries the
   * resolution - a transient import failure must not poison
   * tracing for the rest of the process.
   */
  static _ensure_registered() {
    const _resource = this._REGISTER_LOCK;
    try {
      if (this.HANDLER_CONTEXT_VAR != null) {
        return this.HANDLER_CONTEXT_VAR;
      }
      let existing = LangfuseTracingContext._find_existing_handler_hook();
      if (existing != null) {
        return LangfuseTracingContext._adopt_existing_handler_hook(existing);
      }
      let callback_handler_type = ResolverUtil.create_type("langfuse.langchain.CallbackHandler", { install_if_missing: "langfuse" });
      dict.setDefault(process.env, "LANGFUSE_TRACING_ENABLED", "true");
      let callback_handler = callback_handler_type();
      callback_handler.run_inline = true;
      let context_var = new ContextVar(LANGFUSE_HANDLER_VAR_NAME, { default: callback_handler });
      registerConfigureHook(context_var, { inheritable: true });
      this.HANDLER_CONTEXT_VAR = context_var;
      return context_var;
    } finally {
      _resource.close?.();
    }
  }
  /**
   * Reuse a langfuse handler hook that some other component in this
   * process (e.g. a deployment wrapper) already registered with langchain.
   *
   * :param existing: The ContextVar of the already-registered hook.
   * :return: The ContextVar to cache as HANDLER_CONTEXT_VAR.
   */
  static _adopt_existing_handler_hook(existing) {
    let foreign_handler = dict.get(existing);
    if (foreign_handler != null) {
      foreign_handler.run_inline = true;
      let context_var = new ContextVar(LANGFUSE_HANDLER_VAR_NAME, { default: foreign_handler });
      registerConfigureHook(context_var, { inheritable: true });
      this.HANDLER_CONTEXT_VAR = context_var;
      return context_var;
    }
    getLogger(this.name).warning("Adopted an existing langfuse handler hook whose handler is not visible from this context; tracing may be unavailable on some threads.");
    this.HANDLER_CONTEXT_VAR = existing;
    return existing;
  }
  /**
   * :return: The ContextVar of a configure hook that some other component
   * already registered for a langfuse handler, identified by the
   * conventional ContextVar name "langfuse_handler".
   * null if there is no such hook.
   */
  static async _find_existing_handler_hook() {
    try {
      const { _configure_hooks: _configure_hooks2 } = import("../browser/shims.mjs").then((n) => n.empty);
    } catch (e) {
      return null;
    }
    for (const hook of iter2(_configure_hooks)) {
      let hook_var = hook[0];
      if (getattr2(hook_var, "name", null) == LANGFUSE_HANDLER_VAR_NAME) {
        return hook_var;
      }
    }
    return null;
  }
  /**
   * Constructor
   *
   * :param run_target: The RunTarget instance to be traced
   * :param config: The configuration for the tracing context
   * :param parent_context: The parent instance to riff from.
   */
  constructor(run_target, config, parent_context) {
    super(run_target, config);
    this.parent_context = parent_context;
    this.session_id = null;
    LangfuseTracingContext._ensure_registered();
    try {
      const { Langfuse } = import("../browser/shims.mjs").then((n) => n.empty);
      const { get_client: get_client2 } = import("../browser/shims.mjs").then((n) => n.empty);
      const { _AgnosticContextManager } = import("../browser/shims.mjs").then((n) => n.empty);
    } catch (e) {
      ResolverUtil.create_type("langfuse.langchain.CallbackHandler", { install_if_missing: "langfuse" });
      throw e;
    }
    this.langfuse_client = get_client();
    this.main_span = null;
  }
  /**
   * Creates a copy the tracing context.
   *
   * :return: A clone of the tracing context.
   */
  clone() {
    let clone = new LangfuseTracingContext({ run_target: this.run_target, config: this.config, parent_context: this });
    return clone;
  }
  /**
   * Invoke the chain with the inputs and config
   * :param chain: The chain to invoke
   * :param inputs: The inputs to the chain
   * :param runnable_config: The config for the runnable
   */
  async ainvoke(chain, inputs, runnable_config) {
    if (this.main_span != null) {
      const _resource = this.main_span;
      try {
        await super.ainvoke(chain, inputs, runnable_config);
      } finally {
        _resource.close?.();
      }
    } else {
      await super.ainvoke(chain, inputs, runnable_config);
    }
  }
  /**
   * Create the main span for the run
   * :param runnable_config: The config for the runnable
   */
  create_main_span(runnable_config) {
    if (this.main_span != null) {
      return;
    }
    if (this.langfuse_client == null) {
      return;
    }
    if (this.parent_context != null && this.parent_context.main_span != null) {
      return;
    }
    let run_name = dict.get(runnable_config, "run_name");
    this.main_span = this.langfuse_client.start_as_current_observation({ as_type: "agent", name: run_name });
  }
  /**
   * Augment the configuration however the implementation sees fit (if at all).
   * :param runnable_config: The config for the runnable
   * :return: The augmented config
   */
  augment_config(runnable_config) {
    this.create_main_span(runnable_config);
    runnable_config["neuro_san_tracing_context"] = this;
    let empty = {};
    let request_metadata = dict.get(runnable_config, "metadata", empty);
    let user_id = dict.get(request_metadata, "user_id", "<Unknown>");
    let run_name = dict.get(runnable_config, "run_name");
    this.session_id = this.get_parent_session_id();
    if (this.session_id == null) {
      let request_id = dict.get(request_metadata, "request_id", "<Unknown>");
      let hostname = gethostname();
      let now_time = datetime.now();
      let now_str = now_time.strftime("%Y-%m-%d-%H:%M:%S.%f");
      this.session_id = `${run_name}@${request_id}@${hostname}@${now_str}`;
    } else if (run_name != null) {
      let new_name = `${run_name} (agent)`;
      runnable_config["run_name"] = new_name;
    }
    request_metadata["langfuse_user_id"] = user_id;
    request_metadata["langfuse_session_id"] = this.session_id;
    runnable_config["metadata"] = request_metadata;
    return runnable_config;
  }
  /**
   * Get the parent session id.
   * We want the to be consistent for any depth of trace in the request.
   *
   * :return: The parent session id
   */
  get_parent_session_id() {
    if (this.parent_context != null) {
      return this.parent_context.get_parent_session_id();
    }
    return this.session_id;
  }
  /**
   * Flush the tracing context.
   */
  flush() {
  }
}
exposeClassAttributes(LangfuseTracingContext);
class LangChainTracingContextFactory extends ContextTypeTracingContextFactory {
  /**
   * Creates a RunTarget based on another RunTarget
   *
   * :param config: The configuration for the tracing context
   * :param run_target: The RunTarget instance to be traced
   * :return: An appropriate TracingContext
   */
  create_tracing_context(config, run_target) {
    let tracing_context = null;
    let test_for_langfuse = (process.env["LANGFUSE_ENABLED"] ?? "false").toLowerCase() == "true";
    if (test_for_langfuse) {
      tracing_context = new LangfuseTracingContext(run_target, config);
    } else {
      tracing_context = new LangChainTracingContext(run_target, config);
    }
    return tracing_context;
  }
}
exposeClassAttributes(LangChainTracingContextFactory);
class MasterTracingContextFactory {
  /**
   * Creates an appropriate ContextTypeTracingContextFactory
   *
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default llm_config
   * :param run_target: The RunTarget instance to be traced
   * :return: A ContextTypeTracingContextFactory appropriate for the context_type in the config.
   */
  static create_tracing_context_factory(config) {
    let tracing_context_factory = null;
    let context_type = MasterTracingContextFactory.get_context_type(config);
    if (context_type.startsWith("openai")) {
      tracing_context_factory = null;
    } else if (context_type.startsWith("langchain")) {
      tracing_context_factory = new LangChainTracingContextFactory();
    } else {
      tracing_context_factory = new LangChainTracingContextFactory();
    }
    return tracing_context_factory;
  }
  /**
   * :param config: The config dictionary which may or may not contain
   * keys for the context_type and default llm_config
   * :return: The context type for the config
   */
  static get_context_type(config) {
    let empty = {};
    let use_config = config;
    if (use_config == null) {
      use_config = empty;
    }
    let context_type = dict.get(use_config, "context_type");
    if (context_type == null) {
      context_type = "langchain";
    }
    let lower_context_type = context_type.toLowerCase();
    return lower_context_type;
  }
}
exposeClassAttributes(MasterTracingContextFactory);
export {
  AgentNetworkInspector,
  BaseModelDictionaryConverter,
  BaseToolFactory,
  LangChainMcpAdapter,
  LangChainOpenAIFunctionTool,
  LangChainRun,
  LangChainRunContext,
  MasterLlmFactory,
  MasterToolboxFactory,
  MasterTracingContextFactory,
  McpToolErrorHandler,
  NeuroSanRunnable,
  PydanticArgumentDictionaryConverter,
  RunContextFactory
};
