/**
 * Tests for the map's organic scatter.
 *
 * The properties that matter are determinism (the 5s poll repaints constantly, and a
 * marker that moves between repaints makes the map unreadable) and containment (a
 * nudged marker must not end up in the water or off the frame).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closestPairPx, hash32, offsetFor, scatterNode, scatterNodes,
} from '../nsdeploy_service/ui/assets/js/util/scatter.js';

const node = (id, x, y) => ({ id, name: `net_${id}`, x, y });

test('the same id always hashes to the same value', () => {
  assert.equal(hash32('abc123'), hash32('abc123'));
});

test('different ids hash differently', () => {
  assert.notEqual(hash32('000000000001'), hash32('000000000002'));
});

test('hashing tolerates null and undefined', () => {
  assert.equal(typeof hash32(null), 'number');
  assert.equal(typeof hash32(undefined), 'number');
});

test('offsets land inside -1..1 on both axes', () => {
  for (let i = 0; i < 500; i += 1) {
    const { fx, fy } = offsetFor(`deployment_${i}`);
    assert.ok(fx >= -1 && fx <= 1, `fx out of range: ${fx}`);
    assert.ok(fy >= -1 && fy <= 1, `fy out of range: ${fy}`);
  }
});

test('the two axes are not correlated, so pins do not run along a diagonal', () => {
  // x and y come from different halves of the hash. If they were the same draw,
  // every offset would sit on the fx === fy line.
  const ids = Array.from({ length: 200 }, (_, i) => `net_${i}`);
  const identical = ids.filter((id) => {
    const { fx, fy } = offsetFor(id);
    return Math.abs(fx - fy) < 1e-9;
  });
  assert.equal(identical.length, 0);
});

test('a node keeps its position across repeated renders', () => {
  const original = node('a1b2c3', 42, 40);
  const first = scatterNode(original);
  const second = scatterNode(original);
  assert.deepEqual({ x: first.x, y: first.y }, { x: second.x, y: second.y });
});

test('the offset actually moves the node off its slot', () => {
  // Otherwise the lattice is still a lattice. A handful of ids could legitimately
  // hash to near-zero, so this asserts on the population, not on one node.
  const moved = Array.from({ length: 100 }, (_, i) => {
    const before = node(`net_${i}`, 52, 40);
    const after = scatterNode(before);
    return Math.abs(after.x - before.x) > 0.2 || Math.abs(after.y - before.y) > 0.2;
  });
  assert.ok(moved.filter(Boolean).length > 90, 'most pins should leave their slot');
});

test('scattered nodes stay out of the water and inside the frame', () => {
  // Worst case: a slot at the very edge of the grid, pushed further out.
  const edges = [
    node('left', 22, 12), node('right', 91, 82),
    node('topright', 91, 12), node('bottomleft', 22, 82),
  ];
  for (const original of edges) {
    const moved = scatterNode(original);
    assert.ok(moved.x >= 20, `${original.id} drifted into the water at x=${moved.x}`);
    assert.ok(moved.x <= 92, `${original.id} overflowed at x=${moved.x}`);
    assert.ok(moved.y >= 10 && moved.y <= 84, `${original.id} clipped at y=${moved.y}`);
  }
});

test('every slot on the real grid stays containable', () => {
  // The actual lattice from layout.py, so a future grid change that pushes a column
  // past the clamp shows up here rather than on the map.
  const COLUMNS = [22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 86, 91];
  const ROWS = [12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82];
  let i = 0;
  for (const x of COLUMNS) {
    for (const y of ROWS) {
      const moved = scatterNode(node(`slot_${i += 1}`, x, y));
      assert.ok(moved.x >= 20 && moved.x <= 92, `x=${moved.x} from ${x}`);
      assert.ok(moved.y >= 10 && moved.y <= 84, `y=${moved.y} from ${y}`);
    }
  }
});

test('nodes without usable coordinates are passed through untouched', () => {
  for (const bad of [{ id: 'a' }, { id: 'b', x: null, y: null },
    { id: 'c', x: 'nope', y: 12 }]) {
    assert.deepEqual(scatterNode(bad), bad);
  }
});

test('scatterNodes preserves order and length', () => {
  const rows = [node('a', 22, 12), node('b', 42, 40), node('c', 91, 82)];
  const out = scatterNodes(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((n) => n.id), ['a', 'b', 'c']);
});

test('scatterNodes tolerates a missing or malformed list', () => {
  assert.deepEqual(scatterNodes(undefined), []);
  assert.deepEqual(scatterNodes(null), []);
});

test('100 networks on one grid keep distinguishable positions', () => {
  // The grid guarantees distinct slots; the scatter must not collapse two of them
  // onto the same point.
  const COLUMNS = [22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 86, 91];
  const ROWS = [12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82];
  const nodes = [];
  let i = 0;
  outer: for (const y of ROWS) {
    for (const x of COLUMNS) {
      nodes.push(node(`net_${i += 1}`, x, y));
      if (nodes.length === 100) break outer;
    }
  }
  const points = new Set(scatterNodes(nodes).map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`));
  assert.equal(points.size, 100);
});

test('100 networks use the full safe land area instead of clustering in the old envelope', () => {
  const out = scatterNodes(latticeNodes(100), { width: 1200, height: 600, marker: 38 });
  const xs = out.map((n) => n.x);
  const ys = out.map((n) => n.y);
  assert.ok(Math.min(...xs) <= 22.5, `left edge was unused: ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) >= 94.5, `right edge was unused: ${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) <= 7, `top edge was unused: ${Math.min(...ys)}`);
  assert.ok(Math.max(...ys) >= 93, `bottom edge was unused: ${Math.max(...ys)}`);
});

test('full-land mode reclaims the former water area', () => {
  const out = scatterNodes(latticeNodes(100), {
    width: 1200, height: 600, marker: 38, fullLand: true,
  });
  const xs = out.map((n) => n.x);
  assert.ok(Math.min(...xs) <= 5, `former water area was unused: ${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) >= 95, `right edge was unused: ${Math.max(...xs)}`);
});

test('crowded layout reserves the measured search-bar area', () => {
  const out = scatterNodes(latticeNodes(100), {
    width: 1200, height: 600, marker: 38, fullLand: true, topInset: 18,
  });
  assert.ok(Math.min(...out.map((n) => n.y)) >= 18);
});

/* ── no overlapping markers ───────────────────────────────────────────────── */
// The guarantee, stated the way it is actually kept: markers are separated as far as
// the stage allows, and then SHRUNK to whatever spacing was achieved. Separation alone
// cannot do it — on a narrow stage a hundred markers plateau around 39px apart however
// long the relaxation runs, so demanding 48px there just fails quietly.
//
// Two earlier versions of these tests passed while the real map overlapped: the first
// measured in the artwork's 1600x900 "units" (a unit is only a pixel at one stage
// width), the second used a 32px marker when a 1.6rem drop rotated 45 degrees has a
// 36px bounding box before its badge. Both were confident and wrong.

