// Placeholder model name for the mock routers, which ignore the model.
export const MOCK_MODEL_NAME = "mock-1";

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

// The model an agent sends: the visitor's choice, then the agent's declared model,
// then the network's, then the fallback. The runners and the settings panel both
// use this, so the panel checks exactly what a turn would send.
export function effectiveModel(override, agentModel, networkModel, fallback) {
  return override || agentModel || networkModel || fallback;
}

// Fail closed before a real (non-mock) router gets an empty model or the mock
// placeholder. A real provider rejects both (for example with 404 model_not_found),
// so the visitor gets a setup error instead and no request is sent.
export function assertModelForRouter(model, mock, routerHost) {
  if (mock || !isPlaceholderModel(model)) return;
  throw new Error(`A model is required for ${routerHost || "the configured provider"}. `
    + "Open ⚙ BYOK / router settings, enter a model your provider supports in the Model field, "
    + "then click Apply, save & reload.");
}
