/**
 * The launch dialog: watch a deployment build, then open it on the map.
 *
 * Why a modal rather than the map's own banner: between pressing Launch and the site
 * answering there is nothing for the operator to do, and a warm build is ~20 seconds.
 * A dialog owns that wait — it cannot be missed, it cannot be scrolled past, and it is
 * the one place a failed build is reported (a failed deployment has no site, so it is
 * not drawn on the map and a pin could never carry the error).
 *
 * The loader animates an agent network assembling itself, because that is literally
 * what is happening: the front-man appears, sub-agents connect, tools attach. It is
 * built from the real network summary once the build reports one, so the shape settles
 * into the network that was actually deployed rather than a decorative loop.
 *
 * Honesty rules this file follows:
 *   · The stage list tracks the three states the API actually reports — queued,
 *     building, ready. No invented sub-steps with fake percentages.
 *   · The "currently doing" line is the real last line of nsdeploy's build log,
 *     tidied for reading. When there is no log yet it says so instead of guessing.
 *   · A cold build (GitHub fetches, pip installs) is slower and the dialog says that
 *     once the wait passes the point where a warm build would have finished.
 */
import { api, ApiError } from '../api/client.js';
import { toast } from './toast.js';
import { esc, icon, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { openModal } from './modal.js';

// One bounded /wait per iteration; 504 means "still building", so the loop continues.
const WAIT_SECONDS = 15;
const LOG_TAIL = 40;
// The clock counts DOWN from here, because a countdown reads as progress where a
// rising number reads as elapsed cost. It is an estimate, not a deadline: a warm
// build lands around this, a cold one (GitHub fetches, pip install) takes minutes.
const ESTIMATE_SECONDS = 20;
// Past this the build is definitely cold, and the dialog should say so rather than
// let the wait feel broken.
const WARM_BUILD_SECONDS = 30;

// One word each. The API reports exactly these three states, so the pips mirror them
// and nothing here is invented progress.
const STAGES = [
  ['queued', 'Queued'],
  ['building', 'Building'],
  ['ready', 'Live'],
];

// How long the success tick is held before the dialog closes and the map opens. Long
// enough to register as "it worked", short enough not to be a step of its own.
const SUCCESS_FLASH_MS = 1100;

/**
 * Turn one line of nsdeploy's build output into something worth reading.
 *
 * Known milestones are restated in plain language. Anything else falls through as
 * itself — a build doing something unexpected should still show it rather than sit
 * on a generic message — but only if it reads as a sentence to somebody who did not
 * write nsdeploy. The two filters below exist because the real log fails that test
 * often: it prints absolute filesystem paths, indented detail under each milestone,
 * and its own operator hints ("Ctrl-C to stop").
 */
// `Front-man:`/`Agents:` are report-header fields, not events — they arrive with the
// report's column padding ("Agents:    1") and the success panel states both properly
// from the build summary, so showing them here is worse than showing nothing.
const LOG_NOISE = /StreamableHTTP|Ctrl-C|^-{3}|^\s*(LLM|BYOK|Public MCP facade|External MCP|Linker):|^(Front-man|Agents):/i;
// Any absolute path, POSIX or Windows. These belong in the build log, not in a
// progress line — they are long, they wrap, and they mean nothing to the reader.
const LOG_PATH = /(?:[A-Za-z]:[\\/]|→\s*[\\/]|\s\/(?:home|Users|tmp|var)\/)/;

function humanizeLogLine(line) {
  const raw = String(line || '');
  const text = raw.trim();
  if (!text) return '';

  // Milestones first, so the ones nsdeploy prints indented (its pip-install notice)
  // still survive the indentation filter below.
  if (/^…?installing dependency/i.test(text)) {
    const name = text.match(/'([^']+)'/);
    return name
      ? `Installing ${name[1]}, a package one of your tools needs…`
      : 'Installing a package one of your tools needs…';
  }
  if (/^▶\s*Resolving/i.test(text)) return 'Reading your network definition…';
  if (/^Network:/i.test(text)) return 'Network definition understood.';
  if (/Hostable tools/i.test(text)) return 'Working out which tools can be hosted…';
  if (/^✅\s*Generated site/i.test(text)) return 'Site generated. Starting it up…';
  if (/MCP tool servers/i.test(text)) return 'Starting a tool server for each hosted tool…';
  if (/is live:/i.test(text)) return 'The site is up — checking it answers…';
  if (/DEMO-MODE agents/i.test(text)) return 'Noting which agents are not grounded yet…';

  // Not a milestone: only pass it on if it stands alone as a sentence.
  if (LOG_NOISE.test(raw) || LOG_PATH.test(raw)) return '';
  if (/^\s/.test(raw)) return '';   // indented detail under a milestone above
  return text.replace(/^[•✅⚠️ℹ️🔌🔗▶🌐]\s*/u, '').slice(0, 120);
}

