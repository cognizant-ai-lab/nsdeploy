"""Map positions for deployed networks.

Positions are assigned once, at deploy time, and persisted. They are deliberately
*not* recomputed on read: a map whose pins rearrange every time somebody else deploys
is not a map. A force-directed layout was rejected for the same reason — it jitters on
every reload and nothing stays where the reader left it.

The algorithm is the clearance-maximising grid used by the Cailville town map
(nsdeploy/cailville.py::choose_position), minus that map's harbour exclusion zone and
its mobile-specific coordinates. Coordinates are percentages of the viewport, so the
map scales without re-layout.
"""
from __future__ import annotations

import math
from typing import Any
from typing import Dict
from typing import Iterable
from typing import List
from typing import Optional
from typing import Tuple

# Candidate slots, in percent of the map viewport.
#
# The left edge is water in the map artwork (see ui/assets/js/components/mapArt.js),
# so the grid starts inland at 22% — a pin is centred on its slot and would otherwise
# hang over the coastline. Rows stay clear of the top and bottom margins so a pin's
# label and status ring are never clipped.
# Grown from 8 columns by interleaving midpoints, for the same reason the rows were
# grown before: 11 x 8 = 88 slots, so with an event-scale 100 networks deployment #89
# landed on an occupied slot and stacked pins on top of each other.
#
# The earlier note here said extra columns collide before extra rows, because a pin's
# label is ~200px wide against a ~52px-tall pin. That holds at low counts but not at
# this scale: above 44 pins views/map.js switches the stage to density="tight", which
# hides the label entirely and shrinks the marker to ~1.6rem (~26px). A 5% column step
# is ~60px on a 1200px stage, so icon-only markers clear each other comfortably.
#
# These slots are only reached when the map is already crowded — choose_position
# maximises clearance, so a handful of networks still spread across the full width and
# never touch an interleaved column.
COLUMNS = (22, 27, 32, 37, 42, 47, 52, 57, 62, 67, 72, 77, 82, 86, 91)
# 11 rows x 15 columns = 165 slots, comfortably above the 100-network event target.
#
# Both axes were grown by interleaving rather than by re-spacing: every original value
# (columns 22/32/42/52/62/72/82/91, rows 12/26/40/54/68/82) is still here, so
# is_on_grid() still recognises pins already placed and none of them is repositioned by
# the start-up repair. Re-spacing evenly would have shuffled every existing map.
#
# Rows are deliberately left at 11. Interleaving them too would put rows 3.5% apart —
# ~25px on a 700px stage, which a ~26px tight-mode marker would overlap vertically.
ROWS = (12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82)
# Vertical space is scarcer than horizontal (labels are wide, rows are short), so
# distance is weighted to prefer spreading sideways before stacking.
VERTICAL_WEIGHT = 1.35


def _candidates() -> List[Tuple[int, int]]:
    return [(x, y) for y in ROWS for x in COLUMNS]


def choose_position(occupied: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    """Pick the free grid slot furthest from every already-placed node.

    `occupied` is any iterable of dicts with numeric "x"/"y". Ties break towards the
    top-left so the first few deployments land somewhere predictable rather than in a
    corner.
    """
    points = [
        (float(pos["x"]), float(pos["y"]))
        for pos in occupied
        if isinstance(pos, dict) and pos.get("x") is not None and pos.get("y") is not None
    ]

    def clearance(candidate: Tuple[int, int]) -> float:
        if not points:
            return math.inf
        return min(
            math.hypot(candidate[0] - x, (candidate[1] - y) * VERTICAL_WEIGHT)
            for x, y in points
        )

    best = max(_candidates(), key=lambda point: (clearance(point), -point[1], -point[0]))
    return {"x": best[0], "y": best[1]}


def next_position(existing: Iterable[Optional[Dict[str, Any]]]) -> Dict[str, int]:
    """choose_position over records that may not have a position yet."""
    return choose_position([pos for pos in existing if pos])


def is_on_grid(position: Optional[Dict[str, Any]]) -> bool:
    """True when a stored position is still a valid slot on the current grid.

    Pins are otherwise never moved. This exists so that changing the grid — because
    the artwork's coastline moved, say — can re-place only the pins that would now
    sit in the water, instead of either rearranging the whole map or leaving pins
    stranded off the land.
    """
    if not isinstance(position, dict):
        return False
    try:
        return int(position["x"]) in COLUMNS and int(position["y"]) in ROWS
    except (KeyError, TypeError, ValueError):
        return False
