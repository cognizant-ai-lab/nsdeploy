// Placeholder model name for the mock routers, which ignore the model. Other modules
// use fallbackModel and isPlaceholderModel instead of this name.
const MOCK_MODEL_NAME = "mock-1";

// Google's /models list names each model "models/<name>", and visitors type either form.
const MODELS_PREFIX = /^models\//;

// Canonicalize model identifiers entered through profiles or forms.
export function normalizeModelName(value) {
  let model = String(value ?? "").trim();
  while (model.length >= 2) {
    const first = model[0];
    const last = model[model.length - 1];
    if (!((first === '"' && last === '"') || (first === "'" && last === "'"))) break;
    model = model.slice(1, -1).trim();
  }
  return model;
}

// True for a model a real provider cannot use: an empty name, or the mock placeholder.
export function isPlaceholderModel(model) {
  const name = normalizeModelName(model);
  return !name || name === MOCK_MODEL_NAME;
}

/**
 * Return whether a provider's model list includes a model.
 *
 * A "models/" prefix on either side is ignored, so "gemini-3.8-flash" matches
 * Google's "models/gemini-3.8-flash".
 *
 * :param model: The model the visitor or the site chose.
 * :param availableModels: The model names the provider's /models list returned.
 * :return: True if the list includes the model.
 */
export function isPublishedModel(model, availableModels) {
  const wanted = normalizeModelName(model).replace(MODELS_PREFIX, "");
  for (const available of availableModels || []) {
    // Compare without the prefix on either side.
    if (String(available).replace(MODELS_PREFIX, "") === wanted) return true;
  }
  return false;
}

// The model an agent sends when neither the visitor nor the agent names one: the
// network's model, or else the mock placeholder.
export function fallbackModel(networkModel) {
  return networkModel || MOCK_MODEL_NAME;
}

// The model an agent sends: the visitor's choice, then the agent's declared model,
// then fallbackModel. The runners and the settings panel both use this, so the panel
// checks exactly what a turn would send.
export function effectiveModel(override, agentModel, networkModel) {
  return override || agentModel || fallbackModel(networkModel);
}

// Fail closed before a real (non-mock) router gets an empty model or the mock
// placeholder. A real provider rejects both (for example with 404 model_not_found),
// so the visitor gets a setup error instead and no request is sent.
export function assertModelForRouter(model, mock, routerHost) {
  if (mock || !isPlaceholderModel(model)) return;
  throw new Error(`A model is required for ${routerHost || "the configured provider"}. `
    + "Open ⚙ AI model settings, enter a model your provider supports in the Model field, "
    + "then select Save and start.");
}