function lastUsefulLine(lines) {
  for (let i = (lines || []).length - 1; i >= 0; i -= 1) {
    const text = humanizeLogLine(lines[i]);
    if (text) return text;
  }
  return '';
}

/**
 * The assembling-network loader.
 *
 * Positions are fixed rather than random: Math.random() here would make the animation
 * jitter between renders, and the layout has to stay put while nodes fade in. Counts
 * come from the real summary when there is one, so the picture converges on the
 * network that was deployed.
 */
function loaderArt({ agents = 0, tools = 0, settled = false } = {}) {
  // Enough seats for a plausible network, trimmed to what the build reported.
  const seats = [
    { x: 50, y: 16, r: 9, kind: 'front' },
    { x: 24, y: 47, r: 7, kind: 'agent' },
    { x: 50, y: 52, r: 7, kind: 'agent' },
    { x: 76, y: 47, r: 7, kind: 'agent' },
    { x: 14, y: 82, r: 5, kind: 'tool' },
    { x: 37, y: 84, r: 5, kind: 'tool' },
    { x: 63, y: 84, r: 5, kind: 'tool' },
    { x: 86, y: 82, r: 5, kind: 'tool' },
  ];
  const agentSeats = seats.filter((s) => s.kind === 'agent');
  const toolSeats = seats.filter((s) => s.kind === 'tool');
  // Before the summary arrives, show the full lattice; after, show what is really there.
  const shownAgents = agents ? Math.min(agents - 1, agentSeats.length) : agentSeats.length;
  const shownTools = tools ? Math.min(tools, toolSeats.length) : toolSeats.length;
  const active = [
    seats[0],
    ...agentSeats.slice(0, Math.max(shownAgents, 1)),
    ...toolSeats.slice(0, shownTools),
  ];
  const has = (seat) => active.includes(seat);

  const edges = [];
  agentSeats.slice(0, Math.max(shownAgents, 1)).forEach((seat, index) => {
    edges.push({ from: seats[0], to: seat, delay: 0.25 + index * 0.18 });
  });
  toolSeats.slice(0, shownTools).forEach((seat, index) => {
    // Attach each tool to its nearest shown agent, so the picture reads as a tree.
    const parents = agentSeats.slice(0, Math.max(shownAgents, 1));
    const parent = parents.reduce((best, cand) =>
      Math.abs(cand.x - seat.x) < Math.abs(best.x - seat.x) ? cand : best, parents[0]);
    edges.push({ from: parent, to: seat, delay: 0.8 + index * 0.14 });
  });

  return `
  <div class="assembler${settled ? ' assembler--settled' : ''}" aria-hidden="true">
    <svg class="assembler__svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <g class="assembler__links">
        ${edges.map((edge) => `<line class="assembler__link" pathLength="1"
            x1="${edge.from.x}" y1="${edge.from.y}" x2="${edge.to.x}" y2="${edge.to.y}"
            style="--delay:${edge.delay.toFixed(2)}s" />`).join('')}
      </g>
      <g class="assembler__nodes">
        ${active.map((seat, index) => `<circle
            class="assembler__node assembler__node--${seat.kind}"
            cx="${seat.x}" cy="${seat.y}" r="${seat.r}"
            style="--delay:${(index * 0.16).toFixed(2)}s" />`).join('')}
      </g>
    </svg>
  </div>`;
}

/** Three connected pips, one word each. */
function pips(status) {
  const reached = STAGES.findIndex(([key]) => key === status);
  return `<ol class="pips">${STAGES.map(([, label], index) => {
    let state = 'todo';
    if (index < reached) state = 'done';
    else if (index === reached) state = status === 'ready' ? 'done' : 'active';
    return `<li class="pip" data-state="${state}">
      <span class="pip__dot" aria-hidden="true">${state === 'done' ? icon('check', { size: 11 }) : ''}</span>
      <span class="pip__label">${esc(label)}</span>
    </li>`;
  }).join('')}</ol>`;
}

/**
 * The map URL for a new tab, focused on the network that was just deployed.
 * `focus` is read back by views/map.js (its FOCUS_PARAM) to introduce that pin.
 */
