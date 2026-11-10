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

// Fail closed before a real (non-mock) router gets the mock placeholder model.
// A real provider rejects it (for example with 404 model_not_found), so the
// visitor gets a setup error instead and no request is sent.
export function assertModelForRouter(model, mock, routerHost) {
  if (mock || normalizeModelName(model) !== MOCK_MODEL_NAME) return;
  throw new Error(`A model is required for ${routerHost || "the configured provider"}. `
    + "Open ⚙ BYOK / router settings, enter a model your provider supports in the Model field, "
    + "then click Apply, save & reload.");
}
