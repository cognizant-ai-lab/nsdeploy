/**
 * "What is this network wired to?" — one network's peer connections, both ways,
 * with the URL each one actually uses.
 *
 * NOT the same thing as components/networkGraphModal.js, which draws a network's
 * own *internal* agent call graph from /deployments/{id}/graph. This is one level
 * up: which other deployed networks this one calls, and which ones call it.
 *
 * A node-link graph, with the subject in the middle, outbound peers fanning right
 * and inbound fanning left — so every arrow's direction is readable from the layout
 * alone. The URL is NOT drawn on the edges: on a hosted install it is ~70
 * characters and would swamp the picture. It is on each node's tooltip and spelled
 * out in the list underneath, so "via which URL" stays answerable without the
 * diagram becoming unreadable.
 *
 * Computed from the deployment list the caller already has, not fetched: every row
 * carries its own outbound calls (`links` for slot-bound ones, `peer_urls` for
 * inline URLs — see models.py), and inbound is the same data read from the other
 * direction. So this needs no endpoint and stays correct for unpublished networks,
 * which /graph omits.
 */
import { esc, icon, render } from '../util/dom.js';
import { displayName } from '../util/format.js';
import { openModal } from './modal.js';

/** Scheme + host + port, or '' — the identity a peer URL is matched on. */
function originOf(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/** Every outbound call a row declares, however it was written in the HOCON. */
function outboundOf(dep) {
  return [...(dep?.network?.links || []), ...(dep?.network?.peer_urls || [])];
}

/**
 * `{ outbound, inbound }` for one network, resolved against the whole estate.
 *
 * An outbound call whose target is not a network here is kept and marked external
 * rather than dropped: it is a real connection to a peer run elsewhere, and a
 * diagram that silently omitted it would claim this network calls nothing.
 */
export function peerGraphFor(dep, deployments) {
  const byOrigin = new Map();
  (deployments || []).forEach((other) => {
    const origin = originOf(other.url);
    if (origin) byOrigin.set(origin, other);
  });

  const outbound = outboundOf(dep).map((link) => {
    const peer = byOrigin.get(originOf(link.target));
    return {
      url: link.target,
      reference: link.reference || '',
      callers: link.callers || [],
      peer: peer && peer.id !== dep.id ? peer : null,
      external: !peer || peer.id === dep.id,
    };
  });

  const mine = originOf(dep.url);
  const inbound = [];
  (deployments || []).forEach((other) => {
    if (!mine || other.id === dep.id) return;
    outboundOf(other).forEach((link) => {
      if (originOf(link.target) !== mine) return;
      inbound.push({
        url: link.target,
        reference: link.reference || '',
        callers: link.callers || [],
        peer: other,
      });
    });
  });
  return { outbound, inbound };
}

/**
 * Lay the peers out around the subject and draw the edges.
 *
 * Absolutely-positioned nodes over an SVG edge layer, which is the same shape as
 * views/map.js: the SVG's viewBox is set to the container's measured pixel size so
 * arrowheads are not skewed by a stretched square viewBox, and the edges are drawn
 * only once the nodes have real boxes to measure from.
 *
 * Outbound fan right, inbound fan left, subject in the middle — so the direction of
 * every arrow is readable from the layout before anyone looks at an arrowhead. The
 * URL is deliberately NOT an edge label: on a hosted install it is ~70 characters
 * and would swamp the picture. It appears on hover and in the list underneath, so
 * the question "via which URL" is always answerable without ever being in the way.
 */
const NODE_W = 132;
const ROW_H = 58;

function layout(outbound, inbound, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const column = (entries, side) => {
    const span = Math.max((entries.length - 1) * ROW_H, 0);
    const top = cy - span / 2;
    return entries.map((entry, index) => ({
      entry,
      side,
      x: side === 'out' ? width - NODE_W / 2 - 8 : NODE_W / 2 + 8,
      y: top + index * ROW_H,
    }));
  };
  return {
    subject: { x: cx, y: cy },
    peers: [...column(outbound, 'out'), ...column(inbound, 'in')],
  };
}

function edgePath(from, to) {
  // A gentle quadratic, bowed away from the straight line so two edges to nearby
  // nodes stay distinguishable.
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2 + (to.y - from.y) * 0.08;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} `
    + `Q ${mx.toFixed(1)} ${my.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function nodeLabel(entry) {
  return entry.peer ? displayName(entry.peer.name)
    : (originOf(entry.url) || 'elsewhere');
}

/** Draw into `host`, then keep it in step with its own size. */
function drawGraph(host, dep, outbound, inbound) {
  const paint = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    const { subject, peers } = layout(outbound, inbound, width, height);

    const edges = peers.map((node, index) => {
      const from = node.side === 'out' ? subject : node;
      const to = node.side === 'out' ? node : subject;
      // Stop short of each box so the arrowhead lands beside a node, not under it.
      const dx = to.x - from.x;
      const inset = Math.sign(dx) * (NODE_W / 2 + 6);
      return `<path class="pgraph__edge" data-edge="${index}"
        d="${edgePath({ x: from.x + (node.side === 'out' ? inset : 0), y: from.y },
                      { x: to.x - (node.side === 'out' ? inset : -inset), y: to.y })}"
        marker-end="url(#pg-arrow)" />`;
    }).join('');

    host.innerHTML = `
      <svg class="pgraph__svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <defs>
          <marker id="pg-arrow" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill="currentColor" />
          </marker>
        </defs>
        ${edges}
      </svg>
      <div class="pgraph__node pgraph__node--self"
           style="left:${subject.x}px; top:${subject.y}px">
        ${esc(displayName(dep.name))}
      </div>
      ${peers.map((node, index) => `
        <div class="pgraph__node${node.entry.external ? ' pgraph__node--ext' : ''}"
             data-node="${index}" style="left:${node.x}px; top:${node.y}px"
             title="${esc(node.entry.url)}">
          <span class="pgraph__dir">${node.side === 'out' ? 'calls' : 'called by'}</span>
          <span class="pgraph__name">${esc(nodeLabel(node.entry))}</span>
        </div>`).join('')}`;

    // Hovering a node lifts its own edge out of the rest. Pure class toggling, so
    // it survives a repaint without any stored state.
    host.querySelectorAll('[data-node]').forEach((element) => {
      const edge = host.querySelector(`[data-edge="${element.dataset.node}"]`);
      const on = (state) => () => {
        host.classList.toggle('is-tracing', state);
        element.classList.toggle('is-active', state);
        edge?.classList.toggle('is-active', state);
      };
      element.addEventListener('mouseenter', on(true));
      element.addEventListener('mouseleave', on(false));
    });
  };

  paint();
  // The dialog can be resized by the window; edges are measured in pixels, so they
  // have to be redrawn rather than scaled.
  const observer = new ResizeObserver(paint);
  observer.observe(host);
  return () => observer.disconnect();
}

/** The readable index of every connection, with the URL that is not on the graph. */
function connectionList(outbound, inbound) {
  const line = (entry, direction) => {
    const slot = entry.reference && entry.reference !== entry.url ? entry.reference : '';
    const callers = (entry.callers || []).filter(Boolean);
    return `
      <li class="wire__peer${entry.external ? ' wire__peer--ext' : ''}">
        <div class="wire__peerhead">
          <span class="wire__dir">${direction === 'out' ? '→' : '←'}</span>
          <span class="wire__peername">${esc(nodeLabel(entry))}</span>
          ${entry.external ? '<span class="wire__tag">not on this service</span>' : ''}
          ${slot ? `<span class="wire__slot">${esc(slot)}</span>` : ''}
        </div>
        <code class="wire__url">${esc(entry.url)}</code>
        ${callers.length ? `<span class="wire__via">${
          direction === 'out' ? 'called by' : 'calls'} ${esc(callers.join(', '))}</span>` : ''}
      </li>`;
  };
  return `<ul class="wire__list">
    ${outbound.map((e) => line(e, 'out')).join('')}
    ${inbound.map((e) => line(e, 'in')).join('')}
  </ul>`;
}

export function showPeerGraph(dep, deployments) {
  const { outbound, inbound } = peerGraphFor(dep, deployments);
  const name = displayName(dep.name);

  openModal({
    title: `${name} — connections`,
    size: 'lg',
    render(body, close) {
      render(body, `
        <p class="field__hint">
          Which networks ${esc(name)} calls, which ones call it, and the URL each
          connection uses. Read from every network's own configuration, so it
          includes ones that are not on the map yet.
        </p>

        ${outbound.length || inbound.length ? `
          <div class="pgraph" id="pg-host"></div>
          <h3 class="wire__title">Connections
            <span class="wire__count">${outbound.length + inbound.length}</span></h3>
          ${connectionList(outbound, inbound)}
        ` : `
          <p class="field__hint field__hint--warn">
            ${esc(name)} is not wired to anything yet. Use <strong>Connect</strong> in
            the network list to generate the prompt that adds a connection.
          </p>`}

        <div class="modal__foot">
          <button type="button" class="btn btn--secondary" data-close>Close</button>
        </div>`);

      const host = body.querySelector('#pg-host');
      // Returned so openModal tears the ResizeObserver down when the dialog closes.
      const stop = host ? drawGraph(host, dep, outbound, inbound) : null;

      body.querySelector('[data-close]').addEventListener('click', close);
      return stop || undefined;
    },
  });
}
