/**
 * The organization name an operator typed once, remembered in this browser so
 * Launch, the map and the network list all pick it up without asking again.
 *
 * A plain CustomEvent rather than a shared store: the few views that care
 * (views/deploy.js, views/map.js, views/directory.js) each own their own
 * re-render, so there is nothing to subscribe to but "it changed".
 */
const ORG_KEY = 'nsdeploy.org';
const CHANGE_EVENT = 'nsdeploy:org-changed';

/**
 * The same rule the API enforces (ORG_NAME_MAX / ORG_NAME_PATTERN in models.py).
 *
 * Duplicated here on purpose, and the duplication is the lesser evil: the remembered
 * organization is written to localStorage and sent as `org_name` on the next upload,
 * so a name the browser accepts and the server refuses turns into a 422 at deploy
 * time — after the reader has chosen a file and pressed Launch, which is the worst
 * possible moment to be told their team name is invalid. Checking here fails it while
 * they are still typing it.
 *
 * Kept deliberately literal rather than fetched, because this runs before any request
 * and must work offline. If the server rule changes, this has to change with it.
 */
export const ORG_NAME_MAX = 40;
// Unicode property escapes, NOT \w. Python's \w is Unicode-aware by default, so the
// server's version of this pattern accepts "Zürich Analytics" and non-Latin names —
// but JavaScript's \w is ASCII-only even under /u, so a literal translation of the
// server regex quietly refused every accented and non-Latin team name here while the
// API accepted them. \p{L} covers letters, \p{N} digits, \p{M} the combining marks
// that decomposed accents produce.
const ORG_NAME_RE =
  /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_ &'().,\-/+#]*(?:[\p{L}\p{N}]|[).]))?$/u;

/**
 * Why a name is unacceptable, or '' when it is fine.
 *
 * Returns the reason rather than a boolean so the dialog can say which rule was
 * broken — "too long" and "has a character we cannot store" need different fixes from
 * the reader, and one generic "invalid" message leaves them guessing.
 */
export function orgNameError(name) {
  const value = String(name ?? '').trim();
  if (!value) return 'Enter your organization name to continue.';
  if (value.length > ORG_NAME_MAX) {
    return `Keep it to ${ORG_NAME_MAX} characters or fewer — that is ${value.length}.`;
  }
  if (!ORG_NAME_RE.test(value)) {
    return "Use letters, numbers, spaces and & ' ( ) . , - / + # only.";
  }
  return '';
}

export function getOrg() {
  try {
    return (localStorage.getItem(ORG_KEY) || '').trim();
  } catch {
    return ''; // private mode, or storage disabled
  }
}

export function setOrg(name) {
  const value = name.trim();
  try { localStorage.setItem(ORG_KEY, value); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
  return value;
}

/** @returns {() => void} unsubscribe */
export function onOrgChange(handler) {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
