/**
 * Cartographic backdrop for the network map: a flat street plan.
 *
 * It is deliberately *terrain only* — no invented district or place names, because a
 * district would imply a grouping the data does not have. The one label names the
 * water, which is scenery and claims nothing.
 *
 * WHY FLAT, after a detour through 3D. An isometric city was tried and removed. Two
 * things were wrong with it. It was laid over this plan's own coastline, parks and
 * curving roads, so the picture carried two incompatible idioms at once — a plan and
 * a model of the same place, neither winning. And massing competes with the markers:
 * a balloon over a lit rooftop has no quiet ground to sit on. The reference the map
 * is built to now is nsdeploy_service/sampleMap.png, which is flat for exactly that
 * reason — the street grid is scenery you read *through*, and every marker reads as
 * standing on a street rather than on a skyline.
 *
 * WHAT IS DRAWN, back to front:
 *   · ground, water and parkland — the only large shapes
 *   · arterials: thick warm ribbons, cased, forming the big blocks. The one warm
 *     note in the scenery, and what makes the plan read as a street map rather
 *     than a chart
 *   · minor streets: thin pale lines subdividing each block
 *   · building footprints: flat, low-contrast rectangles, the texture of a city
 *     seen from above
 *   · tree clusters along the avenues and around the parks
 *
 * QUIET ON PURPOSE. Markers are the subject, so every tone here sits close to the
 * ground colour and nothing in the scenery is saturated except the arterials.
 *
 * GEOMETRY. A 1600×900 user space stretched to the frame (preserveAspectRatio
 * "none"), so percentages map linearly: x% → x·16, y% → y·9. Pin slots come from
 * nsdeploy_service/layout.py, which starts its columns at 22% because the water
 * occupies roughly the left 18% — that contract is why the coastline keeps its
 * shape and position.
 *
 * DETERMINISTIC. The footprints and trees come from a seeded generator, never
 * Math.random: the artwork is rebuilt on every repaint, and a random city would
 * reshuffle itself under the reader's cursor.
 */

export const ART_WIDTH = 1600;
export const ART_HEIGHT = 900;

/* mulberry32. Same seed, same city, every render and every reader. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The land starts here. Streets are drawn WEST of it as well and the coastline,
// painted after the grid, covers them — stopping them on this line instead left
// a seam of street-ends running down the map where the water begins.
const SHORE = 330;
const GRID_WEST = 170;

/* ── the grid ────────────────────────────────────────────────────────────────
 * Arterials are placed by hand so the big blocks stay a deliberate shape;
 * minor streets are stepped inside them.
 */
const AVENUES_Y = [148, 396, 640, 858];          // horizontal arterials
const AVENUES_X = [470, 800, 1130, 1450];        // vertical arterials
const STREET_STEP_X = 102;
const STREET_STEP_Y = 86;

function arterials() {
  const h = AVENUES_Y.map((y) => `M${GRID_WEST},${y} H${ART_WIDTH}`);
  const v = AVENUES_X.map((x) => `M${x},0 V${ART_HEIGHT}`);
  const paths = [...h, ...v];
  // Cased: the darker edge under the fill is what gives a road a kerb.
  return paths.map((d) => `<path class="mapart__avenue-edge" d="${d}" />`).join('')
    + paths.map((d) => `<path class="mapart__avenue" d="${d}" />`).join('');
}

function streets() {
  let out = '';
  for (let x = GRID_WEST + 40; x < ART_WIDTH; x += STREET_STEP_X) {
    if (AVENUES_X.some((ax) => Math.abs(ax - x) < 30)) continue;
    out += `<path class="mapart__street" d="M${x},0 V${ART_HEIGHT}" />`;
  }
  for (let y = 60; y < ART_HEIGHT; y += STREET_STEP_Y) {
    if (AVENUES_Y.some((ay) => Math.abs(ay - y) < 26)) continue;
    out += `<path class="mapart__street" d="M${GRID_WEST},${y} H${ART_WIDTH}" />`;
  }
  return out;
}

/* ── footprints ──────────────────────────────────────────────────────────────
 * Two or three flat rectangles per grid cell. This is the texture that makes a
 * plan read as a built-up city rather than as graph paper — it is why the
 * sample's blocks are full of pale grey shapes.
 */
function footprints() {
  const rand = seeded(20260929);
  let out = '';
  for (let cx = SHORE + 46; cx < ART_WIDTH - 20; cx += STREET_STEP_X) {
    for (let cy = 24; cy < ART_HEIGHT - 40; cy += STREET_STEP_Y) {
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i += 1) {
        const w = 14 + rand() * 32;
        const h = 11 + rand() * 26;
        const x = cx + rand() * (STREET_STEP_X - w - 16);
        const y = cy + rand() * (STREET_STEP_Y - h - 14);
        // Nothing on an arterial, and nothing in the water.
        if (x < SHORE + 10) continue;
        if (AVENUES_X.some((ax) => x + w > ax - 14 && x < ax + 14)) continue;
        if (AVENUES_Y.some((ay) => y + h > ay - 12 && y < ay + 12)) continue;
        const r = rand() < 0.3 ? 3 : 1;
        out += `<rect class="mapart__foot" x="${x.toFixed(1)}" y="${y.toFixed(1)}"`
          + ` width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" />`;
      }
    }
  }
  return out;
}

