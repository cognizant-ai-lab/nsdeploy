/** Bootstrap: theme, tab routing, health footer. */
import { api } from './api/client.js';
import { $, $$, esc, icon } from './util/dom.js';
import { toast } from './components/toast.js';
import { openSettings, promptForMissingCredentials } from './components/settingsModal.js';
import * as deployView from './views/deploy.js?v=120';
import * as directoryView from './views/directory.js';
// Version the Map dependency itself. Changing only main.js leaves an already-open
// browser free to reuse an older child module even though the entry module is fresh.
import * as mapView from './views/map.js?v=120';
import * as networksView from './views/networks.js?v=120';
import * as organizationsView from './views/organizations.js';

const THEME_KEY = 'nsdeploy.theme';
const NAV_KEY = 'nsdeploy.nav';
// Below this the sidebar rails itself unless the operator has chosen otherwise.
const NAV_RAIL_QUERY = '(max-width: 62rem)';
// The main path is three choices: add a network, look at the map, or see the flat
// Network list. Directory and organizations are still routable (the footer's
// "Manage deployments" link and a #directory / #organizations hash reach them)
// because they own the organization grouping — they are simply not in the sidebar.
const VIEWS = ['deploy', 'map', 'networks', 'directory', 'organizations'];

/* ── theme ──────────────────────────────────────────────────────────────── */
// An explicit choice is remembered and must beat the OS preference; with no
// choice stored we set no attribute at all so the media query governs.
function applyTheme(mode) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const dark = mode
    ? mode === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const button = $('#theme-toggle');
  if (button) {
    button.innerHTML = icon(dark ? 'sun' : 'moon', { size: 16 });
    button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || null);
  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(null);
  });
}

/* ── settings ───────────────────────────────────────────────────────────── */
function initSettings() {
  const button = $('#settings-toggle');
  if (!button) return;
  button.innerHTML = icon('gear', { size: 16 });
  button.addEventListener('click', () => openSettings());
}

/* ── sidebar rail ────────────────────────────────────────────────────────────
 * One source of truth: `html[data-nav]`. An explicit choice is remembered and
 * beats the breakpoint — the same precedence the theme toggle uses — so an
 * operator who collapses the nav on a wide screen keeps it collapsed, and one
 * who expands it on a narrow screen is not overridden on the next resize.
 *
 * Applies to every view, not just the map: the space is worth reclaiming on the
 * deploy and directory screens too.
 */
function railed(stored, narrow) {
  return stored ? stored === 'rail' : narrow;
}

function applyNav(rail) {
  document.documentElement.dataset.nav = rail ? 'rail' : 'expanded';
  const button = $('#nav-toggle');
  if (!button) return;
  const action = rail ? 'Expand navigation' : 'Collapse navigation';
  button.setAttribute('aria-expanded', String(!rail));
  button.setAttribute('aria-label', action);
  button.title = action;
  // The visible label names the action, matching the chevron direction.
  const label = button.querySelector('.navtoggle__label');
  if (label) label.textContent = rail ? 'Expand' : 'Collapse';
}

function initNav() {
  const media = window.matchMedia(NAV_RAIL_QUERY);
  const stored = () => { try { return localStorage.getItem(NAV_KEY); } catch { return null; } };

  applyNav(railed(stored(), media.matches));

  $('#nav-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.nav !== 'rail';
    try { localStorage.setItem(NAV_KEY, next ? 'rail' : 'expanded'); } catch {}
    applyNav(next);
  });

  // Only follow the viewport while no explicit choice has been stored.
  media.addEventListener('change', (event) => {
    if (!stored()) applyNav(event.matches);
  });
}

/* ── routing ────────────────────────────────────────────────────────────── */
const mounted = {};
let active = null;