const BASE_FOOTPRINT = 38;     // 1.6rem teardrop rotated 45deg: 25.6 x sqrt2, plus shadow
const PIN_SCALE_FLOOR = 0.55;
const PIN_CLEARANCE_PX = 4;

const COLUMNS = [22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 86, 91];
const ROWS = [12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82];

function latticeNodes(count) {
  const out = [];
  let i = 0;
  for (const y of ROWS) {
    for (const x of COLUMNS) {
      if (out.length === count) return out;
      out.push(node(`net_${i += 1}`, x, y));
    }
  }
  return out;
}

/** The runtime loop in views/map.js: scatter, measure, shrink, repeat. */
function settle(count, stage) {
  let scale = 1;
  let nodes = [];
  let gap = 0;
  let footprint = 0;
  for (let i = 0; i < 10; i += 1) {
    footprint = BASE_FOOTPRINT * scale;
    nodes = scatterNodes(latticeNodes(count), { ...stage, marker: footprint });
    gap = closestPairPx(nodes, stage);
    const room = Math.max(0, gap - PIN_CLEARANCE_PX);
    const next = Math.max(PIN_SCALE_FLOOR, Math.min(1, scale * (room / footprint)));
    if (Math.abs(next - scale) < 0.01) break;
    scale = next;
  }
  return { nodes, gap, footprint, scale };
}

const STAGES = [
  { width: 1600, height: 700 }, { width: 1400, height: 650 },
  { width: 1200, height: 600 }, { width: 1000, height: 520 },
  { width: 860, height: 460 }, { width: 700, height: 420 },
];

test('100 markers never overlap, at any stage size', () => {
  for (const stage of STAGES) {
    const { gap, footprint } = settle(100, stage);
    assert.ok(footprint <= gap,
      `${stage.width}x${stage.height}: ${footprint.toFixed(1)}px markers only `
      + `${gap.toFixed(1)}px apart`);
  }
});

test('a full 165-marker grid never overlaps either', () => {
  for (const stage of STAGES) {
    const { gap, footprint } = settle(165, stage);
    assert.ok(footprint <= gap,
      `${stage.width}x${stage.height}: ${footprint.toFixed(1)}px markers only `
      + `${gap.toFixed(1)}px apart`);
  }
});

