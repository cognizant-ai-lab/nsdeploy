import json
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.config import Settings
from nsdeploy_service.layout import (
    COLUMNS,
    ROWS,
    choose_position,
    is_on_grid,
    next_position,
)
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import Supervisor, summarize_build

MANIFEST_WITH_LINK = {
    "brand": "Travel Agency",
    "agent_mcp": {"front_man": "travel_concierge"},
    "networks": [{"description": "books trips", "sample_queries": []}],
    "linking": {
        "site": "http://127.0.0.1:8091",
        "imports": [
            {
                "network": "link_demo_travel_agency",
                "reference": "link_demo_airline",
                "callers": ["travel_concierge"],
                "status": "linked",
                "target": "http://127.0.0.1:8092/link_demo_airline",
            },
            {
                "network": "link_demo_travel_agency",
                "reference": "hotel_desk",
                "callers": ["travel_concierge"],
                "status": "pending",
            },
        ],
    },
}


class LayoutTest(unittest.TestCase):
    def test_first_node_is_deterministic(self):
        self.assertEqual(choose_position([]), choose_position([]))

    def test_every_position_sits_on_the_grid(self):
        position = choose_position([{"x": 50, "y": 50}])
        self.assertIn(position["x"], COLUMNS)
        self.assertIn(position["y"], ROWS)

    def test_successive_nodes_do_not_collide(self):
        placed = []
        for _ in range(12):
            placed.append(choose_position(placed))
        unique = {(p["x"], p["y"]) for p in placed}
        self.assertEqual(len(unique), len(placed), "each pin must get its own slot")

    def test_the_grid_holds_an_event_sized_map_without_stacking(self):
        # The hackathon deploys 80-100 networks into one map. At 88 slots, #89 landed
        # on top of an existing pin; every one of them must get its own slot.
        placed = []
        for _ in range(100):
            placed.append(choose_position(placed))
        unique = {(p["x"], p["y"]) for p in placed}
        self.assertEqual(len(unique), 100, "100 networks must not share slots")

    def test_grid_capacity_leaves_headroom_above_the_event_target(self):
        self.assertGreaterEqual(len(COLUMNS) * len(ROWS), 150)

    def test_moves_away_from_an_occupied_corner(self):
        # With one pin top-left, the next should not land beside it.
        first = {"x": COLUMNS[0], "y": ROWS[0]}
        second = choose_position([first])
        self.assertGreater(
            abs(second["x"] - first["x"]) + abs(second["y"] - first["y"]), 20)

    def test_next_position_tolerates_missing_positions(self):
        # Records predating the position column arrive as None.
        position = next_position([None, {"x": 8, "y": 10}, None])
        self.assertIn(position["x"], COLUMNS)

    def test_ignores_malformed_entries(self):
        position = choose_position([{"x": None, "y": None}, "nonsense", {}])
        self.assertIn(position["y"], ROWS)

    def test_grid_starts_inland_so_pins_never_sit_in_the_water(self):
        # The artwork's coastline occupies roughly the left 18%; a pin centred any
        # further left would hang over the sea.
        self.assertGreaterEqual(min(COLUMNS), 20)

    def test_is_on_grid_accepts_current_slots_and_rejects_everything_else(self):
        self.assertTrue(is_on_grid({"x": COLUMNS[0], "y": ROWS[0]}))
        # An old off-grid slot — e.g. from before the coastline moved.
        self.assertFalse(is_on_grid({"x": 8, "y": 10}))
        for bad in (None, {}, "nope", {"x": 22}, {"x": "a", "y": "b"}):
            with self.subTest(bad=bad):
                self.assertFalse(is_on_grid(bad))


