/**
 * "The set of networks on the map may have changed" — a publish, an unpublish, a
 * stop, a purge, a restart, or a launch under autopublish.
 *
 * A plain CustomEvent rather than a shared store, the same shape and for the same
 * reason as util/org.js: the views that care each own their own re-render, so there
 * is nothing to share but the fact that it happened.
 *
 * WHY IT EXISTS. Every view that lists deployments polls for itself, but on wildly
 * different cadences — the directory and the network list every 5s, the map every
 * MAP_REFRESH_SECONDS (60s by default, because /graph is heavier and a map that
 * re-laid itself every few seconds would be unreadable). Each action handler
 * reloaded only its *own* view, so publishing from the directory left the map up to
 * one minute stale. A pin that is meant to appear "the moment someone hits Launch"
 * instead looked like a publish that had not worked.
 *
 * Fired by the shared mutators in views/directory.js (`act`, `restart`) and by the
 * publish/unpublish handlers, so a new action gets this for free as long as it goes
 * through one of those. Only the map subscribes: the fast-polling views already
 * reload themselves, and subscribing them too would just double the fetch.
 */
const CHANGE_EVENT = 'nsdeploy:deployments-changed';

/** Announce that a deployment's presence on the map may have changed. */
export function deploymentsChanged() {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** @returns {() => void} unsubscribe */
export function onDeploymentsChange(handler) {
  window.addEventListener(CHANGE_EVENT, handler);
  return () => window.removeEventListener(CHANGE_EVENT, handler);
}