function go(name) {
  if (!VIEWS.includes(name)) name = 'deploy';
  if (active === name) return;

  mounted[active]?.deactivate?.();
  active = name;

  VIEWS.forEach((view) => { $(`#view-${view}`).hidden = view !== name; });
  $$('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  });
  // Lets CSS give a view the whole window — the map drops the page footer and the
  // header tagline so the stage keeps the screen.
  document.body.dataset.view = name;

  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);

  // One load per switch. `activate` is the richer hook — a view that has one does its
  // own fetch and arms its own polling — so calling `refresh` as well fetched the
  // same data twice and, on the map, threw away the just-deployed pin's halo when the
  // second response repainted over the first.
  if (mounted[name]?.activate) mounted[name].activate();
  else mounted[name]?.refresh?.();
}

/* ── stale-console detection ────────────────────────────────────────────────
 * `Cache-Control: no-cache` on index.html only helps a *fresh* navigation. A tab
 * that was already open when the service was updated never re-navigates, so it goes
 * on running the JavaScript it booted with — and a console running last release's
 * code against this release's server looks exactly like a broken UI. (It was
 * reported as "I clicked Deploy and nothing happened", on a build where that button
 * had been renamed to Launch.)
 *
 * So: compare the version this module was loaded with against the one the server is
 * serving, and offer a reload. Once only, and never on the strength of a blank
 * value — "cannot tell" must not nag.
 */
const BOOT_UI_VERSION = new URL(import.meta.url).searchParams.get('v') || '';
let staleAnnounced = false;

function checkForUpdate(serverVersion) {
  if (staleAnnounced) return;
  if (!serverVersion || !BOOT_UI_VERSION) return;   // cannot tell — say nothing
  if (serverVersion === BOOT_UI_VERSION) return;
  staleAnnounced = true;
  const banner = $('#update-banner');
  if (!banner) return;
  banner.hidden = false;
  $('#update-reload')?.addEventListener('click', () => location.reload());
}

/* ── health footer ──────────────────────────────────────────────────────── */
// A health warning describes an ongoing condition, so every poll repeats it. Toast
// each distinct message only once per page session — otherwise the 15s poll stacks
// a new undismissable error toast for as long as the condition lasts.
const announcedWarnings = new Set();

async function refreshHealth() {
  try {
    const health = await api.health();
    checkForUpdate(health.ui_version);
    const counts = health.deployments || {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    $('#build-strong').textContent = health.build || health.version;
    const parts = [
      `${counts.ready || 0} live of ${total} record${total === 1 ? '' : 's'}`,
      `ports ${esc(health.port_pool.range)}`,
    ];
    // A startup statistic, shown in passing rather than as an alert.
    if (health.reconciled_at_startup) {
      parts.push(`${health.reconciled_at_startup} stopped by restart`);
    }
    $('#foot-health').innerHTML = parts.map((part) => `<span>${part}</span>`).join('<span>·</span>');

    (health.warnings || []).forEach((warning) => {
      if (announcedWarnings.has(warning)) return;
      announcedWarnings.add(warning);
      toast.error(warning);
    });
  } catch {
    $('#foot-health').textContent = 'service unreachable';
  }
}

/* ── boot ───────────────────────────────────────────────────────────────── */
function boot() {
  initTheme();
  initSettings();
  initNav();

  const refreshOrgDependents = () => {
    mounted.directory?.refresh?.();
    mounted.networks?.refresh?.();
    mounted.map?.refresh?.();
  };

  mounted.directory = directoryView.mount($('#view-directory'));
  mounted.networks = networksView.mount($('#view-networks'));
  mounted.map = mapView.mount($('#view-map'));
  mounted.organizations = organizationsView.mount($('#view-organizations'), {
    onChanged: refreshOrgDependents,
  });

  // Launch opens its own progress dialog and then the map in a new tab, so there is
  // no in-place navigation here — only keeping the other views current for whoever
  // comes back to this tab.
  mounted.deploy = deployView.mount($('#view-deploy'), {
    onLaunched: refreshOrgDependents,
  });

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => go(tab.dataset.view)));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));

  go(location.hash.slice(1) || 'deploy');
  refreshHealth();
  setInterval(refreshHealth, 15000);
  promptForMissingCredentials();
}

boot();
