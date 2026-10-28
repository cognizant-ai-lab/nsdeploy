/**
 * Network map: every deployed agent network as a pin on a cartographic backdrop,
 * with the links between them drawn as arrows.
 *
 * The interaction model follows cailville/cailville.html:
 *   · hover or focus a pin  → trace its relationships (unrelated pins and edges
 *                             recede, connected ones highlight, and a callout
 *                             anchored to the pin describes the network)
 *   · click a pin           → open that agent network's site in a new tab
 *
 * Two things are done in pixel space rather than percentages, both learned from the
 * Cailville implementation:
 *   · edges are measured from each pin's bounding box and inset to its boundary, so
 *     an arrowhead lands *beside* the target pin instead of underneath it;
 *   · the edge SVG's viewBox matches the frame's pixel size, so arrowheads are not
 *     skewed by a stretched square viewBox.
 * That means edges must be redrawn on resize, not just on data change.
 *
 * Organization is deliberately not a colour channel: a spatial graph is an all-pairs
 * form, and the categorical palette only clears the colour-vision separation floors
 * for three slots under those conditions. Org identity rides on each pin's text and
 * the filter; status rides on glyph + ring, never hue alone.
 *
 * The one control the map does have: it opens showing **every** organization,
 * with a pill in the corner to scope it down to the one remembered in this
 * browser (see util/org.js). That default is the opposite of the network list's,
 * on purpose — the list is the operator's own inventory, whereas the map is the
 * shared picture of what is deployed and who it connects to, and an all-pairs
 * graph with one organization's pins removed is not a smaller map, it is a
 * misleading one: the edges to those pins vanish with them.
 *
 * `/graph` filters by org *id*, not name, so the remembered name is resolved
 * against `/orgs` before a scoped fetch (and not at all for the default one).
 */
import { api } from '../api/client.js';
import { toast } from '../components/toast.js';
import { mapArt } from '../components/mapArt.js';
import { $, esc, icon, render } from '../util/dom.js';
import {
  capabilityBullets, displayName, industryMarker, isLive, statusMeta, timestamp,
} from '../util/format.js';
import { matchingNodeIds } from '../util/listquery.js';
import { onDeploymentsChange } from '../util/deployments.js';
import { getOrg, onOrgChange } from '../util/org.js';
import { MAX_MAP_REFRESH_SECONDS, mapRefreshSeconds } from '../util/mapRefresh.js';
import { closestPairPx, scatterNodes } from '../util/scatter.js';
import {
  WHEEL_STEP, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
  centreOnPercent, clampPan, clampScale, cssFor, identity, isZoomed, panBy,
  zoomAbout, zoomByCentre, zoomPercent,
} from '../util/zoom.js';

/* ── configuration ──────────────────────────────────────────────────────────
 * Beyond the org scope above, the map has no control panel: it always shows every
 * deployment within that scope. The server may recommend a faster cadence, but the
 * console never waits longer than one minute: a restart event happens before a build
 * becomes ready, so that event alone cannot guarantee the finished pin appears.
 */
const LIVE_ONLY = false;

/**
 * Whether to draw the *inferred* relations `/graph` offers as `suggested_edges`.
 *
 * Off: the map shows only links somebody actually configured, so every line on it
 * is a fact rather than a guess. The server still computes and returns them — the
 * deterministic scorer in relations.py is cheap and the API contract is unchanged —
 * so turning this back on is this one constant and nothing else.
 *
 * Deliberately the single gate for all three places suggestions surface, which all
 * route through edgeLayers(): the arrows themselves, the "· N suggested" counter in
 * the map footer, and the "may call / may be called by" sentences plus their
 * evidence in the hover callout. Hiding the arrows alone would have left the
 * readout talking about lines that were not on the map.
 */
const SHOW_SUGGESTED_EDGES = false;

/* ── arriving from a launch ─────────────────────────────────────────────────
 * The launch dialog opens this view in a new tab with `?focus=<deployment id>`.
 * That pin is then introduced rather than left for the operator to find: it is
 * traced automatically, wears a "just deployed" halo, and the whole reason the
 * tab opened is visible without a single click.
 *
 * Read once at mount and kept, so a later poll does not silently re-trace a pin
 * the operator has since moved away from.
 */
// Most peer names the hover readout will spell out before switching to "+N more".
const RELATION_NAME_CAP = 4;
const FOCUS_PARAM = 'focus';
// How long the halo stays on the pin the tab was opened for.
// Long, because this is the one pin the reader came to see. Nine seconds was the old
// value and it was not enough at event scale: the tab opens, the map paints a hundred
// markers, the reader looks at the toast, and by the time they start scanning the city
// the halo they were meant to follow has already gone out. It now outlasts a
// distracted glance, and is dismissed by acknowledgement rather than only by the clock
// — see acknowledgeFocus().
const FOCUS_HALO_MS = 90000;

let timer = null;
let mapActive = false;
let resizeObserver = null;
let focusTimer = null;
let refreshSeconds = MAX_MAP_REFRESH_SECONDS;
let lastFetch = null;
let graphData = { nodes: [], edges: [], organizations: [], totals: {} };
// The nodes exactly as /graph returned them, before any scatter. The scattered
// coordinates are a function of these plus the stage's pixel size, so the inputs have
// to survive in order to recompute them when the stage changes size.
let graphRaw = [];
// The marker footprint the current positions were computed against. Starts at 0
// because nothing has been rendered to measure yet, which is exactly what makes the
// first correction fire.
let scatterMarker = 0;
// Deployment id this tab was opened to show, whether it has been announced, and when
// its halo stops being true. Announcing and haloing are tracked separately because
// they have different lifetimes: the announcement happens once, but the halo has to
// be re-applied after every repaint, since paint() replaces the pin elements.
let focusId = '';
let focusAnnounced = false;
let focusExpiresAt = 0;
// Whether the map is scoped to the remembered organization right now, and the
// name→id lookups already done so switching back and forth doesn't re-hit
// /orgs every time. Cleared whenever the remembered organization changes.
//
// Starts false: the map shows every organization's networks until someone asks
// for less.
let scopeToOrg = false;
let orgIdCache = new Map();

// The reader's current pan/zoom. Module state, like the scope above, so a background
// poll does not throw away the frame they are looking at — paint() replaces the pins'
// markup on every poll, and a view held in the DOM would reset with it.
let view = identity();

// The map's own search box. Module state for the same reason as the view: paint()
// replaces every pin on each poll, so anything held only in the DOM is lost.
let mapQuery = '';

// The remembered organization, resolved once per paint so pin() does not read
// localStorage a hundred times.
let myOrg = '';

// Populate a large map in small groups so the browser can paint useful markers
// immediately instead of waiting for one long DOM/layout turn to finish. Normal
// polling remains synchronous because it typically changes zero or one marker.
const INITIAL_PIN_BATCH_SIZE = 12;
const INITIAL_PIN_BATCH_GAP_MS = 55;
let pinBatchTimer = null;
let pinBatchVersion = 0;

function cancelPinBatches() {
  pinBatchVersion += 1;
  clearTimeout(pinBatchTimer);
  pinBatchTimer = null;
}

export function mount(root) {
  render(root, template());
  try {
    focusId = new URLSearchParams(location.search).get(FOCUS_PARAM) || '';
  } catch { focusId = ''; }

  // The city before the data. paint() used to draw the artwork on its first run, which
  // meant the stage stayed completely blank for the whole of the opening /graph — on a
  // 100-network map that was seconds of empty panel, indistinguishable from a view
  // that had failed to load. The artwork needs nothing from the server, so it goes up
  // immediately and the pins arrive onto a map that is already there.
  const art = $('#map-art', root);
  if (art && !art.firstChild) art.innerHTML = mapArt();

  syncScopeControl(root);
  $('#map-scope', root).addEventListener('click', () => {
    scopeToOrg = !scopeToOrg;
    syncScopeControl(root);
    load(root);
  });
  onOrgChange(() => {
    orgIdCache = new Map();
    syncScopeControl(root);
    load(root);
  });

  // Publishing happens in the directory, not here, and /graph is polled on a slower
  // timer than the lists — so without this a new pin could be up to a minute late,
  // which reads as the publish having failed.
  // Quiet: this is a background refresh, and an error here must not raise a toast
  // over whatever view the operator is actually looking at. Not unsubscribed in
  // deactivate() on purpose — the map stays mounted and must still be current when
  // it is next shown, and activate() re-fetching is a cheap duplicate rather than a
  // reason to go stale in between.
  onDeploymentsChange(() => load(root, { quiet: true }));

  // Browsers deliberately throttle timers in background tabs. When this console is
  // visible again, do not wait for a delayed timeout to catch up: fetch immediately
  // and start a fresh one-minute countdown from the visible state.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && mapActive) {
      load(root, { quiet: true });
      schedule(root);
    }
  });

  // Edge geometry is measured in pixels, so it has to follow the frame's size. The
  // callout is positioned from measured geometry too, so its inline coordinates go
  // stale on resize — drop the trace rather than leave it pointing at nothing.
  //
  // But only on a *real* resize. ResizeObserver always fires once when it starts
  // observing, and it can fire again while layout settles at the same size; treating
  // those as resizes cleared the trace immediately after it was applied, which is
  // what stopped a freshly deployed pin from staying traced on arrival.
  const stage = $('#map-stage', root);
  let lastSize = '';
  const reflow = () => {
    const box = stage.getBoundingClientRect();
    // A frame that grew can leave the pan past its new bound — the scene would sit
    // short of an edge with background showing beside it. Re-clamp against the
    // current size before anything is measured from it.
    view = { scale: view.scale, ...clampPan(view.tx, view.ty, view.scale, box.width, box.height) };
    // applyView re-decides which side each balloon stands on (the stage's height just
    // changed) and re-measures the edges from the moved boxes.
    const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
    const resized = lastSize && size !== lastSize;
    if (resized && graphRaw.length) {
      // Whether two markers overlap is a pixel question, so a resize can change the
      // answer: a layout that was clear on a wide monitor collides when the window is
      // narrowed. Re-derived from the untouched server positions, then repainted —
      // reconcilePins moves only the markers whose coordinates actually changed, and
      // the ids are unchanged so nothing animates in as though it were new.
      graphData = { ...graphData, nodes: scatterNodes(graphRaw, stageSize(root)) };
      paint(root, graphData);
    }
    applyView(root);
    if (resized) clearTrace(root);
    lastSize = size;
  };
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(reflow);
    resizeObserver.observe(stage);
  } else {
    window.addEventListener('resize', reflow);
  }

  wireFullscreen(root);
  wireZoom(root);
  wireFind(root);
  // Publish the starting view, so --unzoom has a value before the first pins land.
  applyView(root);

  return {
    refresh: () => load(root),

    activate() {
      mapActive = true;
      load(root);
      schedule(root);
    },

    deactivate() {
      mapActive = false;
      clearTimeout(timer);
      clearTimeout(focusTimer);
      cancelPinBatches();
      timer = null;
      focusTimer = null;
      // Stop the countdown with the poll it was counting down to. Left running, it
      // would keep sweeping on a hidden view and be mid-fill — implying a poll that
      // is not scheduled — on the next activate().
      tick(root, 'off');
      // A frame queued by a gesture just before the view was left would otherwise
      // measure a stage that is no longer displayed.
      if (geometryFrame) cancelAnimationFrame(geometryFrame);
      geometryFrame = 0;
      // Leaving the view while full screen would strand the whole app there.
      if (document.fullscreenElement === $('#map-shell', root)) document.exitFullscreen?.();
    },
  };
}