class ResolvedLinkCaptureTest(unittest.TestCase):
    """Edges come from `linking.imports` where status == linked."""

    def _summary(self, manifest, network=None):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "agent-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (out / "net.network.json").write_text(
                json.dumps(network or {"tools": [], "link_slots": {}}), encoding="utf-8")
            return summarize_build(out, "net", "")

    def test_captures_only_linked_imports(self):
        summary = self._summary(MANIFEST_WITH_LINK)
        self.assertEqual(len(summary.links), 1)
        link = summary.links[0]
        self.assertEqual(link.reference, "link_demo_airline")
        self.assertEqual(link.target, "http://127.0.0.1:8092/link_demo_airline")
        self.assertEqual(link.callers, ["travel_concierge"])

    def test_pending_imports_are_not_edges(self):
        summary = self._summary(MANIFEST_WITH_LINK)
        self.assertNotIn("hotel_desk", [link.reference for link in summary.links])

    def test_no_linking_section_yields_no_links(self):
        summary = self._summary({"agent_mcp": {"front_man": "x"}, "networks": [{}]})
        self.assertEqual(summary.links, [])

    def test_linked_import_without_a_target_is_skipped(self):
        manifest = {
            "agent_mcp": {"front_man": "x"}, "networks": [{}],
            "linking": {"imports": [{"reference": "r", "status": "linked"}]},
        }
        self.assertEqual(self._summary(manifest).links, [])


