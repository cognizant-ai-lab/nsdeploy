/**
 * Decorative backdrop for the launch screen: a multi-agent network, drawn.
 *
 * WHY. The launch screen is the first thing anyone sees and it was a form on an
 * empty page — a dot grid and a faint wash. Nothing on it said what the product
 * makes. This puts the thing being deployed behind the thing that deploys it: a
 * front-man delegating to coordinators, coordinators to specialists, specialists
 * out to tools and a linked peer network. Somebody who has never used nsdeploy can
 * see the shape of an agent network before reading a word.
 *
 * IT IS SCENERY, AND IT BEHAVES LIKE IT:
 *   · aria-hidden and pointer-events: none — never focusable, never in the tab
 *     order, never announced. It is not a diagram of anyone's actual network.
 *   · Every tone comes from --accent and the surface tokens, so it themes with the
 *     console and cannot drift from the palette.
 *   · Contrast is kept far below the form's. The card sits on top of it opaque;
 *     the text beside it reads against the page, not against the art.
 *   · Deterministic geometry. Hand-placed nodes, no Math.random: the view remounts
 *     on every tab switch and a reshuffling backdrop would flicker.
 *
 * MOTION. Pulses travel along the edges, which is what an agent network actually
 * does — a request handed down the tree and an answer handed back. Slow (7s),
 * staggered, and dropped entirely under prefers-reduced-motion (see components.css);
 * the static picture has to stand on its own, so it does.
 */

export const ART_W = 1200;
export const ART_H = 760;

/* Nodes, in the order they are drawn. `kind` selects the size and treatment:
 *   front  — the front-man, the one node with a filled halo
 *   hub    — a coordinator that delegates further
 *   leaf   — a specialist agent
 *   tool   — a hosted tool, drawn as a square rather than a circle
 *   peer   — another deployed network, drawn hollow and dashed
 * Positions are deliberate: the tree opens left-to-right so it reads as flow, and
 * the dense side sits where the launch card will cover it at wide sizes. */
const NODES = {
  front: { x: 150, y: 372, kind: 'front', glyph: '◈' },
  intake: { x: 352, y: 150, kind: 'hub' },
  plan: { x: 372, y: 372, kind: 'hub' },
  book: { x: 352, y: 596, kind: 'hub' },
  research: { x: 574, y: 74, kind: 'leaf' },
  guard: { x: 600, y: 198, kind: 'leaf' },
  budget: { x: 592, y: 300, kind: 'leaf' },
  itinerary: { x: 580, y: 400, kind: 'leaf' },
  compose: { x: 596, y: 496, kind: 'leaf' },
  flights: { x: 592, y: 596, kind: 'leaf' },
  stays: { x: 566, y: 698, kind: 'leaf' },
  search: { x: 810, y: 122, kind: 'tool' },
  rag: { x: 828, y: 250, kind: 'tool' },
  fetch: { x: 836, y: 384, kind: 'tool' },
  rates: { x: 822, y: 542, kind: 'tool' },
  book_tool: { x: 800, y: 664, kind: 'tool' },
  peer: { x: 1040, y: 300, kind: 'peer' },
  peer2: { x: 1024, y: 552, kind: 'peer' },
};
/* Edges as [from, to, curve] where curve bows the line — a fan of straight
 * spokes reads as a diagram, a fan of arcs reads as a drawing. */
const EDGES = [
  ['front', 'intake', -52],
  ['front', 'plan', 0],
  ['front', 'book', 52],
  ['intake', 'research', -26],
  ['intake', 'guard', 20],
  ['plan', 'budget', -24],
  ['plan', 'itinerary', 0],
  ['plan', 'compose', 24],
  ['book', 'flights', -22],
  ['book', 'stays', 24],
  ['research', 'search', -20],
  ['guard', 'rag', 16],
  ['budget', 'rag', -14],
  ['itinerary', 'fetch', 0],
  ['compose', 'fetch', -16],
  ['flights', 'rates', 18],
  ['stays', 'book_tool', -16],
  ['search', 'peer', 22],
  ['rag', 'peer', -14],
  ['rates', 'peer2', 18],
  ['book_tool', 'peer2', -20],
];

const SIZE = { front: 21, hub: 13, leaf: 8.5, tool: 8, peer: 15 };

/** A quadratic arc between two nodes, bowed by `curve` px perpendicular. */
function arc(from, to, curve) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular offset, so the bow is always across the line's own direction.
  const cx = mx + (-dy / len) * curve;
  const cy = my + (dx / len) * curve;
  return `M${from.x},${from.y} Q${cx.toFixed(1)},${cy.toFixed(1)} ${to.x},${to.y}`;
}

export function networkArt() {
  const edges = EDGES.map(([a, b, curve], i) => {
    const d = arc(NODES[a], NODES[b], curve);
    // Each pulse is offset so the network never flashes in unison.
    const delay = (i * 0.42).toFixed(2);
    return `<path class="nart__edge" d="${d}" />`
      + `<path class="nart__pulse" d="${d}" style="--pulse-delay:${delay}s" />`;
  }).join('');

  const nodes = Object.values(NODES).map((node) => {
    const r = SIZE[node.kind];
    if (node.kind === 'tool') {
      // Tools are square: a hosted tool is not an agent, and the silhouette says
      // so without a legend.
      return `<rect class="nart__node nart__node--tool" x="${node.x - r}" y="${node.y - r}"
        width="${r * 2}" height="${r * 2}" rx="4" />`;
    }
    const cls = `nart__node nart__node--${node.kind}`;
    const halo = node.kind === 'front'
      ? `<circle class="nart__halo" cx="${node.x}" cy="${node.y}" r="${r + 12}" />`
      : '';
    const glyph = node.glyph
      ? `<text class="nart__glyph" x="${node.x}" y="${node.y + 1}">${node.glyph}</text>`
      : '';
    return `${halo}<circle class="${cls}" cx="${node.x}" cy="${node.y}" r="${r}" />${glyph}`;
  }).join('');

  return `
<svg class="nart" viewBox="0 0 ${ART_W} ${ART_H}" preserveAspectRatio="xMidYMid slice"
     aria-hidden="true" focusable="false">
  <defs>
    <!-- The art fades out before it reaches the edges of its box, so it never
         ends on a hard line against the page. -->
    <radialGradient id="nart-fade" cx="40%" cy="50%" r="58%">
      <stop offset="0%" stop-color="#fff" stop-opacity="1" />
      <stop offset="48%" stop-color="#fff" stop-opacity="1" />
      <stop offset="100%" stop-color="#fff" stop-opacity="0" />
    </radialGradient>
    <mask id="nart-mask">
      <rect width="${ART_W}" height="${ART_H}" fill="url(#nart-fade)" />
    </mask>
  </defs>
  <!-- No full-bleed wash here, deliberately. A tinted rect behind the network
       lightened a 1158x609 area of the page by ~11 grey levels and, because its
       gradient had not reached zero by the time it met the clip box, ended on a
       straight edge — the backdrop read as a pale rectangle pasted over the
       page. Measured, not guessed. The page's own accent wash (see body in
       base.css) already provides the glow; the network only needs its lines. -->
  <g mask="url(#nart-mask)">
    <g class="nart__edges">${edges}</g>
    <g class="nart__nodes">${nodes}</g>
  </g>
</svg>`;
}