/* ── introducing the pin this tab was opened for ────────────────────────── */
/**
 * Show off the network that was just deployed.
 *
 * Called after every paint, not once. The announcement is one-shot, but the halo has
 * to be re-applied each time, because paint() replaces the pins' markup — a repaint
 * (a background poll, or a second load) otherwise silently threw the halo away and a
 * one-shot guard meant it never came back.
 *
 * The tab can also open a moment before /graph reports the new pin, so this waits for
 * the pin to exist rather than announcing something that is not on screen.
 *
 * The halo expires on its own: it means "this is the one you just made", which stops
 * being true, and a permanent decoration on one pin would read as a status the others
 * lack.
 */
function introduceFocus(root) {
  if (!focusId) return;
  const element = root.querySelector(`[data-pin="${CSS.escape(focusId)}"]`);
  if (!element) return;

  if (!focusAnnounced) {
    focusAnnounced = true;
    focusExpiresAt = Date.now() + FOCUS_HALO_MS;
    const node = nodeById(focusId);
    if (node) toast.ok(`${displayName(node.name)} is on the map.`);
    // Bring it into the frame if the reader is zoomed somewhere else. Announcing "your
    // network is on the map" and haloing a pin that is outside the viewport is worse
    // than saying nothing — the halo expires unseen and the toast looks like a lie.
    // Only when zoomed: at the fitted view every pin is already visible, and moving
    // the map then would be motion with no purpose.
    if (node && isZoomed(view)) {
      const { width, height } = stageSize(root);
      setView(root, centreOnPercent(view, node.x, node.y, width, height));
    }
    // Trace it so its links are already explained, exactly as a hover would.
    trace(root, focusId);
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      // Re-query: the element captured above may have been replaced by a repaint.
      const current = root.querySelector(`[data-pin="${CSS.escape(focusId)}"]`);
      current?.classList.remove('is-new');
      // Only drop the trace if the operator has not started exploring elsewhere.
      if (current && $('#map-stage', root)?.querySelector('.mappin.is-origin') === current) {
        clearTrace(root);
      }
    }, FOCUS_HALO_MS);
  }

  if (Date.now() < focusExpiresAt) element.classList.add('is-new');
}

/**
 * Stop announcing the new pin once the reader has clearly found it.
 *
 * The halo means "this is the one you just made", which stops being worth saying the
 * moment they hover or open it — and a marker left pulsing after that reads as a
 * status the other networks lack, which is the reason it was time-limited in the first
 * place. Acknowledgement is the better signal than the clock: it ends exactly when it
 * has done its job, and the long timeout is only the fallback for a reader who never
 * looks.
 */
function acknowledgeFocus(root, id) {
  if (!focusId || id !== focusId) return;
  focusExpiresAt = 0;
  clearTimeout(focusTimer);
  focusTimer = null;
  root.querySelector(`[data-pin="${CSS.escape(focusId)}"]`)?.classList.remove('is-new');
  focusId = '';
}

/* ── full screen ────────────────────────────────────────────────────────────
 * The shell, not the stage: the legend, counters and detail callout are children
 * of the stage's parent, and full-screening the stage alone would leave them
 * behind in the normal document where nothing is visible.
 */
function wireFullscreen(root) {
  const shell = $('#map-shell', root);
  const button = $('#map-fullscreen', root);
  if (!shell || !button || !shell.requestFullscreen) {
    // Not supported (or an iframe without allowfullscreen) — say so rather than
    // offering a button that silently does nothing.
    if (button) button.hidden = true;
    return;
  }

  button.addEventListener('click', () => {
    if (document.fullscreenElement === shell) document.exitFullscreen?.();
    else shell.requestFullscreen().catch(() => { button.hidden = true; });
  });

  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === shell;
    const action = active ? 'Exit full screen' : 'Show the map full screen';
    button.setAttribute('aria-label', action);
    button.title = active ? 'Exit full screen' : 'Full screen';
    shell.classList.toggle('is-fullscreen', active);
    // The stage's ResizeObserver redraws the edges; the callout's coordinates are
    // measured, so drop the trace rather than leave it pointing at a stale spot.
    clearTrace(root);
  });
}

/* ── zoom and pan ─────────────────────────────────────────────────────────
 * The arithmetic lives in util/zoom.js; this is the wiring.
 *
 * Markers hold their on-screen size while the ground scales under them (--unzoom),
 * because magnifying markers along with the city would leave the crowding exactly as
 * it was — see the note in util/zoom.js. Zooming in therefore buys real separation,
 * which is the only thing that makes ~100 pins legible in one frame.
 *
 * Every gesture goes through applyView(), so the balloon side-flipping and the edge
 * geometry are re-measured from the moved boxes exactly once per change.
 */
/**
 * Zoom is only offered when there is a map to zoom.
 *
 * An empty stage has nothing to magnify, and the empty-state message lives inside the
 * scene without a counter-scale — so zooming one produced a giant "No networks here
 * yet" sliding around behind the controls. The view is also returned to fitted, or a
 * reader who zoomed in and then scoped to an organization with no networks would be
 * left panned into a corner of blank ground.
 */
/* ── find a network among a hundred ───────────────────────────────────────── */
/**
 * Dim everything that does not match, rather than removing it.
 *
 * Hiding non-matches would turn the map into a list with scenery: a lone pin on an
 * empty city says nothing about where it sits or who it sits near. Dimming keeps the
 * answer in context, which is the only reason to look at a map instead of the
 * directory.
 *
 * Re-applied after every paint because paint() rebuilds the pins' markup, so a class
 * set here is thrown away on each poll — the same reason the zoom view is module state.
 */
function applySearch(root) {
  const stage = $('#map-stage', root);
  if (!stage) return;
  const hits = matchingNodeIds(graphData.nodes, mapQuery);
  stage.classList.toggle('is-searching', hits !== null);

  stage.querySelectorAll('.mappin').forEach((element) => {
    const match = hits === null || hits.has(element.dataset.pin);
    element.classList.toggle('mappin--hit', hits !== null && match);
    element.classList.toggle('mappin--miss', hits !== null && !match);
  });

  const readout = $('#map-find-count', root);
  if (readout) {
    readout.textContent = hits === null
      ? ''
      : `${hits.size} of ${graphData.nodes.length}`;
    readout.classList.toggle('mapfind__count--none', hits !== null && hits.size === 0);
  }
  return hits;
}

/**
 * Move the map to the search result when there is exactly one.
 *
 * Only on one hit, and only while zoomed: jumping the frame around on every keystroke
 * would be motion the reader did not ask for, and at the fitted view the pin is already
 * on screen, so there is nothing to travel to.
 */
function revealSingleHit(root) {
  const hits = matchingNodeIds(graphData.nodes, mapQuery);
  if (!hits || hits.size !== 1 || !isZoomed(view)) return;
  const node = graphData.nodes.find((n) => hits.has(n.id));
  if (!node) return;
  const { width, height } = stageSize(root);
  setView(root, centreOnPercent(view, node.x, node.y, width, height));
}

/**
 * Run the search the reader has typed, or clear it.
 *
 * COMMITTED, NOT LIVE. Searching per keystroke was wrong here in a way that is not
 * obvious until you watch it: a subject query passes through states that are not
 * merely incomplete but wrong. "ban" matches no industry, "bank" matches finance,
 * "banki" matches none again — so the map flashed through three different answers on
 * the way to one question, and the reader saw pins dim and undim under their hands.
 * Nothing is applied until Enter or Go.
 */
function runSearch(root, raw) {
  mapQuery = String(raw ?? '');
  applySearch(root);
  // Not just drawEdges: searching hides the name chips, which changes how much room a
  // balloon needs above its pin, so the sides have to be re-decided too. settlePins
  // reads the chip's *computed* display, so it picks this up without knowing why the
  // chip is hidden. scheduleGeometry runs both, once, on the next frame.
  scheduleGeometry(root);
  syncFindControls(root);
  revealSingleHit(root);
}

/** The clear button only exists while there is something to clear. */
function syncFindControls(root) {
  const input = $('#map-search', root);
  const clear = $('#map-find-clear', root);
  if (!input || !clear) return;
  clear.hidden = !input.value && !mapQuery;
  // Tells the reader the box is holding an unrun query, which is the cost of
  // committing on submit rather than live.
  $('#map-find', root)?.classList.toggle('is-dirty', input.value.trim() !== mapQuery.trim());
}

function wireFind(root) {
  const form = $('#map-find', root);
  const input = $('#map-search', root);
  const clear = $('#map-find-clear', root);
  if (!form || !input) return;

  // One submit path covers both Enter and the Go button, so they cannot drift apart.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    runSearch(root, input.value);
  });

  // No search on input, with one exception: emptying the box restores the whole map
  // at once.
  //
  // That is not a hole in the commit-on-submit rule, it is the rule applied honestly.
  // Deferring exists because a half-typed subject gives a *wrong* answer — "ban"
  // matches no industry, "bank" matches finance — so the map should not chase a query
  // mid-thought. An empty box is not a half-typed query; it is a complete and
  // unambiguous "show everything", and making the reader press Enter to be told
  // nothing was filtered is a step with no question behind it. It also matched the
  // clear button's behaviour already, so backspacing to empty and clicking x were
  // doing two different things for no reason the reader could see.
  input.addEventListener('input', () => {
    if (!input.value.trim() && mapQuery) runSearch(root, '');
    else syncFindControls(root);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    // First Escape drops an unrun draft; a second clears the applied search. Clearing
    // both at once would throw away a result the reader may have meant to keep while
    // they retyped.
    if (input.value.trim() !== mapQuery.trim()) input.value = mapQuery;
    else { input.value = ''; runSearch(root, ''); }
    syncFindControls(root);
  });

  clear?.addEventListener('click', () => {
    input.value = '';
    runSearch(root, '');
    input.focus();
  });
}

function syncZoomAvailability(root) {
  const controls = $('#map-zoom', root);
  if (!controls) return;
  const empty = graphData.nodes.length === 0;
  controls.hidden = empty;
  if (empty && isZoomed(view)) setView(root, identity());
}

/**
 * How much detail each marker shows, from how crowded the map *appears*.
 *
 * Both terms matter. A handful of networks carries its names outright; a hundred does
 * not, because the chips become a wall of text over the city. But the same hundred at
 * 3x have nine times the ground between them and can carry them again — so the labels
 * return as the reader zooms in, and the threshold is about what is on screen rather
 * than what the API returned.
 *
 * This was briefly count-only, which left zoom unable to reveal a name at all: the
 * reader could see there was room and the map would not use it. The complaint that
 * prompted that change was really about labels appearing *unasked* while panning, and
 * the answer to it is the threshold, not dropping the zoom term.
 *
 * Called from paint() (the count changed) and applyView() (the zoom changed).
 */