class GraphProjectionTest(unittest.TestCase):
    """/graph turns records + resolved links into nodes and edges."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(work_root=Path(self._tmp.name),
                                 port_start=8800, port_end=8809)
        self.supervisor = Supervisor(self.settings)

    def tearDown(self):
        self.supervisor.store.close()
        self._tmp.cleanup()

    def _ready(self, name, links=()):
        dep = self.supervisor.create(b"x", DeployOptions(name=name))
        row = dep.as_row()
        row.update({
            "status": "ready",
            "url": f"http://127.0.0.1:{dep.port}",
            "network_json": json.dumps({
                "front_man": f"{name}_boss", "agent_count": 3,
                "hostable_tools": ["t1"], "link_slots": [],
                "links": [{"reference": r, "target": t, "callers": ["c"]}
                          for r, t in links],
            }),
        })
        self.supervisor.store.save_deployment(row)
        return dep

    def test_assigns_and_persists_a_position_on_create(self):
        dep = self.supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertIsNotNone(dep.position)
        stored = self.supervisor.store.get_deployment(dep.id)["position"]
        self.assertEqual(stored, dep.position)

    def test_two_deployments_get_different_positions(self):
        first = self.supervisor.create(b"x", DeployOptions(name="a"))
        second = self.supervisor.create(b"x", DeployOptions(name="b"))
        self.assertNotEqual((first.position["x"], first.position["y"]),
                            (second.position["x"], second.position["y"]))

    def test_position_is_not_moved_by_a_later_write(self):
        # The pin must stay put across rebuilds and restarts.
        dep = self.supervisor.create(b"x", DeployOptions(name="demo"))
        original = dict(dep.position)
        row = dep.as_row()
        row["position_json"] = json.dumps({"x": 99, "y": 99})
        self.supervisor.store.save_deployment(row)
        self.assertEqual(self.supervisor.store.get_deployment(dep.id)["position"], original)

    def test_edge_is_built_when_a_target_matches_another_deployment(self):
        airline = self._ready("airline")
        self._ready("agency", links=[("airline", f"http://127.0.0.1:{airline.port}/airline")])

        rows = self.supervisor.store.list_deployments()
        by_origin = {r["url"]: r["id"] for r in rows if r["url"]}
        edges = []
        for row in rows:
            for link in (row.get("network") or {}).get("links") or []:
                target = link["target"].rsplit("/", 1)[0]
                if by_origin.get(target):
                    edges.append((row["id"], by_origin[target]))

        self.assertEqual(len(edges), 1)
        self.assertEqual(edges[0][1], airline.id)

    def test_a_target_outside_this_service_produces_no_edge(self):
        self._ready("agency", links=[("peer", "http://10.0.0.9:9000/peer")])
        rows = self.supervisor.store.list_deployments()
        by_origin = {r["url"]: r["id"] for r in rows if r["url"]}
        matched = [
            link for row in rows
            for link in ((row.get("network") or {}).get("links") or [])
            if by_origin.get(link["target"].rsplit("/", 1)[0])
        ]
        self.assertEqual(matched, [], "an off-service peer cannot be a node on this map")


class GridCapacityTest(unittest.TestCase):
    """The grid must hold every network the service will run at once.

    Regression: the grid was 48 slots while MAX_DEPLOYMENTS allowed more, so past
    the 48th deployment choose_position returned an already-occupied slot and pins
    stacked on top of each other. The two numbers have to stay related, which is
    what this pins.
    """

    def test_grid_has_a_slot_for_every_allowed_deployment(self):
        from nsdeploy_service.layout import COLUMNS, ROWS
        slots = len(COLUMNS) * len(ROWS)
        self.assertGreaterEqual(
            slots, Settings().max_deployments,
            f"the map grid has {slots} slots but the service allows "
            f"{Settings().max_deployments} live networks; the excess would stack")

    def test_no_two_networks_share_a_slot_up_to_capacity(self):
        from nsdeploy_service.layout import choose_position
        placed = []
        for _ in range(Settings().max_deployments):
            placed.append(choose_position(placed))
        keys = [(p["x"], p["y"]) for p in placed]
        self.assertEqual(len(set(keys)), len(keys), "two pins landed on the same slot")

    def test_positions_already_in_use_are_still_recognised(self):
        """Growing the grid must not reposition pins that are already placed."""
        from nsdeploy_service.layout import COLUMNS, is_on_grid
        previous_rows = (12, 26, 40, 54, 68, 82)
        for y in previous_rows:
            for x in COLUMNS:
                self.assertTrue(is_on_grid({"x": x, "y": y}), f"({x},{y}) would be moved")


class PositionBackfillTest(unittest.TestCase):
    """Records predating the position column must be given a stable position once.

    Regression: with no stored position, /graph re-derived coordinates on every read,
    so adding a deployment silently rearranged the existing pins.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._supervisors = []

    def tearDown(self):
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self) -> Supervisor:
        supervisor = Supervisor(Settings(work_root=self.root, port_start=8850, port_end=8869))
        self._supervisors.append(supervisor)
        return supervisor

    def _strip_positions(self, supervisor):
        for row in supervisor.store.list_deployments():
            supervisor.store._conn.execute(
                "UPDATE deployments SET position_json = NULL WHERE id = ?", (row["id"],))
        supervisor.store._conn.commit()

    def test_backfills_missing_positions_at_startup(self):
        first = self._supervisor()
        ids = [first.create(b"x", DeployOptions(name=f"n{i}")).id for i in range(3)]
        self._strip_positions(first)
        self.assertEqual(sorted(first.store.deployments_without_position()), sorted(ids))
        first.store.close()

        second = self._supervisor()
        self.assertEqual(sorted(second.backfilled_positions), sorted(ids))
        self.assertEqual(second.store.deployments_without_position(), [])
        for deployment_id in ids:
            self.assertIsNotNone(second.store.get_deployment(deployment_id)["position"])

    def test_backfilled_positions_are_distinct(self):
        first = self._supervisor()
        for i in range(4):
            first.create(b"x", DeployOptions(name=f"n{i}"))
        self._strip_positions(first)
        first.store.close()

        second = self._supervisor()
        placed = {
            (row["position"]["x"], row["position"]["y"])
            for row in second.store.list_deployments()
        }
        self.assertEqual(len(placed), 4)

    def test_existing_pins_do_not_move_when_a_new_one_is_added(self):
        # The guarantee the regression broke.
        supervisor = self._supervisor()
        existing = [supervisor.create(b"x", DeployOptions(name=f"n{i}")) for i in range(3)]
        before = {
            row["id"]: row["position"]
            for row in supervisor.store.list_deployments()
        }

        supervisor.create(b"x", DeployOptions(name="newcomer"))

        after = {row["id"]: row["position"] for row in supervisor.store.list_deployments()}
        for dep in existing:
            self.assertEqual(after[dep.id], before[dep.id], f"{dep.name} moved")

    def test_backfill_is_a_no_op_when_nothing_is_missing(self):
        supervisor = self._supervisor()
        supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertEqual(supervisor._backfill_positions(), [])

    def test_repositions_a_pin_that_is_no_longer_on_the_grid(self):
        # Changing the grid (the coastline moved) must re-place stranded pins only.
        first = self._supervisor()
        stranded = first.create(b"x", DeployOptions(name="stranded"))
        settled = first.create(b"x", DeployOptions(name="settled"))
        settled_position = dict(settled.position)
        first.store.set_position(stranded.id, {"x": 8, "y": 10})  # an off-grid slot
        first.store.close()

        second = self._supervisor()
        self.assertEqual(second.backfilled_positions, [stranded.id])
        moved = second.store.get_deployment(stranded.id)["position"]
        self.assertTrue(is_on_grid(moved))
        self.assertEqual(
            second.store.get_deployment(settled.id)["position"], settled_position,
            "a pin already on the grid must not be moved")


