/**
 * Organic scatter for map markers.
 *
 * nsdeploy_service/layout.py places every network on a slot from a 15x11 lattice. That
 * guarantees no two pins stack, but at event scale the regularity is the first thing a
 * reader sees: 100 markers lined up in rows and columns read as a table laid over the
 * city, not as networks standing in it. This nudges each marker off its slot so the
 * rows break up, while keeping the lattice underneath as the thing that prevents
 * collisions.
 *
 * DETERMINISTIC, which is the whole point. The offset is derived from the deployment
 * id, never Math.random and never the render index, so a marker sits in exactly the
 * same spot on every repaint, in every browser, for every reader — the same contract
 * layout.py exists to protect ("a map whose pins rearrange ... is not a map") and the
 * same reason components/mapArt.js seeds its buildings and trees. The 5s poll repaints
 * this view constantly; anything else would make the map crawl.
 *
 * NOT PERSISTED. The offset is applied at render time and the stored position is left
 * alone, so supervisor.py's start-up repair — which re-places any position
 * `layout.is_on_grid()` rejects — still sees the clean slot it put there and leaves it
 * be. Storing scattered coordinates would have them repaired away on every boot.
 */

/** FNV-1a, 32-bit. Small, stable across engines, and good enough to decorrelate ids. */
export function hash32(value) {
  let h = 0x811c9dc5;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // The classic 16777619 multiply, via shifts, to stay inside 32 bits.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Half the lattice step is 2.5% across and 3.5% down. Staying inside these keeps the
// worst case — two neighbouring pins both displaced towards each other — at ~1.8%
// apart across. On its own that is close enough for two neighbours drifting towards
// each other to touch, which is why relax() below exists: the jitter is allowed to be
// generous, and the collision pass takes back only as much of it as it has to.
// Vertical gets the wider spread because the lattice rows are 7% apart against the
// columns' 5%.
const SPREAD_X = 1.6;
const SPREAD_Y = 2.2;

// GEOMETRY, IN PIXELS. An earlier version of this did the comparison in the artwork's
// 1600x900 "units" and declared a 38-unit gap collision-free. That was wrong, and
// measurably so: a unit is only a pixel if the stage happens to be 1600 wide. On a
// 1200px stage it is 0.75px, so 38 units is 28px — under the marker — and the closest
// pair on a real 100-network map measured 19.5px to 29.8px depending on window width,
// which is exactly the overlap a reader reported seeing.
//
// Percent-to-pixel is the only honest conversion, and it needs the stage's real size.
// Hence the dimensions parameter: this module stays DOM-free, the caller measures.
const DEFAULT_STAGE = { width: 1200, height: 600 };

// Fallback only. The caller measures the real marker and passes it in; this is what
// gets used before any pin exists to measure.
//
// At tight density the teardrop is 1.6rem = 25.6px square (border-box, so the 2.5px
// ring is inside that), rotated 45 degrees — which inflates its axis-aligned bounding
// box to 25.6 * sqrt(2) = 36.2px. Rounded up a little for the shadow.
//
// Only a fallback: markerFootprint() in views/map.js measures the real thing, which is
// what catches a stylesheet change this constant would not. An earlier value of 36px
// was *below* the rotated bounding box, so markers touched no matter how well the
// separation pass converged.
const DEFAULT_MARKER_PX = 38;

// Air between two markers, on top of their footprint, so a pair reads as two separate
// things rather than as two that happen not to intersect.
const MARKER_GAP_PX = 6;

// More passes than before: pushing in pixel space has further to move things, and a
// pass can only resolve half of each overlap.
const RELAX_PASSES = 24;

// At event scale, use the land instead of trying to resolve a hundred markers inside
// the smaller persisted lattice envelope. Eight staggered rows alternating 13 and 12
// positions give exactly 100 slots. The half-step rows break the spreadsheet look and
// keep diagonal neighbours farther apart than a square grid would.
//
// This is render-time only: the server's persisted positions are still authoritative
// for smaller maps and remain untouched. Assignment is deterministic and independent
// of API response order.
const CROWDED_AT = 80;
const CROWDED_ROWS = 8;
const COASTAL_MIN_X = 22.5;
const COASTAL_MAX_X = 94.5;
const FULL_LAND_MIN_X = 5;
const FULL_LAND_MAX_X = 95;
const CROWDED_MIN_Y = 7;
const CROWDED_MAX_Y = 93;

// The artwork's water occupies roughly the left 18% (see components/mapArt.js), and a
// marker centred past ~92% hangs off the right edge. Rows are held clear of the top
// and bottom so a balloon and its status ring are never clipped.
const MIN_X = 20;
const MAX_X = 92;
const MIN_Y = 10;
const MAX_Y = 84;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** A usable coordinate: a real number, not null, undefined, '' or a word. */
const isCoordinate = (value) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

/**
 * The offset for one id, as a fraction of the spread in each axis.
 *
 * Two independent draws from one hash: the low bits drive x and the high bits y, so a
 * marker is not pushed along a diagonal. Each lands in -1..1.
 */
export function offsetFor(id) {
  const h = hash32(id);
  const fx = ((h & 0xffff) / 0xffff) * 2 - 1;
  const fy = (((h >>> 16) & 0xffff) / 0xffff) * 2 - 1;
  return { fx, fy };
}

/**
 * One node's rendered position: its stored slot, nudged, clamped to the drawable area.
 *
 * Nodes without usable coordinates are returned untouched — the caller still has to
 * render them, and a NaN would put the marker at the top-left corner.
 */
export function scatterNode(node) {
  // Number(null) and Number('') are both 0, which is finite — so a node whose
  // coordinates are absent would otherwise be "nudged" from an implied origin and
  // clamped to the top-left water edge instead of being left alone.
  if (!isCoordinate(node?.x) || !isCoordinate(node?.y)) return node;
  const x = Number(node.x);
  const y = Number(node.y);
  const { fx, fy } = offsetFor(node.id);
  return {
    ...node,
    x: clamp(x + fx * SPREAD_X, MIN_X, MAX_X),
    y: clamp(y + fy * SPREAD_Y, MIN_Y, MAX_Y),
  };
}

/**
 * Push apart any pair of markers closer than MIN_SEPARATION.
 *
 * The lattice in layout.py is already collision-free — columns are 80 units apart and
 * rows 63, against a ~38-unit marker. It is the jitter above that can close that gap,
 * by displacing two neighbours towards each other. Rather than shrink the jitter until
 * the worst case is safe (which would flatten the scatter back towards the grid the
 * lattice look was there to break), the overlap is simply undone where it happens.
 *
 * DETERMINISTIC, which is the whole contract of this module. The pass is ordered by
 * node id, not by the order /graph happened to return, so the same set of networks
 * relaxes to the same picture however the API sorted them. Nothing here consults
 * Math.random or an index.
 *
 * Mutates the array it is given; callers pass a freshly mapped copy.
 */
function relax(points, stage, separation, bounds = {
  minX: MIN_X, maxX: MAX_X, minY: MIN_Y, maxY: MAX_Y,
}) {
  // Percent of the stage per pixel, per axis. Working in pixels and converting back is
  // what makes one threshold mean the same thing in both directions.
  const pctPerPxX = 100 / Math.max(1, stage.width);
  const pctPerPxY = 100 / Math.max(1, stage.height);
  const pxPerPctX = stage.width / 100;
  const pxPerPctY = stage.height / 100;

  // Fixed order, independent of the caller's. Two readers whose /graph responses
  // differ only in row order must still see identical maps.
  const order = points
    .map((point, index) => ({ index, id: String(point.id ?? index) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => entry.index);

  for (let pass = 0; pass < RELAX_PASSES; pass += 1) {
    let moved = false;
    for (let a = 0; a < order.length; a += 1) {
      for (let b = a + 1; b < order.length; b += 1) {
        const p = points[order[a]];
        const q = points[order[b]];
        if (!p.movable || !q.movable) continue;

        const dxPx = (q.x - p.x) * pxPerPctX;
        const dyPx = (q.y - p.y) * pxPerPctY;
        const distance = Math.hypot(dxPx, dyPx);
        if (distance >= separation) continue;

        // Exactly coincident points have no direction to separate along. Nudge on a
        // fixed axis rather than a random one, so the result stays reproducible.
        const [ux, uy] = distance < 1e-6 ? [1, 0] : [dxPx / distance, dyPx / distance];
        // Half each, so neither marker is favoured and the pair ends up centred on
        // where it already was.
        const push = (separation - distance) / 2;

        p.x = clamp(p.x - ux * push * pctPerPxX, bounds.minX, bounds.maxX);
        p.y = clamp(p.y - uy * push * pctPerPxY, bounds.minY, bounds.maxY);
        q.x = clamp(q.x + ux * push * pctPerPxX, bounds.minX, bounds.maxX);
        q.y = clamp(q.y + uy * push * pctPerPxY, bounds.minY, bounds.maxY);
        moved = true;
      }
    }
    if (!moved) break;   // already clear; the remaining passes would do nothing
  }
  return points;
}

/** The fixed 100-position field used by a crowded map. */
function crowdedSlots(bounds) {
  const slots = [];
  for (let row = 0; row < CROWDED_ROWS; row += 1) {
    const columns = row % 2 === 0 ? 13 : 12;
    const fullStep = (bounds.maxX - bounds.minX) / 12;
    const inset = columns === 12 ? fullStep / 2 : 0;
    const start = bounds.minX + inset;
    const end = bounds.maxX - inset;
    const y = bounds.minY
      + (row * (bounds.maxY - bounds.minY)) / (CROWDED_ROWS - 1);
    for (let column = 0; column < columns; column += 1) {
      const x = columns === 1 ? start : start + (column * (end - start)) / (columns - 1);
      slots.push({ x, y });
    }
  }
  return slots;
}

/**
 * Move a crowded set onto the full-land field while keeping each network near its
 * persisted neighbourhood.
 *
 * Nodes are assigned in persisted-position order, not response order. Each takes the
 * nearest unused slot, so links retain their broad direction while the whole set gains
 * the unused right, top and bottom of the map. With 100 nodes every slot is occupied;
 * with 80-99, the persisted spread decides which gaps remain.
 */
function spreadAcrossLand(nodes, bounds) {
  if (nodes.length < CROWDED_AT || nodes.length > 100) return nodes;
  const slots = crowdedSlots(bounds);
  const order = nodes
    .map((node, index) => ({
      index,
      x: Number(node.x),
      y: Number(node.y),
      id: String(node.id ?? index),
      movable: isCoordinate(node.x) && isCoordinate(node.y),
    }))
    .filter((entry) => entry.movable)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));

  const out = [...nodes];
  for (const entry of order) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < slots.length; i += 1) {
      const dx = slots[i].x - entry.x;
      const dy = slots[i].y - entry.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    const [slot] = slots.splice(best, 1);
    out[entry.index] = { ...out[entry.index], x: slot.x, y: slot.y };
  }
  return out;
}