function setDensity(root) {
  const stage = $('#map-stage', root);
  if (!stage) return;
  // Scale divides as an area: the markers hold their on-screen size while the ground
  // grows in both axes, so at scale k a pin has k² times the room around it.
  const scale = Math.max(ZOOM_MIN, Number(view?.scale) || ZOOM_MIN);
  const effective = graphData.nodes.length / (scale * scale);
  stage.dataset.density = effective > 44 ? 'tight' : effective > 22 ? 'compact' : 'roomy';
  stage.dataset.layout = usesFullLand() ? 'full-land' : 'coastal';
}

/**
 * Re-measure the parts of the stage whose geometry depends on the view.
 *
 * COALESCED, and that is not an optimisation — it is what makes zoom usable at event
 * scale. settlePins reads offsetHeight for every pin and drawEdges reads a rect for
 * every pin and rebuilds every path. At 100 pins and 146 edges that is a few hundred
 * measurements. A drag emits pointermove faster than the screen refreshes, so doing
 * this per event meant several full passes per frame — the same cost the two-pass
 * split in settlePins was written to remove, reintroduced one layer up. One pass per
 * animation frame is the most that can ever be shown.
 */
let geometryFrame = 0;
function scheduleGeometry(root) {
  if (geometryFrame) return;
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = 0;
    // The density class decides whether a chip is displayed, and a displayed chip
    // changes the height a balloon needs above its pin — so it is set before
    // settlePins measures, and settlePins runs before drawEdges measures the boxes it
    // may just have flipped.
    setDensity(root);
    settlePins(root);
    drawEdges(root);
  });
}

/**
 * Publish the current view.
 *
 * `geometry: false` writes only the transform and the chrome, which is everything a
 * *pan* needs: the pins and the edges are both inside the scene, so panning moves them
 * together and their relative geometry does not change. Only which side a balloon can
 * stand on does, and that can wait until the drag ends rather than being recomputed
 * under the reader's cursor.
 */
function applyView(root, { geometry = true } = {}) {
  const scene = $('#map-scene', root);
  const stage = $('#map-stage', root);
  if (!scene || !stage) return;

  const css = cssFor(view);
  scene.style.transform = css.transform;
  // Set on the stage rather than the scene so the floating chrome can read it too,
  // and so a marker inherits it wherever it sits in the tree.
  stage.style.setProperty('--unzoom', css.unzoom);
  stage.classList.toggle('is-zoomed', isZoomed(view));

  const readout = $('#map-zoom-level', root);
  if (readout) readout.textContent = zoomPercent(view);
  const out = root.querySelector('[data-zoom="out"]');
  const into = root.querySelector('[data-zoom="in"]');
  if (out) out.disabled = view.scale <= ZOOM_MIN + 1e-6;
  if (into) into.disabled = view.scale >= ZOOM_MAX - 1e-6;

  if (geometry) scheduleGeometry(root);
}

function setView(root, next, options) {
  view = next;
  applyView(root, options);
}

function stageSize(root) {
  const stage = $('#map-stage', root);
  const box = stage.getBoundingClientRect();
  const marker = markerFootprint(root);
  const topInset = box.height
    ? ((topObstruction(root) + marker / 2) / box.height) * 100
    : 7;
  const fullLand = usesFullLand();
  stage.dataset.layout = fullLand ? 'full-land' : 'coastal';
  return { width: box.width, height: box.height, marker, topInset, fullLand };
}

/** Crowded event maps automatically reclaim the coast; admins can opt in earlier. */
function usesFullLand() {
  const preset = window.NSDEPLOY_ADMIN_CONFIG?.map?.preset;
  return (graphRaw.length >= 80 && graphRaw.length <= 100) || preset === 'full-land';
}

/**
 * The rendered footprint of one marker, in on-screen pixels.
 *
 * MEASURED, NOT CALCULATED. Three attempts at deriving this from the stylesheet were
 * each wrong by enough to leave markers overlapping — the marker used to be rotated 45
 * degrees (inflating its bounding box by the square root of two), carried a badge
 * positioned outside that box, and is counter-scaled by --unzoom and --pin-scale.
 * getBoundingClientRect accounts for all of that, so asking the browser is both
 * shorter and correct. The marker is a plain disc now and the badge is gone, which
 * makes the sums easy again — but they are still not done here, because the next
 * change to the stylesheet would quietly invalidate them.
 *
 * The badge union is kept for the same reason: if anything is ever positioned outside
 * the disc again, this keeps measuring the truth rather than the intention.
 *
 * Returns 0 before any pin exists, which makes the caller fall back to its own
 * conservative constant rather than to zero separation.
 */
function markerFootprint(root) {
  const drop = root.querySelector('.mappin .mappin__drop');
  if (!drop) return 0;
  const box = drop.getBoundingClientRect();
  if (!box.width) return 0;
  let { left, top, right, bottom } = box;
  const badge = drop.querySelector('.mappin__badge');
  if (badge) {
    const b = badge.getBoundingClientRect();
    if (b.width) {
      left = Math.min(left, b.left); top = Math.min(top, b.top);
      right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom);
    }
  }
  // The longest side, so the requirement holds whichever way two markers approach.
  return Math.max(right - left, bottom - top);
}

function wireZoom(root) {
  const stage = $('#map-stage', root);
  const controls = $('#map-zoom', root);
  if (!stage || !controls) return;

  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-zoom]');
    if (!button) return;
    const { width, height } = stageSize(root);
    if (button.dataset.zoom === 'reset') setView(root, identity());
    else {
      const factor = button.dataset.zoom === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView(root, zoomByCentre(view, factor, width, height));
    }
    // A zoom moves the ground out from under the callout's measured position.
    clearTrace(root);
  });

  // Wheel zooms about the cursor, which is what every map does. passive:false because
  // the page would otherwise scroll instead — but only claimed while the pointer is
  // over the stage, so the rest of the page scrolls normally.
  stage.addEventListener('wheel', (event) => {
    // Nothing to magnify on an empty stage, and claiming the gesture there would stop
    // the page scrolling for no benefit. Matches syncZoomAvailability hiding the
    // buttons, so the wheel and the controls agree on when zoom exists.
    if (!graphData.nodes.length) return;
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
    setView(root, zoomAbout(view, view.scale * factor,
      event.clientX - box.left, event.clientY - box.top, box.width, box.height));
    clearTrace(root);
  }, { passive: false });

  // Drag to pan, but only once there is somewhere to pan to. Pointer events rather
  // than mouse events so a touch drag works the same way.
  let dragging = null;
  stage.addEventListener('pointerdown', (event) => {
    // Never steal a click from a pin or a control — a marker is a link.
    if (event.button !== 0 || !isZoomed(view)) return;
    // .mapfind covers the whole bar, including the org chip, the input, clear and Go.
    // Without it a pointerdown in the search box started a map drag, which stole the
    // caret and made selecting the text you had just typed impossible while zoomed.
    if (event.target.closest('.mappin, .mapzoom, .mapfs, .mapfind')) return;
    // Measure the frame once at the start: reading it per pointermove forces a layout
    // on every event, which is the cost this whole path exists to avoid.
    const { width, height } = stageSize(root);
    dragging = { x: event.clientX, y: event.clientY, moved: false, width, height };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('is-grabbing');
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (!dragging.moved && Math.hypot(dx, dy) < 3) return;  // a click, not a drag
    dragging.moved = true;
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    // Transform only while the drag is live. Everything inside the scene moves with
    // it, so nothing needs re-measuring until the reader lets go.
    setView(root, panBy(view, dx, dy, dragging.width, dragging.height),
      { geometry: false });
  });

  const endDrag = (event) => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    stage.classList.remove('is-grabbing');
    // The geometry skipped during the drag, settled once now that it has stopped.
    if (moved) scheduleGeometry(root);
    if (event?.pointerId !== undefined && stage.hasPointerCapture?.(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
    clearTrace(root);
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // Keyboard, so zoom is not a pointer-only feature. Listening on the stage means the
  // shortcuts work whenever focus is anywhere inside the map.
  stage.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Never steal a keystroke from a field. The search bar lives inside the stage, so
    // without this the zoom shortcuts ate characters out of it: typing
    // "retail_oms_004" zoomed out on the underscore and reset the view on every zero,
    // and the digits never reached the box. An earlier version of this comment claimed
    // the search box was "elsewhere" — it was, until the bar was added here.
    const target = event.target;
    if (target instanceof HTMLElement
        && (target.closest('input, textarea, select') || target.isContentEditable)) return;
    const { width, height } = stageSize(root);
    if (event.key === '+' || event.key === '=') {
      setView(root, zoomByCentre(view, ZOOM_STEP, width, height));
    } else if (event.key === '-' || event.key === '_') {
      setView(root, zoomByCentre(view, 1 / ZOOM_STEP, width, height));
    } else if (event.key === '0') {
      setView(root, identity());
    } else {
      return;
    }
    event.preventDefault();
    clearTrace(root);
  });
}

/* ── refresh cadence ──────────────────────────────────────────────────────
 * Start immediately on view activation, then poll at least once per minute. The
 * server can ask for a faster refresh, but never a slower one: a network may still be
 * building when the start/restart event causes its immediate fetch, and the periodic
 * pass is what guarantees the ready network subsequently appears.
 */
/**
 * Drive the refresh bar.
 *
 * Two states, because they answer two different questions. `is-busy` means a request
 * is open right now — that is the one a reader checks when they are waiting for their
 * own network to appear. The fill is a countdown to the next poll, which is what makes
 * a quiet map legible as "checked a moment ago" rather than "possibly stale".
 *
 * The animation is restarted by removing and re-adding the class with a reflow between
 * — assigning the same animation name again is a no-op otherwise, so the bar would
 * fill once and then sit full for the rest of the session.
 */
function tick(root, state) {
  const bar = $('#map-tick', root);
  const fill = $('#map-tick-fill', root);
  if (!bar || !fill) return;
  if (state === 'busy') { bar.classList.add('is-busy'); return; }
  bar.classList.remove('is-busy');
  if (!refreshSeconds || !mapActive) { bar.classList.remove('is-counting'); return; }
  bar.classList.remove('is-counting');
  void bar.offsetWidth;                                   // reflow: restart the fill
  fill.style.animationDuration = `${refreshSeconds}s`;
  bar.classList.add('is-counting');
}

function schedule(root) {
  clearTimeout(timer);
  timer = null;
  if (!mapActive) return;

  // A self-rearming timeout is easier to reason about than a free-running interval:
  // there is exactly one scheduled poll, it cannot survive deactivate(), and every
  // completed tick visibly arms the next one. Re-arm even after a failed request so
  // one temporary network error cannot permanently stop automatic refresh.
  timer = setTimeout(async () => {
    timer = null;
    if (!mapActive) return;
    await load(root, { quiet: true });
    schedule(root);
  }, refreshSeconds * 1000);
}