test('a roomy stage keeps the markers at full size', () => {
  // Shrinking is a last resort, not the normal case: a wide window should show
  // full-size markers.
  const { scale } = settle(100, { width: 1600, height: 700 });
  assert.equal(scale, 1);
});

test('a roomy stage shows the teardrops at full size', () => {
  // Shrinking is the fallback, not the normal case. Anything from a laptop width up
  // should carry 100 markers without reducing them.
  for (const stage of STAGES.filter((s) => s.width >= 1000)) {
    assert.equal(settle(100, stage).scale, 1,
      `${stage.width}x${stage.height} should not have needed to shrink`);
  }
});

test('a cramped stage uses the expanded field without overlapping teardrops', () => {
  // The full-land field should buy enough separation that shrinking is only a last
  // resort, not the default response to a laptop-sized map.
  for (const stage of STAGES.filter((s) => s.width < 1000)) {
    const { scale, footprint, gap } = settle(100, stage);
    assert.ok(scale >= PIN_SCALE_FLOOR, `${stage.width}px: shrank past the floor`);
    assert.ok(footprint <= gap, `${stage.width}px: still overlapping`);
  }
});

test('the shrink loop converges instead of oscillating', () => {
  // Each pass must move the scale towards a fixed point; a loop that alternated would
  // make the markers pulse on screen every frame.
  for (const stage of STAGES) {
    const once = settle(100, stage).scale;
    const twice = settle(100, stage).scale;
    assert.equal(once, twice, `${stage.width}x${stage.height} did not settle`);
  }
});

test('separating markers keeps them all on the land', () => {
  for (const stage of STAGES) {
    for (const n of settle(165, stage).nodes) {
      assert.ok(n.x >= 20 && n.x <= 92, `x=${n.x} left the drawable area`);
      assert.ok(n.y >= 10 && n.y <= 84, `y=${n.y} left the drawable area`);
    }
  }
});

test('the result does not depend on the order the API returned', () => {
  const stage = { width: 1200, height: 600, marker: BASE_FOOTPRINT };
  const forward = latticeNodes(100);
  const reversed = [...forward].reverse();
  const a = new Map(scatterNodes(forward, stage).map((n) => [n.id, `${n.x.toFixed(4)},${n.y.toFixed(4)}`]));
  const b = new Map(scatterNodes(reversed, stage).map((n) => [n.id, `${n.x.toFixed(4)},${n.y.toFixed(4)}`]));
  for (const [id, pos] of a) assert.equal(b.get(id), pos, `${id} moved when the order changed`);
});

test('scattering is stable across repeated renders at one size', () => {
  const stage = { width: 1200, height: 600, marker: BASE_FOOTPRINT };
  const nodes = latticeNodes(100);
  const once = scatterNodes(nodes, stage).map((n) => `${n.x},${n.y}`);
  const twice = scatterNodes(nodes, stage).map((n) => `${n.x},${n.y}`);
  assert.deepEqual(once, twice);
});

test('scatterNodes does not mutate the nodes it was given', () => {
  const nodes = latticeNodes(20);
  const before = nodes.map((n) => `${n.x},${n.y}`);
  scatterNodes(nodes, { width: 1200, height: 600, marker: BASE_FOOTPRINT });
  assert.deepEqual(nodes.map((n) => `${n.x},${n.y}`), before);
});

test('a missing or nonsense stage size falls back instead of dividing by zero', () => {
  for (const bad of [undefined, null, {}, { width: 0, height: 0 }, { width: 'wide' }]) {
    const out = scatterNodes(latticeNodes(40), bad);
    assert.equal(out.length, 40);
    for (const n of out) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  }
});

test('closestPairPx reports Infinity when there is no pair', () => {
  assert.equal(closestPairPx([], { width: 1200, height: 600 }), Infinity);
  assert.equal(closestPairPx([node('solo', 50, 50)], { width: 1200, height: 600 }), Infinity);
});

test('markers still leave their exact lattice slots', () => {
  const stage = { width: 1200, height: 600, marker: BASE_FOOTPRINT };
  const nodes = latticeNodes(100);
  const out = scatterNodes(nodes, stage);
  const moved = out.filter((n, i) =>
    Math.abs(n.x - nodes[i].x) > 0.2 || Math.abs(n.y - nodes[i].y) > 0.2);
  assert.ok(moved.length > 85, `only ${moved.length} of 100 left their slot`);
});