/**
 * The closest two markers actually end up, in pixels.
 *
 * Reported rather than assumed, because the relaxation cannot always reach the
 * separation it was asked for. Measured on a 860x460 stage, a hundred markers plateau
 * around 39px however many passes run — they simply do not fit at full size, and the
 * boundary clamps stop the interior pressure escaping. Knowing what was *achieved* is
 * what lets the caller shrink the markers to match, which is the only way the
 * no-overlap promise holds at every window size rather than just the roomy ones.
 */
export function closestPairPx(nodes, stage = DEFAULT_STAGE) {
  const width = Number(stage?.width) > 0 ? Number(stage.width) : DEFAULT_STAGE.width;
  const height = Number(stage?.height) > 0 ? Number(stage.height) : DEFAULT_STAGE.height;
  const usable = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => isCoordinate(node?.x) && isCoordinate(node?.y));
  let worst = Infinity;
  for (let a = 0; a < usable.length; a += 1) {
    for (let b = a + 1; b < usable.length; b += 1) {
      const dx = ((usable[b].x - usable[a].x) / 100) * width;
      const dy = ((usable[b].y - usable[a].y) / 100) * height;
      const distance = Math.hypot(dx, dy);
      if (distance < worst) worst = distance;
    }
  }
  return worst;
}