function announce(root) {
  const cadence = refreshSeconds > 0
    ? `refresh every ${refreshSeconds < 60
        ? `${refreshSeconds}s` : `${Math.round(refreshSeconds / 60)} min`}`
    : 'auto-refresh off';
  const totals = graphData.totals || {};
  const count = (value, word) => `${value ?? 0} ${word}${(value ?? 0) === 1 ? '' : 's'}`;
  const suggestions = edgeLayers().suggested.length;
  $('#map-meta', root).textContent = [
    `${count(totals.nodes, 'network')} · ${totals.ready ?? 0} live · ${count(totals.edges, 'link')}`
      + (suggestions ? ` · ${suggestions} suggested` : ''),
    cadence,
    lastFetch ? timestamp(lastFetch) : '',
  ].filter(Boolean).join('  ·  ');
}

/* ── markup ─────────────────────────────────────────────────────────────── */
function template() {
  // No control panel: the stage is the whole view. The legend, counters and the
  // hover readout float over the map, so nothing permanent competes with it.
  return `
  <div class="mapshell" id="map-shell">
    <div class="mapstage" id="map-stage">
      <!-- Everything that belongs to the ground goes in one scene, so zooming moves
           the artwork, the edges and the pins together. The floating chrome below
           (readout, controls, legend, counters) is deliberately outside it: those are
           screen furniture and must not scale or pan with the map. -->
      <div class="mapscene" id="map-scene">
        <div class="mapart__holder" id="map-art"></div>
        <svg class="mapedges" id="map-edges" aria-hidden="true">
          <!-- markerUnits="userSpaceOnUse" so the arrowheads can be held at a constant
               on-screen size, which sizeMarkers() does on every view change. The
               default is "strokeWidth": the head is then sized in user space and the
               scene's transform magnifies it, so at 4x the lines stayed hairline (they
               are non-scaling-stroke) while the heads grew into blobs that buried the
               pin they were pointing at. refX/refY are in viewBox units and so need no
               adjustment; only the width and height do. -->
          <defs>
            <marker id="map-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                    markerUnits="userSpaceOnUse"
                    markerWidth="9" markerHeight="9" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
            <!-- A separate marker so a suggested arrowhead can be dimmed on its own; a
                 marker inherits nothing from the path that references it. -->
            <marker id="map-arrow-suggested" viewBox="0 0 10 10" refX="8" refY="5"
                    markerUnits="userSpaceOnUse"
                    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          <g id="map-edge-paths"></g>
        </svg>
        <div class="mappins" id="map-pins"></div>
      </div>

      <!-- Appears only while a pin is hovered or focused; there is no idle panel.
           Positioned against its pin at hover time by positionDetail(). -->
      <div class="mapdetail" id="map-detail" role="status" aria-live="polite" hidden></div>

      <!-- A real control, so unlike the legend and counters it must accept pointer
           events. The map view already gives up the footer and tagline for height;
           this hands over the browser chrome as well. -->
      <button class="mapfs" id="map-fullscreen" type="button"
              aria-label="Show the map full screen" title="Full screen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path class="mapfs__enter" d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/>
          <path class="mapfs__exit" d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/>
        </svg>
      </button>

      <!-- Find a network among a hundred. One bar across the top, rather than the
           scattered chrome this replaced. The compact All/Mine control inside the
           field scopes the map without putting an organization name beside the query.
           Searching dims non-matches instead of hiding them, so the reader keeps the
           context of where their network sits relative to everyone else's — which is
           the whole point of looking at a map rather than the directory.
           Outside the scene, so it neither pans nor scales with the city. -->
      <form class="mapfind" id="map-find" role="search">
        <div class="mapfind__box">
          <span class="mapfind__icon" aria-hidden="true">${icon('search')}</span>
          <input class="input input--bare mapfind__input" id="map-search" type="text"
                 placeholder="Find a network"
                 autocomplete="off" spellcheck="false"
                 aria-label="Find a network on the map, by name or by subject">
          <!-- Only while there is something to clear, so the bar is not carrying a
               dead control on an untouched map. -->
          <button class="mapfind__clear" id="map-find-clear" type="button" hidden
                  aria-label="Clear the search" title="Clear (Esc)">${icon('close')}</button>
          <!-- Search scope belongs inside the field, not beside it. A stable All/Mine
               label cannot be mistaken for a selected network; the remembered
               organization name remains in the title and accessible label. -->
          <button class="mapscope" id="map-scope" type="button" hidden></button>
        </div>

        <!-- Submit, not a click handler: Enter in the input and this button are then
             the same action by construction rather than by two code paths that have to
             be kept in step. -->
        <button class="mapfind__go" id="map-find-go" type="submit"
                aria-label="Search the map" title="Search (Enter)">${icon('arrowRight')}</button>

        <span class="mapfind__count" id="map-find-count" role="status" aria-live="polite"></span>
      </form>

      <!-- Zoom. At event scale the map carries ~100 markers, and no amount of
           placement makes that many legible at once; separating them is what the
           reader needs, so the stage magnifies rather than the markers shrinking
           further. Buttons as well as wheel and drag, because a trackpad pinch and a
           scroll wheel are not available to everyone and neither is reachable by
           keyboard. The level is announced so it is not a purely visual state. -->
      <div class="mapzoom" id="map-zoom">
        <button class="mapzoom__btn" data-zoom="in" type="button"
                aria-label="Zoom in" title="Zoom in (+)">${icon('plus')}</button>
        <button class="mapzoom__btn" data-zoom="out" type="button"
                aria-label="Zoom out" title="Zoom out (−)">${icon('minus')}</button>
        <button class="mapzoom__btn mapzoom__btn--reset" data-zoom="reset" type="button"
                aria-label="Reset zoom to fit the whole map"
                title="Fit the whole map (0)">${icon('frame')}</button>
        <span class="mapzoom__level" id="map-zoom-level" role="status"
              aria-live="polite">100%</span>
      </div>

      <div class="maplegend maplegend--float">
        <span><span class="legend-ring legend-ring--ready"></span>ready</span>
        <span><span class="legend-ring legend-ring--pending"></span>building</span>
        <span><span class="legend-ring legend-ring--inert"></span>stopped</span>
        <span title="A configured link: this network can call that one.">
          <span class="legend-edge"></span>caller → callee</span>
        ${SHOW_SUGGESTED_EDGES ? `
        <!-- The "inferred, not configured" caveat lives here, stated once, rather than
             in the hover readout where it was repeated on every pin. -->
        <span title="Inferred from the two networks' descriptions — a suggestion, not a configured link.">
          <span class="legend-edge legend-edge--suggested"></span>suggested</span>` : ''}
      </div>
      <span class="mapmeta" id="map-meta"></span>

      <!-- When the next poll lands, and when one is in flight. The map updates itself
           without being asked, which is a problem of its own: a reader who cannot see
           that it refreshes has no way to tell "nothing has changed" from "this is
           stale", and the honest answer to "is my network there yet?" was previously
           only in the text readout. The bar fills across the refresh interval and
           pulses while the request is open.

           aria-hidden: the cadence is already announced in #map-meta, and a bar that
           re-announced itself twice a minute would be noise in a screen reader. -->
      <div class="maptick" id="map-tick" aria-hidden="true">
        <div class="maptick__fill" id="map-tick-fill"></div>
      </div>
    </div>
  </div>`;
}

/* ── organization scope ─────────────────────────────────────────────────── */
/**
 * `/graph` filters by org id, so the remembered name has to be resolved first.
 * A name an operator typed before ever deploying under it (so no org row exists
 * yet) resolves to '' — the fetch below then falls back to showing everything
 * rather than erroring on an id that does not exist.
 */
async function resolveOrgId(name) {
  if (orgIdCache.has(name)) return orgIdCache.get(name);
  let id = '';
  try {
    const orgs = await api.listOrgs();
    id = orgs.find((org) => org.name.trim().toLowerCase() === name.toLowerCase())?.id || '';
  } catch { /* fall back to unscoped rather than block the map on this */ }
  orgIdCache.set(name, id);
  return id;
}

function syncScopeControl(root) {
  const org = getOrg();
  const button = $('#map-scope', root);
  button.hidden = !org;
  if (!org) return;
  const active = scopeToOrg;
  button.textContent = active ? 'Mine' : 'All';
  button.title = active
    ? `Showing only ${org}. Click to show every organization.`
    : `Showing every organization. Click to show only ${org}.`;
  button.setAttribute('aria-label', active
    ? `Showing ${org} networks. Show all networks.`
    : `Showing all networks. Show only ${org}.`);
  button.setAttribute('aria-pressed', String(active));
  button.classList.toggle('is-active', active);
}

/* ── data ───────────────────────────────────────────────────────────────── */
async function load(root, { quiet = false } = {}) {
  tick(root, 'busy');
  try {
    const org = getOrg();
    const orgId = (scopeToOrg && org) ? await resolveOrgId(org) : '';
    const graph = await api.graph({ orgId, liveOnly: LIVE_ONLY });
    // Nudge every marker off its lattice slot, then push apart anything that would
    // overlap, before anything reads a coordinate — so the pins, the balloon anchoring
    // and the edge endpoints all agree on where a network stands. Deterministic per
    // deployment id; see util/scatter.js.
    //
    // The stage's measured size goes in because "do these two markers overlap?" is a
    // question in pixels, and a percentage is a different number of pixels on a wide
    // monitor than on a laptop. Answering it in the artwork's own units looked right
    // and was wrong at every real window size.
    // Kept unscattered: the overlap threshold is in pixels, so a resize can change the
    // answer, and re-scattering an already-scattered list would compound the jitter
    // instead of recomputing it. reflow() re-derives from this.
    graphRaw = graph.nodes;
    const size = stageSize(root);
    scatterMarker = size.marker;
    graph.nodes = scatterNodes(graphRaw, size);
    graphData = graph;
    // Honour a faster server recommendation, while guaranteeing no more than one
    // minute of staleness. Zero/invalid values no longer disable this safety net.
    const advertised = mapRefreshSeconds(graph.refresh_seconds);
    if (advertised !== refreshSeconds) {
      refreshSeconds = advertised;
      schedule(root);
    }
    lastFetch = graph.generated_at;
    paint(root, graph);
    announce(root);
  } catch (error) {
    if (!quiet) toast.error(`Could not load the map — ${error.message}`);
  } finally {
    // In `finally` so a failed poll still clears the busy state and restarts the
    // countdown — schedule() re-arms after an error too, so a bar left spinning would
    // claim a request was open when the next one is actually a cadence away.
    tick(root, 'idle');
  }
}

/* ── render ─────────────────────────────────────────────────────────────── */
/**
 * Update only the pins that actually changed.
 *
 * WHY NOT JUST REPLACE THE LOT. paint() used to write the whole pin layer's innerHTML
 * on every poll. Suppressing the entrance animation stopped the markers *animating*
 * in, but the rebuild itself was still visible at a hundred pins: every element was
 * destroyed and recreated, so each chip's backdrop-filter re-composited, the inline
 * --anchor settlePins had written was wiped and balloons jumped before being
 * re-settled, and any hover was dropped mid-gesture. The map looked like it had just
 * repopulated — which is exactly what a reader reported, and they were right: nothing
 * had been added, but everything had been rebuilt.
 *
 * Keyed on the markup itself rather than on a guess about which fields matter. A pin
 * whose generated HTML is byte-identical to last time is left completely untouched, so
 * a poll that changes nothing performs zero DOM mutations. When a status does change,
 * exactly one marker is replaced.
 *
 * The arrival animation is applied *after* insertion rather than baked into the markup
 * — otherwise a pin's HTML would differ between its first render and every later one
 * (fresh vs settled), and the second poll would rebuild all hundred markers to add a
 * class that changes nothing visible.
 */
