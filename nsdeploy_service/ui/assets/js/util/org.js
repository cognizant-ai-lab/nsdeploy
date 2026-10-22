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