/* Tree clusters: a few overlapping circles read as canopy from above. */
function trees() {
  const rand = seeded(4242);
  const clusters = [
    [1290, 150, 8], [1420, 210, 7], [1520, 120, 5],   // north park
    [1120, 700, 8], [1230, 760, 7], [1330, 700, 5],   // south-east park
    [470, 800, 6], [560, 840, 5],                     // south-west park
  ];
  let out = '';
  for (const [x, y, n] of clusters) {
    for (let i = 0; i < n; i += 1) {
      const r = 7 + rand() * 5;
      out += `<circle class="mapart__tree" cx="${(x + (rand() - 0.5) * 70).toFixed(1)}"`
        + ` cy="${(y + (rand() - 0.5) * 54).toFixed(1)}" r="${r.toFixed(1)}" />`;
    }
  }
  // A thinner line of street trees down two of the avenues.
  for (const y of [AVENUES_Y[1] + 26, AVENUES_Y[2] + 26]) {
    for (let x = SHORE + 70; x < ART_WIDTH - 40; x += 68) {
      if (rand() < 0.3) continue;
      out += `<circle class="mapart__tree mapart__tree--street"`
        + ` cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(4.5 + rand() * 2).toFixed(1)}" />`;
    }
  }
  return out;
}

export function mapArt() {
  return `
<svg class="mapart" viewBox="0 0 ${ART_WIDTH} ${ART_HEIGHT}" preserveAspectRatio="none"
     aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="mg-land" x1="18%" y1="0%" x2="82%" y2="100%">
      <stop class="mg-stop-land-hi" offset="0%" />
      <stop class="mg-stop-land" offset="65%" />
    </linearGradient>
    <linearGradient id="mg-sea" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop class="mg-stop-sea-hi" offset="0%" />
      <stop class="mg-stop-sea" offset="55%" />
      <stop class="mg-stop-sea-deep" offset="100%" />
    </linearGradient>
    <radialGradient id="mg-park" cx="38%" cy="30%" r="75%">
      <stop class="mg-stop-park-hi" offset="0%" />
      <stop class="mg-stop-park" offset="100%" />
    </radialGradient>
    <radialGradient id="mg-sun" cx="16%" cy="6%" r="60%">
      <stop class="mg-stop-sun-hi" offset="0%" />
      <stop class="mg-stop-sun-lo" offset="100%" />
    </radialGradient>
    <filter id="mg-shadow-sm" x="-40%" y="-40%" width="180%" height="220%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#0b1220" flood-opacity="0.14" />
    </filter>
    <!-- A whisper of paper grain so the plan reads as a printed map rather than a
         flat vector fill. Static: motion here would read as sensor noise. -->
    <filter id="mg-grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="noise" />
      <feColorMatrix in="noise" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0" />
    </filter>
  </defs>

  <rect class="mapart__land" width="${ART_WIDTH}" height="${ART_HEIGHT}" fill="url(#mg-land)" />

  <!-- parkland, under the grid so streets cross it -->
  <path class="mapart__park" fill="url(#mg-park)"
    d="M1178,74 C1330,42 1540,92 1600,196 L1600,300 C1420,268 1272,282 1160,222 Z" />
  <path class="mapart__park" fill="url(#mg-park)"
    d="M1006,650 C1150,592 1340,634 1404,784 C1280,856 1100,860 972,800 Z" />
  <path class="mapart__park" fill="url(#mg-park)"
    d="M404,752 C498,714 610,726 666,802 C578,854 464,852 392,814 Z" />

  <!-- the street grid -->
  <g class="mapart__grid">${arterials()}${streets()}</g>

  <!-- built-up texture, then canopy over it -->
  <g class="mapart__foots">${footprints()}</g>
  <g class="mapart__trees">${trees()}</g>

  <!-- coastline down the left. Its shape and position are a contract with
       layout.py's 22% first column: pins must land on ground. -->
  <path class="mapart__sea" fill="url(#mg-sea)"
    d="M0,0 H236 C258,132 212,254 268,372 C322,486 292,590 214,672
       C150,740 78,788 0,812 Z" />
  <path class="mapart__deep"
    d="M0,0 H104 C150,176 112,352 178,492 C232,606 160,700 0,730 Z" />
  <path class="mapart__shore"
    d="M228,0 C250,130 206,252 262,376 C314,488 286,582 208,668
       L246,694 C332,600 350,486 302,368 C250,246 296,128 274,0 Z" />
  <path class="mapart__glint" d="M40,60 C120,40 200,72 300,44" />
  <path class="mapart__glint" d="M20,140 C110,116 210,150 320,118" />

  <!-- piers and wave hatching -->
  <path class="mapart__pier" filter="url(#mg-shadow-sm)" d="M232,650 L64,764" />
  <path class="mapart__pier" filter="url(#mg-shadow-sm)" d="M222,700 L92,828" />
  <path class="mapart__wave" d="M30,252 C82,226 128,274 180,248" />
  <path class="mapart__wave" d="M20,320 C76,294 126,342 184,316" />
  <path class="mapart__wave" d="M28,392 C84,366 134,414 192,388" />
  <path class="mapart__wave" d="M38,462 C94,436 144,484 202,458" />

  <rect class="mapart__grain" width="${ART_WIDTH}" height="${ART_HEIGHT}" filter="url(#mg-grain)" />
  <rect class="mapart__sun" width="${ART_WIDTH}" height="${ART_HEIGHT}" fill="url(#mg-sun)" />
  <text class="mapart__water" x="44" y="168">Open Water</text>
</svg>`;
}