let renderedPins = new Map();

function reconcilePins(container, nodes, delays, emptyHtml, {
  batchInitial = false, onBatch = null, onComplete = null,
} = {}) {
  if (!container) return;

  // A newer reconciliation owns the layer. Its node set may be scoped differently,
  // so an older timer must never append stale pins afterwards.
  cancelPinBatches();

  if (!nodes.length) {
    if (!container.querySelector('.mapempty')) container.innerHTML = emptyHtml;
    renderedPins = new Map();
    onComplete?.();
    return;
  }
  // Leaving the empty state in place would stack it behind the first pins.
  if (container.querySelector('.mapempty')) {
    container.innerHTML = '';
    renderedPins = new Map();
  }

  const existing = new Map();
  for (const element of container.children) {
    if (element.dataset.pin) existing.set(element.dataset.pin, element);
  }

  const wanted = new Map();
  for (const node of nodes) wanted.set(node.id, pin(node));

  for (const [id, element] of existing) {
    if (!wanted.has(id)) { element.remove(); renderedPins.delete(id); }
  }

  const scratch = document.createElement('div');
  const additions = [];
  for (const [id, html] of wanted) {
    if (renderedPins.get(id) === html && existing.has(id)) continue;
    const previous = existing.get(id);
    if (previous) insertPin({ id, html, previous }, container, scratch, delays);
    else additions.push({ id, html, previous: null });
  }

  const shouldBatch = batchInitial && additions.length > INITIAL_PIN_BATCH_SIZE;
  if (!shouldBatch) {
    additions.forEach((entry) => insertPin(entry, container, scratch, delays));
    onBatch?.();
    onComplete?.();
    return;
  }

  const version = pinBatchVersion;
  let cursor = 0;
  const appendBatch = () => {
    if (version !== pinBatchVersion) return;
    const end = Math.min(additions.length, cursor + INITIAL_PIN_BATCH_SIZE);
    for (; cursor < end; cursor += 1) {
      insertPin(additions[cursor], container, scratch, delays);
    }
    onBatch?.();
    if (cursor >= additions.length) {
      pinBatchTimer = null;
      onComplete?.();
      return;
    }
    // Give the browser a paint between groups, then begin the next group on a frame
    // boundary rather than halfway through rendering one.
    pinBatchTimer = setTimeout(() => requestAnimationFrame(appendBatch),
      INITIAL_PIN_BATCH_GAP_MS);
  };
  appendBatch();
}

function insertPin({ id, html, previous }, container, scratch, delays) {
  scratch.innerHTML = html;
  const next = scratch.firstElementChild;
  if (!next) return;
  if (previous) previous.replaceWith(next);
  else container.append(next);
  renderedPins.set(id, html);

  // Only a genuinely new pin arrives; a replaced one is a status change on a marker
  // the reader is already looking at, and animating that would say "new network".
  if (delays.has(id) && !previous) {
    next.classList.remove('mappin--settled');
    next.style.setProperty('--enter-delay', `${delays.get(id)}ms`);
  }
}

function paint(root, graph) {
  const art = $('#map-art', root);
  if (!art.firstChild) art.innerHTML = mapArt();

  const org = getOrg();
  const scoped = scopeToOrg && org;
  // Read once per paint, not once per pin: getOrg() hits localStorage and pin() is
  // called a hundred times.
  myOrg = String(org || '').trim();

  syncZoomAvailability(root);
  setDensity(root);
  wirePins(root);

  const initialPopulation = renderedPins.size === 0
    && graph.nodes.length > INITIAL_PIN_BATCH_SIZE;
  const settleBatch = () => {
    // A batch is interactive as soon as it lands. Pair-dependent work (collision
    // correction and edges) waits for the full set so it is computed only once.
    applySearch(root);
    settlePins(root);
  };
  const finishPopulation = () => {
    applySearch(root);
    correctForMarker(root);
    settlePins(root);
    drawEdges(root);
    introduceFocus(root);
  };

  reconcilePins($('#map-pins', root), graph.nodes, enterDelaysFor(graph.nodes),
    `<div class="mapempty">
          <p class="mapempty__title">${scoped ? `No networks for ${esc(org)} yet` : 'No networks here yet'}</p>
          <p class="mapempty__hint">${scoped
            ? 'Click “show all” above to see every organization’s pins.'
            : 'Upload an agent network and its pin appears right here.'}</p>
        </div>`, {
      batchInitial: initialPopulation,
      onBatch: initialPopulation ? settleBatch : null,
      onComplete: finishPopulation,
    });

  // Rebuilt, not appended to: an id that has gone from the graph drops out, so a
  // network removed and later redeployed counts as new again and gets its arrival
  // back. Set after the render that used the old value.
  seenPins = new Set(graph.nodes.map((node) => node.id));
}

/**
 * Re-separate the markers once their true size is known.
 *
 * Chicken and egg: the separation depends on how big a marker renders, and nothing can
 * be measured until a marker has been rendered. The first paint therefore lays pins out
 * against a conservative constant, and this corrects them as soon as there is something
 * to measure — which also covers a density change, since a marker at tight density is
 * smaller than at roomy.
 *
 * Converges because it only acts when the measurement differs from the value the
 * current positions assume, and it records the new one before re-laying anything.
 */
function correctForMarker(root) {
  if (!graphRaw.length) return;
  const stage = $('#map-stage', root);
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;

  const measured = markerFootprint(root);
  if (measured && Math.abs(measured - scatterMarker) >= 1) {
    scatterMarker = measured;
    graphData = {
      ...graphData,
      nodes: scatterNodes(graphRaw, { ...stageSize(root), marker: measured }),
    };
    // Straight to the reconciler rather than back through paint(): the node set has
    // not changed, only its coordinates, and paint() calling this calling paint() is a
    // loop waiting to happen.
    reconcilePins($('#map-pins', root), graphData.nodes, new Map(), '');
  }
  fitMarkersToSpacing(root, box);
}

/**
 * Shrink the markers until they fit the spacing that was actually achieved.
 *
 * THE PART THAT MAKES "NO OVERLAP" TRUE. Moving pins apart is not always enough: on a
 * 860x460 stage a hundred markers plateau around 39px apart no matter how long the
 * relaxation runs, because they do not fit at full size and the edges of the drawable
 * area stop the pressure escaping. Asking for more separation there does nothing; the
 * markers have to get smaller.
 *
 * So the rendered size is derived from the measured closest pair rather than asserted
 * by the stylesheet. --pin-scale multiplies the marker's existing transform, which
 * shrinks the drop, its ring and its badge together — and markerFootprint() measures
 * the result, so the next pass sees the smaller number and the two converge instead of
 * arguing.
 *
 * Floored, because a marker scaled to nothing is worse than a slight overlap: below
 * this the honest answer is that the window is too small for this many networks, and
 * the reader should zoom, which separates them properly.
 */
const PIN_SCALE_FLOOR = 0.55;
const PIN_CLEARANCE_PX = 4;
function fitMarkersToSpacing(root, box) {
  const stage = $('#map-stage', root);
  const footprint = markerFootprint(root);
  if (!stage || !footprint) return;

  const gap = closestPairPx(graphData.nodes, { width: box.width, height: box.height });
  if (!Number.isFinite(gap)) { stage.style.setProperty('--pin-scale', '1'); return; }

  // The footprint already includes whatever --pin-scale is currently applying, so the
  // ratio is relative to what is on screen now and compounds correctly across passes.
  const room = Math.max(0, gap - PIN_CLEARANCE_PX);
  const current = Number(getComputedStyle(stage).getPropertyValue('--pin-scale')) || 1;
  const wanted = footprint <= room
    ? Math.min(1, current * (room / footprint))
    : current * (room / footprint);
  const next = Math.max(PIN_SCALE_FLOOR, Math.min(1, wanted));
  if (Math.abs(next - current) > 0.01) stage.style.setProperty('--pin-scale', next.toFixed(3));
}

/**
 * A pin is an anchor when the network is live, so a click (or Enter) opens the site
 * in a new tab. A stopped network has no URL to open, so it renders as a plain
 * element that can still be hovered and focused for tracing.
 */
function pin(node) {
  const meta = statusMeta(node.status);
  const tone = node.status === 'ready' ? 'ready' : (isLive(node.status) ? 'pending' : 'inert');
  // STABLE MARKUP. Every pin is emitted as already-settled, with no entrance delay;
  // reconcilePins strips the settled class and sets the delay on the handful that are
  // genuinely new, after inserting them.
  //
  // This is what lets a quiet poll touch nothing at all. Baking "fresh" into the
  // markup meant a pin's HTML differed between its first render and all later ones, so
  // the next poll rebuilt all hundred markers purely to swap a class that changes
  // nothing visible — and rebuilding is itself the thing that looked like networks
  // being added.

  // The marker is read by people who did not upload the file, so it carries the
  // network's name in words. The identifier it came from stays one hover away —
  // it is what the URL, the logs and the HOCON all use.
  const label = displayName(node.name);
  // What the place *does*, as an icon. A reader scanning a street map should know
  // the trade before reading the name; the org, the status wording, the counts and
  // the capability points all live in the hover callout, which is what keeps the
  // marker itself down to an icon and a name.
  const trade = industryMarker(node.name, node.description);

  const tag = node.url ? 'a' : 'div';
  const linkAttrs = node.url
    ? ` href="${esc(node.url)}" target="_blank" rel="noopener"`
      + ` aria-label="Open ${esc(label)} in a new tab"`
    : ' tabindex="0" role="button" aria-disabled="true"'
      + ` aria-label="${esc(label)} is ${esc(meta.label)} and has no live URL"`;
  const tip = `${label} — ${node.org_name}${label === node.name ? '' : ` · ${node.name}`}`;

  // Whose network this is. At event scale the reader's own pins are the ones they came
  // to find, and scanning a hundred markers for a name is exactly what a map is bad at
  // — so they are marked and pulse gently (CSS, and dropped under reduced motion).
  // Only when an organization is remembered; with none set, every pin would qualify
  // and the cue would mean nothing.
  const mine = myOrg && String(node.org_name || '').trim() === myOrg;

  return `<${tag} class="mappin mappin--${tone} mappin--settled${mine ? ' mappin--mine' : ''}"
    data-pin="${esc(node.id)}"${linkAttrs} data-hue="${esc(trade.hue)}"
    data-y="${esc(String(node.y))}" data-shift-x="${shiftXFor(node.x)}"
    style="${placement(node)}" title="${esc(tip)}">
    <span class="mappin__chip">
      <span class="mappin__chipicon" aria-hidden="true">${esc(trade.emoji)}</span>
      <span class="mappin__name">${esc(label)}</span>
    </span>
    <span class="mappin__drop" aria-hidden="true">
      <span class="mappin__trade">${esc(trade.emoji)}</span>
    </span>
    <span class="sr-only">${esc(meta.sr)}</span>
  </${tag}>`;
}