/**
 * scatterNode across a node list, preserving order, with overlaps resolved.
 *
 * Order is preserved because the caller renders in this order and the edge layer reads
 * node ids positionally; only the relaxation's *internal* iteration is re-sorted.
 */
export function scatterNodes(nodes, stage = DEFAULT_STAGE) {
  const size = {
    width: Number(stage?.width) > 0 ? Number(stage.width) : DEFAULT_STAGE.width,
    height: Number(stage?.height) > 0 ? Number(stage.height) : DEFAULT_STAGE.height,
  };
  // `marker` is the real rendered footprint when the caller has a pin to measure. The
  // separation has to be at least the footprint or the markers intersect no matter how
  // well the relaxation converges — which is precisely the bug this replaced.
  const marker = Number(stage?.marker) > 0 ? Number(stage.marker) : DEFAULT_MARKER_PX;
  const separation = marker + MARKER_GAP_PX;
  const raw = Array.isArray(nodes) ? nodes : [];
  const crowded = raw.length >= CROWDED_AT && raw.length <= 100;
  const topInset = Number.isFinite(Number(stage?.topInset))
    ? clamp(Number(stage.topInset), CROWDED_MIN_Y, CROWDED_MAX_Y - 20)
    : CROWDED_MIN_Y;
  const crowdedBounds = {
    minX: stage?.fullLand ? FULL_LAND_MIN_X : COASTAL_MIN_X,
    maxX: stage?.fullLand ? FULL_LAND_MAX_X : COASTAL_MAX_X,
    minY: topInset,
    maxY: CROWDED_MAX_Y,
  };
  const list = spreadAcrossLand(raw.map(scatterNode), crowdedBounds);
  // Only nodes that actually got coordinates take part. One without them was passed
  // through untouched and has nothing to collide with.
  const points = list.map((node) => ({
    x: Number(node.x), y: Number(node.y), id: node.id,
    movable: isCoordinate(node.x) && isCoordinate(node.y),
  }));
  relax(points, size, separation, crowded ? crowdedBounds : undefined);
  return list.map((node, index) => (points[index].movable
    ? { ...node, x: points[index].x, y: points[index].y }
    : node));
}