function mapUrlFor(deploymentId) {
  const url = new URL('/app/', location.origin);
  url.searchParams.set('focus', deploymentId);
  url.hash = 'map';
  return url.toString();
}

/**
 * Show the operator their map. Always ends up somewhere — never a dead end.
 *
 * A new tab is preferred but cannot be relied on: `window.open` only succeeds while
 * the page holds transient activation, and a build outlives that by a long way, so a
 * browser is entitled to block it — which it does, and which is why this used to look
 * like nothing happening. When it is blocked the current tab navigates to the map
 * instead. Same-document navigation is never blocked, so the operator lands on their
 * map either way.
 *
 * @returns {'tab'|'same-tab'} which route was taken.
 */
function showMap(deploymentId) {
  const url = mapUrlFor(deploymentId);
  try {
    // No 'noopener': the handle is what tells us the open succeeded, and it lets the
    // new tab be focused. The target is same-origin, so nothing is exposed.
    const opened = window.open(url, '_blank');
    if (opened && !opened.closed) {
      opened.focus?.();
      return 'tab';
    }
  } catch { /* blocked; fall through to the guaranteed route */ }
  window.location.assign(url);
  return 'same-tab';
}

/**
 * @param {object} view - the DeploymentView returned by POST /deployments.
 * @param {() => void} [onSettled] - called once the build reaches a terminal state,
 *   so the caller can refresh anything showing deployments.
 */