/**
 * Anchor a balloon so its tail points at the network's spot on the ground, and so
 * the balloon itself is neither clipped nor squeezed by the frame.
 *
 * A balloon is not centred on its coordinate the way the old card was: it stands
 * *above* it, with the tail and the ground dot marking the spot. That is what makes
 * the marker read as standing in the city rather than lying on it. The vertical
 * shift is therefore always -100% plus the tail's own height (BALLOON_LIFT).
 *
 * Horizontally it is centred at every x. It used to anchor by `left`/`right` near the
 * frame so a wide balloon could grow inwards instead of off the edge — but the
 * teardrop sits centred inside that box, so any change to the box's width moved the
 * marker itself. Showing the name chip on hover did exactly that, sliding edge pins
 * ~90px off the spot they were marking. See placement().
 *
 * A balloon near the very top has nowhere above to stand, so it flips below its
 * spot and the tail points up (.mappin--under).
 */
const BALLOON_LIFT = 13;   // px between the balloon's bottom edge and the ground dot
// Breathing room kept between a balloon and the stage edge, so a pin that only just
// fits does not sit flush against the frame.
const PIN_MARGIN = 6;

/**
 * How far down the stage the usable area starts, in pixels.
 *
 * The find bar is overlaid on the stage rather than above it, so the top of the stage
 * is not the top of the space a balloon or a callout can occupy. Measured rather than
 * assumed, because the bar's height depends on the org chip's font and whether it is
 * shown at all.
 *
 * Returns 0 when the bar is missing or hidden, which is what makes this safe to call
 * from the measurement paths unconditionally.
 */
function topObstruction(root) {
  const bar = $('#map-find', root);
  const stage = $('#map-stage', root);
  if (!bar || !stage || bar.hidden) return 0;
  const barBox = bar.getBoundingClientRect();
  if (!barBox.height) return 0;
  return Math.max(0, barBox.bottom - stage.getBoundingClientRect().top + PIN_MARGIN);
}

/**
 * Always centred — see placement() for why the edge cases were removed.
 *
 * Kept as a function rather than inlined because settlePins() rebuilds `--anchor` from
 * `data-shift-x` and the two have to agree; one definition is what guarantees that.
 */
function shiftXFor() {
  return '-50%';
}

function anchorY(under) {
  return under ? `${BALLOON_LIFT}px` : `calc(-100% - ${BALLOON_LIFT}px)`;
}

function placement(node) {
  // ALWAYS CENTRED on the coordinate, at every x. Markers near the left and right
  // edges used to be anchored by their own left/right edge instead, so the balloon
  // would grow inwards rather than off the frame — but the teardrop sits *centred
  // inside* that box, and the box's width is whatever its name chip needs. Showing the
  // chip on hover widened an edge marker from ~26px to ~208px, which slid its teardrop
  // sideways by about 90px: the pin visibly jumped away from the place it was marking,
  // but only at the edges, which is why it looked intermittent.
  //
  // Centred, the box grows symmetrically and the teardrop does not move at all. The
  // cost is that a long name can be clipped at the extreme edges, which the chip's
  // max-width keeps within a few pixels — a name trimmed is a far smaller lie than a
  // marker pointing at the wrong spot.
  const horizontal = `left:${node.x}%`;

  // Standing above the spot is only the opening guess. Which side a balloon can
  // actually take depends on the stage's pixel height and the balloon's own height,
  // neither of which exists yet — settlePins() decides it once they do.
  const vertical = `top:${node.y}%`;
  return `${horizontal};${vertical};--anchor:translate(-50%, ${anchorY(false)})`;
}

/**
 * Flip a balloon below its spot wherever there is not enough room above it.
 *
 * `placement()` emits its anchor as a style string before the pin is in the DOM, so
 * it can only guess, and the percentage threshold it used to guess with could never
 * be right: the top grid row sits at y=12 (layout.py), which is ~68px down a 566px
 * stage, while a roomy balloon is ~86px tall including its lift. Every pin in that
 * row therefore had its name chip clipped away by the stage's `overflow: hidden` —
 * and the old `node.y <= 10` test could not fire for it, because no slot is ever
 * placed above 12.
 *
 * Measured here instead, after layout and before the frame paints, so there is no
 * visible flip. Re-run from reflow() because both terms move: the stage with the
 * viewport, the balloon with the density class that hides its chip.
 */
function settlePins(root) {
  const stage = $('#map-stage', root);
  const stageHeight = stage.getBoundingClientRect().height;
  // Nothing to measure against while the view is hidden or mid-mount; reflow() runs
  // this again as soon as the stage has a size.
  if (!stageHeight) return;

  const pins = [...stage.querySelectorAll('.mappin')];
  if (!pins.length) return;

  // The name chip is hidden until its pin is hovered or focused at every density,
  // and it then appears *above* the drop — growing the balloon upwards after
  // this function has already chosen a side. So reserve that growth now rather than
  // react to it on hover, where moving the pin out from under the cursor would cost
  // a mouseleave and flicker. Measured once: the chip is a single nowrap line, so
  // every pin's is the same height.
  let reserve = 0;
  const sampleChip = pins[0].querySelector('.mappin__chip');
  if (sampleChip && getComputedStyle(sampleChip).display === 'none') {
    sampleChip.style.display = 'inline-flex';
    reserve = sampleChip.offsetHeight
      + (Number.parseFloat(getComputedStyle(pins[0]).rowGap) || 0);
    sampleChip.style.display = '';
  }

  // TWO PASSES, and the split is the whole point: measure every pin first, then
  // write every pin. Interleaved — read offsetHeight, toggle a class, read the next
  // one — each write invalidates layout and the following read forces a fresh
  // synchronous reflow. At a dozen pins that is invisible; at the 80-100 an event
  // produces it is 100 full layout passes, and it was what made a busy map take
  // seconds to open.
  const measured = [];
  pins.forEach((element) => {
    const y = Number(element.dataset.y);
    if (!Number.isFinite(y)) return;
    measured.push({ element, y, height: element.offsetHeight });
  });
  // The question is how much room a pin has above it *on screen*, which the zoom
  // changes: a pin near the top of the city can be panned into the middle of the
  // frame, where there is plenty of room, and one in the middle can be pushed up
  // against the top edge. So the pin's y is projected through the current view
  // (scene y * scale + offset) rather than read as a share of the stage.
  //
  // The balloon's own height needs no conversion: the markers are counter-scaled
  // (--unzoom), so offsetHeight * (1 / scale) * scale is just offsetHeight — its
  // on-screen height is the same at every zoom level. At scale 1 with no pan this
  // whole expression collapses back to the original share-of-the-stage test.
  const scale = clampScale(view.scale);
  const offsetY = Number(view.ty) || 0;
  // The find bar floats over the top of the stage, so the usable ceiling is its bottom
  // edge, not the stage's. Measuring against the stage meant a pin in the top rows
  // decided it had room above, stood its balloon up into the bar, and the balloon was
  // painted behind it — the reader hovered a pin and nothing appeared to happen.
  const topGuard = topObstruction(root);
  measured.forEach(({ element, y, height }) => {
    const screenY = (y / 100) * stageHeight * scale + offsetY;
    const under = (screenY - topGuard) < height + reserve + BALLOON_LIFT + PIN_MARGIN;
    element.classList.toggle('mappin--under', under);
    // Only the vertical half of the anchor depends on the side, so the horizontal
    // anchor and `top` from placement() are both left untouched.
    element.style.setProperty(
      '--anchor', `translate(${element.dataset.shiftX}, ${anchorY(under)})`);
  });
}

/* Entrance cascade. ENTER_STEP_MS is the spacing when few enough pins can afford
   it; ENTER_WINDOW_MS caps the whole arrival, so the spacing tightens rather than
   the cascade collapsing into a single simultaneous delay. */
const ENTER_STEP_MS = 55;
const ENTER_WINDOW_MS = 1100;

/**
 * Pins already on screen, so a repaint does not replay the entrance for all of them.
 *
 * Which pin is *new* is a different question from which pin's markup changed, and both
 * have to be answered: reconcilePins decides what to touch, this decides what arrives.
 * A network whose status went ready→stopped is rebuilt but has not arrived; it must
 * not animate, or a poll would announce a network that has been there all along.
 *
 * Rebuilt from the current node list after each render rather than only added to, so
 * a network that is removed and later redeployed is treated as new again and gets
 * its arrival back.
 */
let seenPins = new Set();

/**
 * Entrance delay per pin id — present only for pins that are new this render.
 *
 * The stagger counts *fresh* pins alone. Indexing into the whole list would give a
 * single new network the delay of whatever position it happened to occupy, so the
 * one pin a reader is waiting for could sit invisible for a second while nothing
 * else moved.
 */
function enterDelaysFor(nodes) {
  const fresh = nodes.filter((node) => !seenPins.has(node.id));
  const step = Math.min(ENTER_STEP_MS, ENTER_WINDOW_MS / Math.max(1, fresh.length));
  const delays = new Map();
  fresh.forEach((node, i) => delays.set(node.id, Math.round(i * step)));
  return delays;
}

/* ── edges, measured in pixel space ─────────────────────────────────────── */
const SVG_NS = 'http://www.w3.org/2000/svg';
const edgeKey = (edge) => `${edge.source}|${edge.target}`;

/**
 * Both arrow layers. `resolved` edges exist because somebody bound one network to
 * another; `suggested` ones are inferred from the networks' descriptions and are drawn
 * dashed and dimmer, so a guess can never read as a wired connection.
 *
 * A suggestion that merely restates an existing link is dropped: it would be painted
 * directly underneath the real arrow and add nothing.
 */
function edgeLayers() {
  const resolved = graphData.edges || [];
  if (!SHOW_SUGGESTED_EDGES) return { resolved, suggested: [] };
  const resolvedKeys = new Set(resolved.map(edgeKey));
  const suggested = (graphData.suggested_edges || [])
    .filter((edge) => !resolvedKeys.has(edgeKey(edge)));
  return { resolved, suggested };
}

/**
 * Hold the arrowheads at a constant on-screen size.
 *
 * The SVG's user space is the scene's, so a marker `s` units wide paints at `s * k`
 * pixels; dividing by the scale cancels that. Without it a zoomed-in map grew heads
 * big enough to cover the marker they pointed at, which defeats the one thing an
 * arrowhead is for — saying *which* network is on the receiving end.
 *
 * Re-applied from drawEdges rather than set once, because it has to track the zoom and
 * drawEdges already runs on every view change.
 */
const MARKER_BASE = { 'map-arrow': 9, 'map-arrow-suggested': 7 };
function sizeMarkers(root, scale) {
  for (const [id, base] of Object.entries(MARKER_BASE)) {
    const marker = root.querySelector(`#${id}`);
    if (!marker) continue;
    const size = (base / scale).toFixed(3);
    marker.setAttribute('markerWidth', size);
    marker.setAttribute('markerHeight', size);
  }
}

