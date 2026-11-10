/**
 * Typed-ish client for the deployment API (see API_CONTRACT.md).
 *
 * The UI talks to the backend only through these documented endpoints — no
 * server-rendered templates, no private routes. That is what keeps the option of
 * hosting this folder elsewhere (CDN, separate origin) cheap: add CORS server-side
 * and set BASE, and nothing else moves.
 */
import { auth } from './auth.js';

// Same-origin by default. A separate host would set this (and the server would
// need CORSMiddleware with an explicit origin allowlist).
export const BASE = '';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * FastAPI reports `detail` as a string for our own rejections (400/404/409) and as
 * an array of per-field objects for schema validation (422). Flatten both so a view
 * can always just show `error.message`.
 */
function detailOf(payload, fallback) {
  const detail = payload?.detail;
  if (!detail) return fallback;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        const field = (item.loc || []).slice(1).join('.');
        return field ? `${field}: ${item.msg}` : item.msg;
      })
      .join('; ');
  }
  return fallback;
}

async function request(path, { method = 'GET', body, json, allow = [], retry = true } = {}) {
  const init = { method, headers: { ...auth.headers() } };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body; // FormData sets its own multipart boundary
  }

  let response;
  try {
    response = await fetch(BASE + path, init);
  } catch (cause) {
    throw new ApiError('Cannot reach the deployment service. Is it still running?', 0, null);
  }

  if (response.status === 401 && retry && await auth.challenge()) {
    return request(path, { method, body, json, allow, retry: false });
  }

  if (response.status === 204) return { status: 204, data: null };

  const payload = await response.json().catch(() => null);
  if (!response.ok && !allow.includes(response.status)) {
    throw new ApiError(
      detailOf(payload, `${response.status} ${response.statusText}`),
      response.status,
      payload,
    );
  }
  return { status: response.status, data: payload };
}

export const api = {
  health: () => request('/health').then((r) => r.data),

  /** Masked view of the locally-configured credentials — never the real values. */
  getSettings: () => request('/settings').then((r) => r.data),
  /** Only send fields the operator actually retyped; see SettingsUpdate server-side. */
  updateSettings: (patch) =>
    request('/settings', { method: 'POST', json: patch }).then((r) => r.data),

  listOrgs: () => request('/orgs').then((r) => r.data.organizations || []),
  createOrg: (org) => request('/orgs', { method: 'POST', json: org }).then((r) => r.data),
  updateOrg: (id, patch) =>
    request(`/orgs/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }).then((r) => r.data),
  deleteOrg: (id) => request(`/orgs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Nodes + edges for the map, plus the server's recommended poll interval. */
  graph: ({ orgId = '', liveOnly = false } = {}) => {
    const params = new URLSearchParams({ live_only: liveOnly ? 'true' : 'false' });
    if (orgId) params.set('org_id', orgId);
    return request(`/graph?${params}`).then((r) => r.data);
  },

  directory: (liveOnly = false) =>
    request(`/directory?live_only=${liveOnly ? 'true' : 'false'}`).then((r) => r.data),

  /** Every deployment, flat — no org grouping. Used by the sidebar Network list. */
  list: () => request('/deployments').then((r) => r.data.deployments || []),

  deploy: (formData) =>
    request('/deployments', { method: 'POST', body: formData }).then((r) => r.data),

  get: (id) => request(`/deployments/${encodeURIComponent(id)}`).then((r) => r.data),

  /**
   * One bounded wait. A 504 is NOT a failure — it means the build is still running,
   * so the caller loops. Cold builds fetch includes from GitHub and may pip-install
   * a tool's dependencies, which is why this cannot be a single long request.
   */
  waitOnce: (id, timeout = 20) =>
    request(`/deployments/${encodeURIComponent(id)}/wait?timeout=${timeout}`, { allow: [504] }),

  logs: (id, tail = 150) =>
    request(`/deployments/${encodeURIComponent(id)}/logs?tail=${tail}`).then((r) => r.data),

  /** This deployment's own agent topology (nodes + edges) — the flow diagram. */
  agentGraph: (id) =>
    request(`/deployments/${encodeURIComponent(id)}/graph`).then((r) => r.data),

  /** Relaunch a stopped/failed deployment from its stored HOCON. Returns `202`. */
  restart: (id) =>
    request(`/deployments/${encodeURIComponent(id)}/restart`, { method: 'POST' })
      .then((r) => r.data),

  /** Edit this deployment's own theme override and relaunch it with the new
   * values — live or stopped either way. Returns `202`. */
  updateTheme: (id, patch) =>
    request(`/deployments/${encodeURIComponent(id)}/theme`, { method: 'POST', json: patch })
      .then((r) => r.data),

  /** This deployment's editable look: the current token values, the defaults to
   * offer as a reset, and whether there is a build to restyle. */
  getThemeSpec: (id) =>
    request(`/deployments/${encodeURIComponent(id)}/theme-spec`).then((r) => r.data),

  /** Restyle in place — no model call, no relaunch, nothing to poll. A deployed
   * site reads its stylesheet off disk per request, so the work is finished when
   * this resolves and the next page load serves it. */
  applyThemeSpec: (id, tokens) =>
    request(`/deployments/${encodeURIComponent(id)}/theme-spec`, { method: 'POST', json: tokens })
      .then((r) => r.data),

  /**
   * Put a tested network on the map. Deploying alone does not: a deployment is a
   * draft — live at its own URL, off the map — until this is called. Idempotent,
   * and rejected with `400` unless the deployment is ready.
   */
  publish: (id) =>
    request(`/deployments/${encodeURIComponent(id)}/publish`, { method: 'POST' })
      .then((r) => r.data),

  /** Take a network off the map. The deployment itself keeps running. */
  unpublish: (id) =>
    request(`/deployments/${encodeURIComponent(id)}/unpublish`, { method: 'POST' })
      .then((r) => r.data),

  stop: (id, purge = false) =>
    request(`/deployments/${encodeURIComponent(id)}?purge=${purge ? 'true' : 'false'}`, {
      method: 'DELETE',
    }).then((r) => r.data),
};