export function showDeployProgress(view, { onSettled } = {}) {
  let status = view.status;
  let network = view.network || null;
  let warnings = view.warnings || [];
  let error = view.error || '';
  let activity = '';
  let closed = false;
  const startedAt = Date.now();

  let body = null;
  let controls = null;
  let tick = null;
  // When this deployment actually started building, as opposed to when it was
  // accepted. The two differ whenever the build queue is busy.
  let buildingSince = status === 'building' ? Date.now() : null;

  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
  const building = () => Math.round((Date.now() - (buildingSince ?? Date.now())) / 1000);
  const settled = () => status === 'ready' || status === 'failed' || status === 'stopped';

  /**
   * The countdown, in words.
   *
   * Counts 20 → 0 and then stops counting. It deliberately does not sit on "0s", go
   * negative, or restart: the estimate is honest about a warm build but a cold one
   * takes minutes, and a clock frozen at zero is exactly how a working build comes to
   * look like a hung one.
   *
   * It also counts from when the build STARTED, not from upload. The service builds
   * MAX_CONCURRENT_BUILDS at a time (2 by default), so several people uploading at
   * once are queued — measured at 9/18/27/35s for eight uploads against two slots,
   * and far longer for networks that fetch tools. Counting from upload told the last
   * person in the queue "about 20s left" while they had a minute to wait, which is
   * exactly the kind of false promise this dialog exists to avoid.
   */
  function clockLabel() {
    if (status === 'queued') return 'waiting for a free build slot…';
    const spent = buildingSince ? building() : elapsed();
    const remaining = ESTIMATE_SECONDS - spent;
    if (remaining > 0) return `about ${remaining}s left`;
    if (spent > WARM_BUILD_SECONDS) return 'first run — this one takes longer';
    return 'almost there…';
  }

  function paint() {
    if (!body) return;
    if (status === 'ready') return paintReady();
    if (status === 'failed' || status === 'stopped') return paintFailed();
    paintBuilding();
  }

  /**
   * "This replaced the one you already had."
   *
   * Said on every panel rather than only on success, because the fact that an
   * existing network was taken down is true from the moment the upload is accepted
   * — including when the rebuild then fails, which is exactly when somebody needs
   * to know that the previous version is no longer serving.
   *
   * Reassurance, not a warning: the URL and the map pin are deliberately preserved,
   * so anything already linked to this network keeps working. Saying so is the
   * difference between "it replaced my network" reading as a loss or as an update.
   */
  function replacedNote() {
    if (!view.replaced) return '';
    const org = view.org_name?.trim();
    return `<p class="lreplaced">
      ${icon('refresh', { size: 13 })}<span>Replaced the existing
      <strong>${esc(displayName(view.name))}</strong>${org ? ` in ${esc(org)}` : ''} —
      same URL and same place on the map, so existing connections to it still
      work.</span></p>`;
  }

  // Building: the loader, three words, one short line of what is happening, a clock.
  // Nothing else — there is no decision to make here, so there is nothing to read.
  function paintBuilding() {
    render(body, `
      ${loaderArt({ agents: network?.agent_count, tools: network?.hostable_tools?.length })}
      ${pips(status)}
      <p class="lnow">${esc(activity || 'Setting things up…')}</p>
      <p class="lclock">${esc(clockLabel())}</p>
      ${replacedNote()}`);
  }

  // Held for a beat so success registers, then the dialog closes itself and the map
  // opens. No buttons: the next step happens on its own.
  function paintReady() {
    render(body, `
      <div class="ltick" aria-hidden="true">${icon('check', { size: 30 })}</div>
      <p class="lbig">${esc(displayName(view.name))} is live</p>
      ${pips('ready')}
      <p class="lnow">Opening your map…</p>
      ${replacedNote()}`);
  }

  // The one panel that must stay and must carry text: it is the only report of a
  // failed build, and the reason is the whole point of it.
  function paintFailed() {
    render(body, `
      <div class="ltick ltick--err" aria-hidden="true">${icon('close', { size: 28 })}</div>
      <p class="lbig">Couldn’t deploy ${esc(displayName(view.name))}</p>
      <p class="lnow lnow--err">${esc(error || 'The build did not finish.')}</p>
      <div class="lactions">
        <button type="button" class="btn btn--primary btn--block" data-close-launch>
          ${icon('upload', { size: 15 })}<span>Try another file</span>
        </button>
      </div>`);
  }

  const handle = openModal({
    // The network's own name, not a label about the app. It is the one piece of
    // context worth spending a heading on.
    title: displayName(view.name),
    // While the build runs this dialog is the only report of how it went, so a stray
    // backdrop click must not discard it. Re-enabled the moment it settles.
    dismissible: false,
    render(target, close, { setDismissible }) {
      body = target;
      // Centres and spaces every panel, so each paint only supplies content.
      target.classList.add('launchbody');
      controls = { close, setDismissible };
      paint();

      // Delegated, because the body is re-rendered on every poll. Only the failure
      // panel has a control: success needs none, it closes itself.
      target.addEventListener('click', (event) => {
        if (event.target.closest('[data-close-launch]')) close();
      });

      // Keeps the elapsed seconds and the cold-build note truthful between polls.
      tick = setInterval(() => { if (!settled()) paint(); }, 1000);
      watch();

      return () => {
        closed = true;
        clearInterval(tick);
      };
    },
  });

  /** Poll until the build settles, then hand over to the map. */
  async function watch() {
    while (!closed && !settled()) {
      try {
        const { status: code, data } = await api.waitOnce(view.id, WAIT_SECONDS);
        if (closed) return;
        // Start the countdown the first time this deployment is actually building,
        // so time spent queued behind other people's builds is not counted against
        // the estimate. /wait can also settle straight to `ready` from `queued` on a
        // fast build, so this has to tolerate never seeing `building` at all.
        if (!buildingSince && data.status !== 'queued') buildingSince = Date.now();
        status = data.status;
        network = data.network || network;
        warnings = data.warnings || warnings;
        error = data.error || error;
        view.url = data.url || view.url;
        if (code !== 504) break; // settled
        await tailLog();
      } catch (requestError) {
        if (closed) return;
        // A 404 means the record is gone; anything else is likely transient, so the
        // loop retries rather than declaring a healthy build dead.
        if (requestError instanceof ApiError && requestError.status === 404) {
          status = 'failed';
          error = 'The deployment record disappeared before the build finished.';
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (closed) return;
    finish();
  }

  async function tailLog() {
    try {
      const { lines } = await api.logs(view.id, LOG_TAIL);
      const next = lastUsefulLine(lines);
      if (next) activity = next;
    } catch {
      /* the child may not have written yet; the next poll retries */
    }
  }

  function finish() {
    clearInterval(tick);
    // The wait is over, so the dialog is safe to dismiss again.
    controls?.setDismissible(true);
    handle?.setDismissible?.(true);
    paint();
    onSettled?.();

    if (status !== 'ready') {
      toast.error(`${displayName(view.name)} could not be deployed.`);
      return;
    }

    // Caveats would have gone unread in a dialog that closes itself, so they are
    // announced instead of printed — the detail lives in Manage deployments.
    if (warnings.length) {
      toast.error(`${displayName(view.name)} is live, with ${warnings.length} `
        + `caveat${warnings.length === 1 ? '' : 's'} — see Manage deployments.`);
    } else {
      toast.ok(`${displayName(view.name)} is live.`);
    }

    // Hold the tick briefly, then close and show the map. Closing first means the
    // same-tab fallback does not navigate away from a dialog still on screen.
    setTimeout(() => {
      if (closed) return;
      controls?.close();
      showMap(view.id);
    }, SUCCESS_FLASH_MS);
  }
}