function drawEdges(root) {
  const stage = $('#map-stage', root);
  const scene = $('#map-scene', root);
  const svg = $('#map-edges', root);
  const group = $('#map-edge-paths', root);
  if (!stage || !scene || !svg || !group) return;

  // The SVG sits *inside* the zoomed scene — it has to, or the arrows would paint over
  // the markers instead of under them. So everything here works in the scene's own
  // coordinates, not the screen's: measuring in screen pixels and writing the result
  // into a child of the scene would have the transform applied a second time, and the
  // edges would drift further from their pins the further the reader zoomed in.
  //
  // getBoundingClientRect reports post-transform pixels, so dividing by the scale
  // converts back. The scene's CSS box is exactly the stage's size, which is what makes
  // that division the whole conversion.
  const sceneBox = scene.getBoundingClientRect();
  if (!sceneBox.width || !sceneBox.height) return;
  const scale = clampScale(view.scale);
  sizeMarkers(root, scale);
  const bounds = { left: 0, top: 0, width: sceneBox.width / scale, height: sceneBox.height / scale };
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);

  const boxes = new Map();
  stage.querySelectorAll('[data-pin]').forEach((element) => {
    // Measure the DROP, not the whole pin. `.mappin` wraps the name chip as well, and
    // the chip is in flow (`display: inline-flex, max-width: 13rem`), so the pin's own
    // box is as wide as the label — up to 208px against the drop's 42px — and taller,
    // since the chip stacks above it. Insetting an edge to that box left the line
    // stopping at the edge of the name with a visible gap before the balloon.
    //
    // Why it looked intermittent: the chip is only rendered at low density (see
    // setDensity), so the gap appeared on a sparse map and vanished on a crowded one,
    // and was worst for the longest names.
    //
    // Falls back to the pin itself, which is what the drop used to be measured through
    // and is still correct to within the chip — better than dropping the edge entirely
    // if the internals are ever restructured.
    const marker = element.querySelector('.mappin__drop') || element;
    const rect = marker.getBoundingClientRect();
    // Then undo the rotation's inflation. `.mappin__drop` is rotate(-45deg), and a
    // rotated square's bounding rect is √2 larger than the square itself — 59px for a
    // 42px marker. The inset below resolves a *rectangle* boundary against this box, so
    // on a diagonal approach it answered ~42px from centre while the balloon body ends
    // near 21px, and the line stopped short of the shape it points at.
    //
    // Measured from the rect rather than offsetWidth because `.mappin` also carries
    // `scale(--unzoom × --pin-scale)` and markers are shrunk at high density: the
    // layout box would claim 42px for a marker rendered at 33px. The rect includes
    // every transform, so dividing by `scale` and then by √2 leaves the silhouette as
    // actually drawn.
    //
    // SQRT2 is coupled to that 45° rotation. If the drop's transform changes, this
    // has to change with it — there is no way to read "how much did the rotation
    // inflate this" back off a bounding rect.
    const width = rect.width / scale / Math.SQRT2;
    const height = rect.height / scale / Math.SQRT2;
    const centreX = (rect.left + rect.width / 2 - sceneBox.left) / scale;
    const centreY = (rect.top + rect.height / 2 - sceneBox.top) / scale;
    boxes.set(element.dataset.pin, {
      left: centreX - width / 2,
      top: centreY - height / 2,
      width,
      height,
    });
  });

  const { resolved, suggested } = edgeLayers();
  const drawn = [
    ...resolved.map((edge) => ({ edge, kind: 'resolved' })),
    // Suggestions are appended last so they paint above the backdrop but their lower
    // opacity keeps real arrows dominant where the two run close together.
    ...suggested.map((edge) => ({ edge, kind: 'suggested' })),
  ];
  // Bow opposing directions apart whichever layer each came from, so a real A→B and a
  // suggested B→A do not land on top of each other.
  const drawnKeys = new Set(drawn.map(({ edge }) => edgeKey(edge)));

  // Reconciled, not rebuilt — the same reason reconcilePins exists, for the same
  // reader-visible symptom. `.mapedge--flow` carries `animation: map-flow 1.5s linear
  // infinite`, and replacing a path element restarts that animation from frame zero:
  // every travelling dash on the map jumped back to the start on each poll. At a
  // 30-second cadence that is twice a minute, which reads as the map flickering.
  //
  // Keyed on the geometry and classes actually written, so an unchanged edge keeps its
  // element and its animation phase. A poll that moves nothing performs no SVG
  // mutations at all; a pin that moved updates only the paths touching it.
  const live = new Map();
  for (const { edge, kind } of drawn) {
    const path = edgePath(edge, kind, boxes, bounds, drawnKeys);
    if (!path) continue;
    // Several edges can share a source/target pair (two orgs, same network name), so
    // the index disambiguates rather than collapsing them onto one element.
    const key = `${kind}|${edgeKey(edge)}|${live.size}`;
    live.set(key, path);
  }

  const existing = new Map();
  for (const element of group.children) {
    if (element.dataset.edge) existing.set(element.dataset.edge, element);
  }
  for (const [key, element] of existing) {
    if (!live.has(key)) element.remove();
  }
  let previous = null;
  for (const [key, path] of live) {
    path.dataset.edge = key;
    const current = existing.get(key);
    if (current
        && current.getAttribute('d') === path.getAttribute('d')
        && current.getAttribute('class') === path.getAttribute('class')
        && current.getAttribute('marker-end') === path.getAttribute('marker-end')) {
      previous = current;                      // identical: leave it, animation intact
      continue;
    }
    if (current) current.replaceWith(path);
    else if (previous) previous.after(path);
    else group.prepend(path);
    previous = path;
  }
}

function edgePath(edge, kind, boxes, bounds, drawnKeys) {
  const from = boxes.get(edge.source);
  const to = boxes.get(edge.target);
  if (!from || !to || edge.source === edge.target) return null;

  const sx0 = from.left + from.width / 2 - bounds.left;
  const sy0 = from.top + from.height / 2 - bounds.top;
  const tx0 = to.left + to.width / 2 - bounds.left;
  const ty0 = to.top + to.height / 2 - bounds.top;

  const dx = tx0 - sx0;
  const dy = ty0 - sy0;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / distance;
  const uy = dy / distance;

  // Distance from each centre out to its own box boundary along the line, so the
  // path starts and ends clear of the pins rather than beneath them.
  //
  // The `|| Infinity` guard this replaces inverted the result for an axis-aligned
  // edge: a zero component makes its ratio 0, and `0 || Infinity` is Infinity, so
  // Math.max chose Infinity and the boundary came out as 1/Infinity = 0 — the path
  // then started at the marker's centre and ran out from under it. A zero component
  // must contribute *nothing* to the max, which is what plain 0 already does; the
  // only case the guard was needed for is a zero-sized box, handled explicitly.
  // A radius, not a rectangle intersection, because the marker is round: the drop is
  // a square with three rounded corners, so its silhouette is a disc of half-side
  // radius plus a tail at one corner. A rectangle boundary answered 20.8px across the
  // axes but 20.8×√2 = 29.4px on the diagonals, so diagonal edges stopped ~9px further
  // out than horizontal ones and the gap around a pin was visibly uneven — which is
  // what "the line and the marker are not meeting" looks like once the label is no
  // longer the cause.
  //
  // min of the two half-extents: for the square drop they are equal, and for the
  // fallback box it errs towards touching the marker rather than floating away.
  const boundary = (box) => Math.min(box.width, box.height) / 2;
  const startInset = Math.min(boundary(from) + 6, distance * 0.42);
  const endInset = Math.min(boundary(to) + 10, distance * 0.42);

  const sx = sx0 + ux * startInset;
  const sy = sy0 + uy * startInset;
  const tx = tx0 - ux * endInset;
  const ty = ty0 - uy * endInset;

  // Bow the curve, and bow a mutual pair in opposite directions so A→B and B→A
  // stay legible instead of overlapping.
  const mutual = drawnKeys.has(`${edge.target}|${edge.source}`);
  const sign = mutual ? (edge.source < edge.target ? 1 : -1) : 1;
  const bend = sign * Math.min(mutual ? 26 : 20, distance * 0.14);
  const cx = (sx + tx) / 2 - uy * bend;
  const cy = (sy + ty) / 2 + ux * bend;

  const suggestion = kind === 'suggested';
  const inert = !isLive(nodeById(edge.source)?.status) || !isLive(nodeById(edge.target)?.status);
  const path = document.createElementNS(SVG_NS, 'path');
  // A real link between two live networks gets the travelling dash: it shows which
  // way the call goes, which a static line can only imply with its arrowhead. Not
  // applied to suggestions (already dashed, and a guess should not look busy) or to
  // inert edges (nothing is flowing between stopped networks).
  path.setAttribute('class', ['mapedge',
    suggestion ? 'mapedge--suggested' : '',
    inert ? 'mapedge--inert' : '',
    !suggestion && !inert ? 'mapedge--flow' : ''].filter(Boolean).join(' '));
  path.setAttribute('d', `M ${sx.toFixed(1)} ${sy.toFixed(1)} `
    + `Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`);
  path.setAttribute('marker-end', suggestion ? 'url(#map-arrow-suggested)' : 'url(#map-arrow)');
  path.dataset.source = edge.source;
  path.dataset.target = edge.target;
  path.dataset.kind = kind;
  return path;
}

const nodeById = (id) => graphData.nodes.find((node) => node.id === id);
// Named for a reader, same as the pins: the relations readout is a sentence about
// which networks talk to which, and an identifier mid-sentence stops it being one.
const nameById = (id) => displayName(nodeById(id)?.name || id);

/* ── hover tracing ──────────────────────────────────────────────────────── */
/**
 * Hover and focus tracing, delegated to the pin layer.
 *
 * DELEGATED, AND IT HAS TO BE. This used to attach four listeners to every marker,
 * which was safe only because the layer's innerHTML was replaced wholesale on each
 * poll and took the old listeners with it. Now that reconcilePins leaves unchanged
 * markers alone, re-attaching per element would have stacked another four on every
 * surviving pin each poll — four hundred new listeners a minute at event scale, each
 * firing trace() on one hover.
 *
 * mouseover/mouseout rather than mouseenter/mouseleave because only the former bubble;
 * the relatedTarget comparison is what turns them back into enter/leave semantics, so a
 * cursor moving between a pin's own chip and drop does not count as leaving it.
 */
function wirePins(root) {
  const layer = $('#map-pins', root);
  // Idempotent: paint() calls this on every render and only the first does anything.
  if (!layer || layer.dataset.wired) return;
  layer.dataset.wired = '1';

  const pinOf = (target) => (target instanceof Element ? target.closest('[data-pin]') : null);

  layer.addEventListener('mouseover', (event) => {
    const entered = pinOf(event.target);
    if (entered && entered !== pinOf(event.relatedTarget)) {
      trace(root, entered.dataset.pin);
      // Found it — stop pulsing at them.
      acknowledgeFocus(root, entered.dataset.pin);
    }
  });
  layer.addEventListener('mouseout', (event) => {
    const left = pinOf(event.target);
    if (left && left !== pinOf(event.relatedTarget)) clearTrace(root);
  });
  layer.addEventListener('focusin', (event) => {
    const focused = pinOf(event.target);
    if (focused) {
      trace(root, focused.dataset.pin);
      acknowledgeFocus(root, focused.dataset.pin);
    }
  });
  layer.addEventListener('focusout', (event) => {
    const left = pinOf(event.target);
    if (left && left !== pinOf(event.relatedTarget)) clearTrace(root);
  });
}