class HealthWarningTest(unittest.TestCase):
    """Reconciliation is a startup statistic, never a warning.

    Regression: it was reported in `warnings`, which describes *ongoing* conditions.
    Because supervisor.orphaned never clears, every /health poll re-reported it, and
    the console toasted each warning on a 15s timer — producing an endless stream of
    undismissable error toasts for a routine housekeeping event.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._supervisors = []

    def tearDown(self):
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _settings(self) -> Settings:
        return Settings(work_root=self.root, port_start=8880, port_end=8899)

    def _supervisor(self) -> Supervisor:
        supervisor = Supervisor(self._settings())
        self._supervisors.append(supervisor)
        return supervisor

    def _health(self):
        """Call the real endpoint, so this tests the projection and not a stub."""
        from fastapi.testclient import TestClient

        from nsdeploy_service.app import create_app

        with TestClient(create_app(self._settings())) as client:
            response = client.get("/health")
            self.assertEqual(response.status_code, 200)
            return response.json()

    def test_reconciliation_is_counted_not_warned(self):
        first = self._supervisor()
        dep = first.create(b"x", DeployOptions(name="demo"))  # left queued
        first.store.close()
        self._supervisors.remove(first)

        health = self._health()

        self.assertEqual(health["reconciled_at_startup"], 1,
                         f"expected {dep.id} to be counted as reconciled")
        self.assertEqual(health["warnings"], [],
                         "a one-off startup event must not appear as an ongoing warning")
        # And it must not leak back in as free text anywhere in the payload.
        self.assertNotIn("did not survive", json.dumps(health))

    def test_nothing_reported_when_there_was_nothing_to_reconcile(self):
        health = self._health()
        self.assertEqual(health["reconciled_at_startup"], 0)
        self.assertEqual(health["warnings"], [])

    def test_repeated_polls_never_add_warnings(self):
        # The flood came from a poll re-reporting a startup event every 15s.
        first = self._supervisor()
        first.create(b"x", DeployOptions(name="demo"))
        first.store.close()
        self._supervisors.remove(first)

        from fastapi.testclient import TestClient

        from nsdeploy_service.app import create_app

        with TestClient(create_app(self._settings())) as client:
            for poll in range(4):
                payload = client.get("/health").json()
                self.assertEqual(payload["warnings"], [], f"poll {poll} raised a warning")
                self.assertEqual(payload["reconciled_at_startup"], 1)

    def test_health_model_defaults_the_new_field(self):
        from nsdeploy_service.models import HealthView

        view = HealthView(status="ok", version="0", python="3", platform="test",
                          deployments={}, port_pool={})
        self.assertEqual(view.reconciled_at_startup, 0)
        self.assertEqual(view.warnings, [])


class MapRefreshSettingTest(unittest.TestCase):
    def test_defaults_to_two_minutes(self):
        self.assertEqual(Settings().map_refresh_seconds, 60)

    def test_reads_the_environment_override(self):
        import os

        os.environ["NSDEPLOY_SERVICE_MAP_REFRESH_SECONDS"] = "45"
        try:
            self.assertEqual(Settings.from_env().map_refresh_seconds, 45)
        finally:
            del os.environ["NSDEPLOY_SERVICE_MAP_REFRESH_SECONDS"]

    def test_rejects_an_absurdly_short_interval(self):
        with self.assertRaises(ValueError):
            Settings(map_refresh_seconds=1).validate()


if __name__ == "__main__":
    unittest.main()
