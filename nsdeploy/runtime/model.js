// Canonicalize model identifiers entered through URLs, profiles, or forms.
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

// Whether a model response came from nsdeploy's mock router: the site declared a mock
// router, the router labelled the route mock (X-Nsdeploy-LLM-Route), or the response
// names the mock model.
export function isMockResponse(configuredMock, routeKind, model) {
  return !!configuredMock || routeKind === "mock" || /neuro-san-mock/.test(model || "");
}