function trace(root, id) {
  const stage = $('#map-stage', root);
  const node = nodeById(id);
  if (!node) return;

  const related = new Set([id]);
  let activeEdges = 0;
  stage.querySelectorAll('.mapedge').forEach((path) => {
    const active = path.dataset.source === id || path.dataset.target === id;
    path.classList.toggle('is-active', active);
    if (active) {
      activeEdges += 1;
      related.add(path.dataset.source);
      related.add(path.dataset.target);
    }
  });
  // Only trace when this pin actually has edges. `is-tracing` exists to make one
  // subgraph stand out by pushing the rest back; with nothing to stand out it just
  // fades every other line to 7% and contrasts it against nothing. The hovered pin
  // still gets its own ring and its callout either way — set after the walk above,
  // because whether to trace at all depends on what that walk found.
  stage.classList.toggle('is-tracing', activeEdges > 0);
  stage.querySelectorAll('[data-pin]').forEach((element) => {
    element.classList.toggle('is-related', related.has(element.dataset.pin));
    element.classList.toggle('is-origin', element.dataset.pin === id);
  });

  const { resolved, suggested } = edgeLayers();
  const relations = [
    ...relationPhrases(id, resolved, 'calls', 'called by', 'exchanges with'),
    ...relationPhrases(id, suggested, 'may call', 'may be called by', 'may exchange with'),
  ].join(' · ');

  const facts = [
    node.agent_count ? `${node.agent_count} agent${node.agent_count === 1 ? '' : 's'}` : '',
    node.hosted_tools ? `${node.hosted_tools} tool${node.hosted_tools === 1 ? '' : 's'}` : '',
    node.open_slots ? `${node.open_slots} open slot${node.open_slots === 1 ? '' : 's'}` : '',
    node.external_links ? `${node.external_links} external link${node.external_links === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  // The evidence behind the strongest suggestion. Built from the edge's `reference`
  // rather than its prose `reason`: the API keeps the full sentence for its own
  // consumers, while the panel shows the short form.
  const why = suggestionEvidence(id, suggested);
  const meta = statusMeta(node.status);

  // What this network does, as a few very short points. The raw description is a
  // single author-written paragraph — the bundled travel example runs to 340
  // characters of semicolons — and this panel is read in passing, while hovering
  // a pin, by people who did not build the network. Prose that long does not get
  // read here at all.
  const points = capabilityBullets(node.description);
  // The plain sentence too, short enough to actually read at a glance — the
  // bullets above are a scan aid, not a substitute for the author's own words.
  const short = shortDescription(node.description);

  const panel = $('#map-detail', root);
  render(panel, [
    `<p class="mapdetail__name">${esc(displayName(node.name))}</p>`,
    `<p class="mapdetail__org">${esc(node.org_name)} · ${esc(meta.label)}</p>`,
    // Deliberately NOT the raw `travel_agent_system` identifier: this callout is
    // the one consumer-facing surface on the map, and an underscored key is noise
    // to the person reading it. It is still a hover away on the pin itself, and in
    // code type on the network's Directory row.
    short ? `<p class="mapdetail__desc">${esc(short)}</p>` : '',
    points.length
      ? `<ul class="mapdetail__points">${
          points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      : '',
    facts ? `<p class="mapdetail__facts">${esc(facts)}</p>` : '',
    `<p class="mapdetail__rel">${esc(relations || 'not linked to another network')}${
      why ? `<span class="mapdetail__why">${esc(why)}</span>` : ''}</p>`,
    // Read-only here: the callout is pointer-events:none (hovering onto it must
    // not steal the hover from the pin, which is what keeps it open), so there is
    // nowhere in this panel a "copy" button could actually be clicked. The same
    // URL is copyable from the Directory and Network list rows instead.
    node.url ? `<p class="mapdetail__url"><code>${esc(hostOf(node.url))}</code></p>` : '',
  ].filter(Boolean).join(''));

  const pinElement = stage.querySelector(`[data-pin="${CSS.escape(id)}"]`);
  if (pinElement) positionDetail(stage, pinElement, panel, topObstruction(root));
  else panel.hidden = false;
}

/**
 * Describe one pin's edges in as few words as possible. The readout floats over the
 * map, so every character costs stage area.
 *
 * A peer on both sides of a pin is named *once* — "may exchange with X" rather than
 * "may call X · may be called by X", which said the same network twice and was the
 * single biggest contributor to an oversized readout.
 */
function relationPhrases(id, edges, outward, inward, mutual) {
  const targets = new Set(edges.filter((e) => e.source === id).map((e) => e.target));
  const sources = new Set(edges.filter((e) => e.target === id).map((e) => e.source));
  const both = [...targets].filter((peer) => sources.has(peer));
  // Cap the names. RELATIONS_MAX_PER_NETWORK bounds a network's *outbound*
  // suggestions, but nothing bounds inbound ones — on a 60-network map every other
  // network can suggest this one, and naming them all turned the readout into a
  // 45-name wall of text taller than the map. The count still tells the whole truth.
  const label = (ids) => {
    const shown = ids.slice(0, RELATION_NAME_CAP).map(nameById).join(', ');
    const rest = ids.length - RELATION_NAME_CAP;
    return rest > 0 ? `${shown} +${rest} more` : shown;
  };
  const phrases = [];
  if (both.length) phrases.push(`${mutual} ${label(both)}`);
  const onlyOut = [...targets].filter((peer) => !sources.has(peer));
  const onlyIn = [...sources].filter((peer) => !targets.has(peer));
  if (onlyOut.length) phrases.push(`${outward} ${label(onlyOut)}`);
  if (onlyIn.length) phrases.push(`${inward} ${label(onlyIn)}`);
  return phrases;
}

/**
 * The evidence behind the strongest suggestion touching this pin.
 *
 * Direction matters and must be stated. A capability edge's `reference` is a slot
 * declared by its *source*, so on an inbound edge that slot belongs to the peer, not
 * to the pin being hovered — reporting it unqualified read as though this network had
 * declared it.
 */
function suggestionEvidence(id, suggested) {
  const strongest = (edges) => edges.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const outbound = strongest(suggested.filter((edge) => edge.source === id));
  const inbound = strongest(suggested.filter((edge) => edge.target === id));
  // Prefer this pin's own declared need; fall back to what it could satisfy.
  const best = outbound || inbound;
  if (!best) return '';
  if (!best.reference) return 'matched on shared subject matter';
  // The slot is named for a reader too. It was left as the verbatim HOCON key on
  // the argument that somebody acting on the suggestion needs the exact string —
  // but this callout is the one consumer-facing surface on the map, an
  // underscored key is the hardest thing on it to read, and the console already
  // shows agent names spelled out everywhere else (the network diagram included,
  // which is where you go to act on this and which keeps the raw key on hover).
  const slot = displayName(best.reference);
  return best === outbound
    ? `via its open slot “${slot}”`
    : `fills ${nameById(best.source)}’s slot “${slot}”`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Long enough to read as a real sentence, short enough that the callout stays a
// glance rather than a read — the bundled travel example's description runs to
// 340 characters, well past this.
const SHORT_DESC_MAX = 140;

function shortDescription(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= SHORT_DESC_MAX) return text;
  const cut = text.slice(0, SHORT_DESC_MAX);
  // Break on a word boundary when there is a reasonable one nearby; otherwise the
  // hard cut is still better than overrunning the panel.
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > SHORT_DESC_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Clearance between a pin's edge and the callout, and between the callout and the
// edge of the stage.
const DETAIL_GAP = 12;
const DETAIL_MARGIN = 8;

/**
 * Anchor the detail callout to its pin, above or below depending on room.
 *
 * Measured in pixels for the same reason the edges are: the pin is placed in
 * percentages and transformed, so only its real box says where it ended up. The
 * stage clips its overflow, so the callout is clamped inside rather than allowed to
 * spill — and because clamping can pull the box off the pin's centre, the tail is
 * positioned independently so it still points at the pin.
 */
function positionDetail(stage, pinElement, panel, topGuard = 0) {
  const stageBox = stage.getBoundingClientRect();
  const pinBox = pinElement.getBoundingClientRect();

  const pinTop = pinBox.top - stageBox.top;
  const pinBottom = pinBox.bottom - stageBox.top;
  const pinCentreX = pinBox.left + pinBox.width / 2 - stageBox.left;

  // `topGuard` is the bottom of the find bar, which floats over the stage. Without it
  // the callout for a pin in the top rows was laid out into the space the bar
  // occupies and painted underneath it, so hovering showed nothing.
  const ceiling = Math.max(DETAIL_MARGIN, topGuard);
  const roomBelow = stageBox.height - pinBottom - DETAIL_GAP - DETAIL_MARGIN;
  const roomAbove = pinTop - DETAIL_GAP - ceiling;
  const below = roomBelow >= roomAbove;

  // Cap the height to the chosen side *before* measuring. Room depends only on the
  // pin, not on content, so this is safe to set first — and while the measured
  // height stays within the room, the box provably lands inside the stage without
  // covering its pin, which is what makes the clamps below mere guards. A minimum
  // height here would break exactly that invariant, so there isn't one.
  panel.classList.remove('mapdetail--above', 'mapdetail--below');
  panel.classList.add(below ? 'mapdetail--below' : 'mapdetail--above');
  panel.style.maxHeight = `${Math.max(0, below ? roomBelow : roomAbove)}px`;

  // Lay out to measure, but keep it invisible so it never paints at a stale position.
  panel.style.visibility = 'hidden';
  panel.hidden = false;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;

  const left = Math.max(DETAIL_MARGIN, Math.min(
    pinCentreX - width / 2, stageBox.width - width - DETAIL_MARGIN));
  const top = Math.max(ceiling, Math.min(
    below ? pinBottom + DETAIL_GAP : pinTop - DETAIL_GAP - height,
    stageBox.height - height - DETAIL_MARGIN));

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  // Keep the tail on the box even if the pin sits beyond a clamped edge.
  panel.style.setProperty('--caret-x', `${Math.round(
    Math.max(12, Math.min(pinCentreX - left, width - 12)))}px`);
  panel.style.visibility = '';
}

function clearTrace(root) {
  const stage = $('#map-stage', root);
  stage.classList.remove('is-tracing');
  stage.querySelectorAll('.mapedge').forEach((path) => path.classList.remove('is-active'));
  stage.querySelectorAll('[data-pin]').forEach((element) => {
    element.classList.remove('is-related', 'is-origin');
  });
  const panel = $('#map-detail', root);
  panel.hidden = true;
  panel.textContent = '';
}
