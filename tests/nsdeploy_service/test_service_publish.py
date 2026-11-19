"""Map visibility: when a deployed network becomes a pin.

With AUTOPUBLISH on (the service default) a launch is published on create, so the
pin is on the map while the build is still running — the console sends the operator
straight to the map and that is where the build is reported.

With AUTOPUBLISH off, the older draft workflow applies: deploying builds a *draft* —
live at its own URL, absent from the map — until its owner publishes it. Either way
only map visibility is affected; the directory and the deployment list show every
record, and /unpublish withdraws one.
"""
import asyncio
import json
import sqlite3
import tempfile
import unittest
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Set
from pathlib import Path
from unittest.case import _AssertRaisesContext

import httpx
from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.store import Store
from nsdeploy_service.supervisor import Deployment
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import Supervisor
from nsdeploy_service.supervisor import is_publishable
from nsdeploy_service.supervisor import publish_refusal


class PublishStateTest(unittest.TestCase):
    """Publishes, refuses and withdraws deployments through the supervisor."""
    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)
        self._supervisors: List[Supervisor] = []

    def tearDown(self) -> None:
        supervisor: Supervisor
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self, **overrides: Any) -> Supervisor:
        supervisor: Supervisor = Supervisor(Settings(work_root=self.root, port_start=8790,
                                                     port_end=8799, **overrides))
        self._supervisors.append(supervisor)
        return supervisor

    def _ready_row(self, supervisor: Supervisor, deployment_id: str = "dep1", status: str = "ready",
                   published: Optional[str] = None, ready_at: Optional[str] = "2026-09-23T22:00:05+00:00") -> None:
        org: Dict[str, Any] = supervisor.fallback_org
        work_dir: Path = self.root / deployment_id
        work_dir.mkdir(parents=True, exist_ok=True)
        supervisor.store.save_deployment({
            "id": deployment_id, "org_id": org["id"], "name": f"net_{deployment_id}",
            "status": status, "url": "http://127.0.0.1:8790", "port": 8790,
            "created_at": "2026-09-23T22:00:00+00:00",
            "ready_at": ready_at, "stopped_at": None,
            "expires_at": None, "error": None, "pid": 1,
            "network_json": json.dumps({"front_man": "front", "agent_count": 3}),
            "warnings_json": None, "log_path": str(work_dir / "nsdeploy.log"),
            "work_dir": str(work_dir), "published_at": published,
        })

    def test_a_new_deployment_is_published_on_create(self) -> None:
        """The default. The console sends the operator to the map on Launch, so the
        pin has to exist before the build finishes — waiting for `ready` meant a
        launch produced nothing visible for the length of the build."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        try:
            row: Optional[Dict[str, Any]] = supervisor.store.get_deployment(dep.id)
            self.assertIsNotNone(row["published_at"])
            # Also reported on the in-memory record, which is what POST /deployments
            # answers with before any row is re-read.
            self.assertEqual(dep.published_at, row["published_at"])
        finally:
            supervisor.ports.release(dep.port)

    def test_a_new_deployment_starts_as_a_draft_when_autopublish_is_off(self) -> None:
        """The draft workflow is still available, unchanged, behind one setting."""
        supervisor: Supervisor = self._supervisor(autopublish=False)
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        try:
            self.assertIsNone(supervisor.store.get_deployment(dep.id)["published_at"])
            self.assertIsNone(dep.published_at)
        finally:
            supervisor.ports.release(dep.port)

    def test_an_autopublished_deployment_can_still_be_withdrawn(self) -> None:
        """Auto-publishing must not be a one-way door: /unpublish still applies."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        try:
            self.assertIsNone(supervisor.unpublish(dep.id)["published_at"])
        finally:
            supervisor.ports.release(dep.port)

    def test_publishing_a_ready_deployment_stamps_it(self) -> None:
        """Publishing a ready deployment stamps it."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor)
        row: Dict[str, Any] = supervisor.publish("dep1")
        self.assertIsNotNone(row["published_at"])

    def test_publishing_is_idempotent_and_keeps_the_first_timestamp(self) -> None:
        """Publishing is idempotent and keeps the first timestamp."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor)
        first: str = supervisor.publish("dep1")["published_at"]
        again: str = supervisor.publish("dep1")["published_at"]
        self.assertEqual(first, again)

    def test_a_build_that_never_served_cannot_be_published(self) -> None:
        """A build that never served cannot be published."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor, status="failed", ready_at=None)
        caught: _AssertRaisesContext[DeploymentError]
        with self.assertRaises(DeploymentError) as caught:
            supervisor.publish("dep1")
        self.assertIn("never served", str(caught.exception))

    def test_a_stopped_deployment_cannot_be_published(self) -> None:
        """A pin on the map has to lead somewhere, so only a serving network goes on
        it. A service restart settles every record to `stopped`, so this is also the
        common case — hence the message says to restart rather than just refusing."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor, status="stopped")
        caught: _AssertRaisesContext[DeploymentError]
        with self.assertRaises(DeploymentError) as caught:
            supervisor.publish("dep1")
        self.assertIn("Restart it", str(caught.exception))

    def test_the_two_refusals_are_told_apart(self) -> None:
        """Deploy it, versus restart it — different remedies, different messages."""
        never: str = publish_refusal({"name": "n", "status": "failed", "ready_at": None})
        stopped: str = publish_refusal({"name": "n", "status": "stopped",
                                        "ready_at": "2026-09-23T22:00:00+00:00"})
        self.assertIn("Deploy n", never)
        self.assertIn("Restart it", stopped)
        self.assertNotIn("Restart", never)

    def test_publishable_is_reported_for_the_console(self) -> None:
        """Publishable is reported for the console."""
        self.assertTrue(is_publishable({"status": "ready", "published_at": None}))
        self.assertFalse(is_publishable({"status": "stopped", "published_at": None}))
        self.assertFalse(is_publishable({"status": "ready", "published_at": "t"}))

    def test_publishing_an_unknown_deployment_is_an_error(self) -> None:
        """Publishing an unknown deployment is an error."""
        supervisor: Supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.publish("nope")

    def test_unpublish_clears_it_and_is_idempotent(self) -> None:
        """Unpublish clears it and is idempotent."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor)
        supervisor.publish("dep1")
        self.assertIsNone(supervisor.unpublish("dep1")["published_at"])
        self.assertIsNone(supervisor.unpublish("dep1")["published_at"])

    def test_a_status_write_through_cannot_change_published_state(self) -> None:
        """The supervisor persists on every transition — building, ready, stopped,
        restarted. None of those may publish or unpublish anything, or a restart
        would demand the network be published again."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor)
        published: str = supervisor.publish("dep1")["published_at"]
        # Exactly what _teardown writes: same row, terminal status, no published_at.
        self._ready_row(supervisor, status="stopped")
        self.assertEqual(supervisor.store.get_deployment("dep1")["published_at"], published)

    def test_stopping_does_not_remove_a_network_from_the_map(self) -> None:
        """Stopping does not remove a network from the map."""
        supervisor: Supervisor = self._supervisor()
        self._ready_row(supervisor)
        supervisor.publish("dep1")
        self._ready_row(supervisor, status="stopped")
        row: Optional[Dict[str, Any]] = supervisor.store.get_deployment("dep1")
        self.assertEqual(row["status"], "stopped")
        self.assertIsNotNone(row["published_at"])


class PublishMigrationTest(unittest.TestCase):
    """Networks that predate the gate must stay on the map."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _legacy_database(self) -> Path:
        """A database created before published_at existed."""
        path: Path = self.root / "service.db"
        store: Store = Store(path)
        org: Dict[str, Any] = store.create_org("Acme")
        index: int
        status: str
        for index, status in enumerate(("ready", "failed")):
            store.save_deployment({
                "id": f"old{index}", "org_id": org["id"], "name": f"legacy{index}",
                "status": status, "url": "http://127.0.0.1:8100", "port": 8100,
                "created_at": "2026-09-01T00:00:00+00:00", "ready_at": None,
                "stopped_at": None, "expires_at": None, "error": None, "pid": None,
                "network_json": None, "warnings_json": None,
                "log_path": str(self.root / "l.log"), "work_dir": str(self.root),
            })
        store.close()
        # Drop the column so reopening exercises the real migration path.
        conn: sqlite3.Connection = sqlite3.connect(path)
        conn.execute("ALTER TABLE deployments DROP COLUMN published_at")
        conn.commit()
        conn.close()
        return path

    def test_existing_ready_networks_are_adopted_as_published(self) -> None:
        """Existing ready networks are adopted as published."""
        path: Path = self._legacy_database()
        store: Store = Store(path)
        try:
            self.assertIsNotNone(store.get_deployment("old0")["published_at"])
        finally:
            store.close()

    def test_every_pre_existing_record_is_adopted_whatever_its_status(self) -> None:
        """Before the gate the map had no publish filter, so every record was on it.
        Adopting only `ready` rows silently dropped pins — a graceful shutdown writes
        live records as `stopped` before exiting, so by the next start-up the rows to
        adopt were already `stopped` and the predicate matched nothing."""
        path: Path = self._legacy_database()
        store: Store = Store(path)
        try:
            self.assertIsNotNone(store.get_deployment("old1")["published_at"])
        finally:
            store.close()

    def test_a_stopped_legacy_record_is_still_adopted(self) -> None:
        """A stopped legacy record is still adopted."""
        path: Path = self._legacy_database()
        conn: sqlite3.Connection = sqlite3.connect(path)
        conn.execute("UPDATE deployments SET status='stopped'")
        conn.commit()
        conn.close()
        store: Store = Store(path)
        try:
            self.assertIsNotNone(store.get_deployment("old0")["published_at"])
        finally:
            store.close()

    def test_adoption_runs_once_and_does_not_publish_later_drafts(self) -> None:
        """The backfill happens when the column is created, not at every start-up —
        otherwise the next restart would publish every draft that was ready."""
        path: Path = self._legacy_database()
        store: Store = Store(path)
        org: Dict[str, Any] = store.list_orgs()[0]
        store.save_deployment({
            "id": "draft", "org_id": org["id"], "name": "fresh", "status": "ready",
            "url": "http://127.0.0.1:8101", "port": 8101,
            "created_at": "2026-09-23T23:00:00+00:00", "ready_at": None,
            "stopped_at": None, "expires_at": None, "error": None, "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(self.root / "l.log"), "work_dir": str(self.root),
        })
        store.close()

        reopened: Store = Store(path)
        try:
            self.assertIsNone(reopened.get_deployment("draft")["published_at"])
        finally:
            reopened.close()


class PublishEndpointTest(unittest.TestCase):
    """Gates map visibility on publish state through the real endpoints."""
    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)
        index: int
        for index in (0, 1):
            out_dir: Path = self.root / f"d{index}" / "site"
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"net{index}.network.json").write_text(
                json.dumps({"tools": [{"name": "front", "instructions": "x"}]}),
                encoding="utf-8")
            (self.root / f"d{index}" / "nsdeploy.log").write_text("", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _settings(self) -> Settings:
        return Settings(work_root=self.root, port_start=8780, port_end=8789)

    def _seed(self, supervisor: Supervisor) -> None:
        """Write the rows *after* start-up.

        Records do not survive a restart as `ready` — reconcile_orphans settles any
        live row at boot, which is correct and is why seeding before the app starts
        would leave every fixture `stopped` and unpublishable.
        """
        org: Dict[str, Any] = supervisor.fallback_org
        index: int
        for index in (0, 1):
            work_dir: Path = self.root / f"d{index}"
            supervisor.store.save_deployment({
                "id": f"d{index}", "org_id": org["id"], "name": f"net{index}",
                "status": "ready", "url": f"http://127.0.0.1:878{index}",
                "port": None, "created_at": f"2026-09-23T22:0{index}:00+00:00",
                "ready_at": f"2026-09-23T22:0{index}:05+00:00", "stopped_at": None,
                "expires_at": None, "error": None, "pid": None,
                "network_json": json.dumps({"front_man": "front", "agent_count": 1,
                                            "description": "d", "link_slots": []}),
                "warnings_json": None, "log_path": str(work_dir / "nsdeploy.log"),
                "work_dir": str(work_dir),
                "position_json": json.dumps({"x": 22 + index * 10, "y": 12}),
            })

    def _client(self) -> TestClient:
        return TestClient(create_app(self._settings()))

    def test_drafts_are_absent_from_the_map(self) -> None:
        """Drafts are absent from the map."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            graph: Dict[str, Any] = client.get("/graph").json()
            self.assertEqual(graph["nodes"], [])
            self.assertEqual(graph["totals"]["nodes"], 0)

    def test_publishing_puts_exactly_that_network_on_the_map(self) -> None:
        """Publishing puts exactly that network on the map."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            self.assertEqual(client.post("/deployments/d0/publish").status_code, 200)
            graph: Dict[str, Any] = client.get("/graph").json()
            self.assertEqual([node["name"] for node in graph["nodes"]], ["net0"])

    def test_the_deployment_list_still_shows_drafts(self) -> None:
        """Only map visibility is gated — the owner must still see what they built."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            body: Dict[str, Any] = client.get("/deployments").json()
            self.assertEqual(len(body["deployments"]), 2)
            self.assertFalse(any(d["published"] for d in body["deployments"]))

    def test_the_directory_still_lists_drafts(self) -> None:
        """The directory still lists drafts."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            body: Dict[str, Any] = client.get("/directory").json()
            names: List[str] = [d["name"] for org in body["organizations"] for d in org["deployments"]]
            self.assertCountEqual(names, ["net0", "net1"])

    def test_the_view_reports_publish_state(self) -> None:
        """The view reports publish state."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            self.assertFalse(client.get("/deployments/d0").json()["published"])
            client.post("/deployments/d0/publish")
            view: Dict[str, Any] = client.get("/deployments/d0").json()
            self.assertTrue(view["published"])
            self.assertIsNotNone(view["published_at"])

    def test_unpublishing_removes_the_pin_but_keeps_the_deployment(self) -> None:
        """Unpublishing removes the pin but keeps the deployment."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            client.post("/deployments/d0/publish")
            client.post("/deployments/d0/unpublish")
            self.assertEqual(client.get("/graph").json()["nodes"], [])
            self.assertEqual(client.get("/deployments/d0").json()["status"], "ready")

    def test_suggested_edges_never_reference_an_unpublished_network(self) -> None:
        """Relations on /graph are computed over what is drawn. Considering drafts
        here would emit an edge pointing at a node that is not on the map."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            client.post("/deployments/d0/publish")
            graph: Dict[str, Any] = client.get("/graph").json()
            ids: Set[str] = {node["id"] for node in graph["nodes"]}
            edge: Dict[str, Any]
            for edge in graph["suggested_edges"]:
                self.assertIn(edge["source"], ids)
                self.assertIn(edge["target"], ids)

    def test_relations_endpoint_still_considers_every_deployment(self) -> None:
        """Relations endpoint still considers every deployment."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            self.assertEqual(client.get("/relations").json()["networks"], 2)

    def test_publishing_an_unknown_deployment_is_a_404(self) -> None:
        """Publishing an unknown deployment is a 404."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor)
            self.assertEqual(client.post("/deployments/nope/publish").status_code, 404)


class MapStatusFilterTest(unittest.TestCase):
    """Which statuses a published network is drawn in.

    Only `ready`. Queued and building used to qualify too, so a pin appeared the
    moment someone launched and filled in as the build completed — good feedback for
    one person deploying one network. At event scale that inverts: dozens of
    simultaneous launches fill the map with half-built pins that churn on every poll,
    and the arrival a reader is waiting for is lost among them. The launch dialog
    already covers the wait, so nothing goes unexplained by holding the pin back.

    Failed and stopped are excluded for their own reasons: a failed build has no site
    for the pin to lead to, and a stop is a deliberate withdrawal.

    The upshot is an invariant worth having — every pin on the map has a URL, so
    clicking one can never lead nowhere.
    """

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8770, port_end=8779)))

    def _seed(self, supervisor: Supervisor, deployment_id: str, status: str, published: bool = True) -> None:
        """A published record in `status`.

        Written straight to the store rather than via create(), so the status is the
        only variable — create() would auto-publish and leave the row queued.
        """
        work_dir: Path = self.root / deployment_id
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "nsdeploy.log").write_text("", encoding="utf-8")
        supervisor.store.save_deployment({
            "id": deployment_id, "org_id": supervisor.fallback_org["id"],
            "name": f"net_{deployment_id}", "status": status,
            # Only a ready site has a URL; that is what makes its pin clickable.
            "url": "http://127.0.0.1:8770" if status == "ready" else None,
            "port": 8770, "created_at": "2026-09-23T22:00:00+00:00",
            "ready_at": None, "stopped_at": None, "expires_at": None,
            "error": "build failed" if status == "failed" else None, "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(work_dir / "nsdeploy.log"), "work_dir": str(work_dir),
            "position_json": json.dumps({"x": 30, "y": 30}),
        })
        if published:
            supervisor.store.set_published(deployment_id, "2026-09-23T22:00:00+00:00")

    def _names(self, client: TestClient) -> Set[str]:
        return {node["name"] for node in client.get("/graph").json()["nodes"]}

    def test_a_building_network_is_not_on_the_map_yet(self) -> None:
        """A pin appears when the network is finished, not when it is started.

        The launch dialog watches the build and only opens the map once the site
        answers, so the wait is already accounted for — and at event scale a map of
        half-built pins churning on every poll buries the one arrival that matters.
        """
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor, "d0", "building")
            self.assertEqual(self._names(client), set())

    def test_a_queued_network_is_not_on_the_map_yet(self) -> None:
        """A queued network is not on the map yet."""
        client: TestClient
        with self._client() as client:
            self._seed(client.app.state.supervisor, "d0", "queued")
            self.assertEqual(self._names(client), set())

    def test_every_pin_on_the_map_has_a_url(self) -> None:
        """The invariant excluding pending statuses buys: a pin always leads
        somewhere. Previously a queued or building network was drawn with `url: null`
        and clicking it did nothing."""
        client: TestClient
        with self._client() as client:
            supervisor: Supervisor = client.app.state.supervisor
            self._seed(supervisor, "d0", "queued")
            self._seed(supervisor, "d1", "building")
            self._seed(supervisor, "d2", "ready")
            nodes: List[Dict[str, Any]] = client.get("/graph").json()["nodes"]
            self.assertEqual(len(nodes), 1)
            self.assertTrue(all(node["url"] for node in nodes))

    def test_failed_and_stopped_networks_leave_the_map(self) -> None:
        """Failed and stopped networks leave the map."""
        client: TestClient
        with self._client() as client:
            supervisor: Supervisor = client.app.state.supervisor
            self._seed(supervisor, "d0", "failed")
            self._seed(supervisor, "d1", "stopped")
            self._seed(supervisor, "d2", "ready")
            self.assertEqual(self._names(client), {"net_d2"})

    def test_an_unpublished_network_is_still_absent_whatever_its_status(self) -> None:
        """Auto-publishing changed the default, not the rule: /unpublish still
        withdraws a network from the map.

        Seeded `ready` on purpose. This used to seed `building`, which stopped being
        a test of anything once pending statuses left the map — it would have passed
        on the status alone, whatever the publishing rule did. `ready` is the only
        status that would otherwise be drawn, so it is the only one that can prove
        unpublishing is what withholds it.
        """
        client: TestClient
        with self._client() as client:
            supervisor: Supervisor = client.app.state.supervisor
            self._seed(supervisor, "d0", "ready", published=False)
            self.assertEqual(self._names(client), set())
            # And the complement, so the assertion above cannot pass because the
            # fixture simply never draws anything.
            self._seed(supervisor, "d1", "ready", published=True)
            self.assertEqual(self._names(client), {"net_d1"})


if __name__ == "__main__":
    unittest.main()


class PublishGuardEndpointTest(unittest.TestCase):
    """The API is the gate. A client that ignores `publishable` still gets refused,
    with a message it can show verbatim."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8770, port_end=8779)))

    def _row(self, supervisor: Supervisor, status: str, ready_at: Optional[str]) -> None:
        org: Dict[str, Any] = supervisor.fallback_org
        work_dir: Path = self.root / "d"
        work_dir.mkdir(parents=True, exist_ok=True)
        supervisor.store.save_deployment({
            "id": "d", "org_id": org["id"], "name": "netd", "status": status,
            "url": "http://127.0.0.1:8770" if status == "ready" else None,
            "port": None, "created_at": "2026-09-23T22:00:00+00:00",
            "ready_at": ready_at, "stopped_at": None, "expires_at": None,
            "error": None, "pid": None, "network_json": None, "warnings_json": None,
            "log_path": str(work_dir / "nsdeploy.log"), "work_dir": str(work_dir),
        })

    def test_a_never_deployed_network_is_refused_with_deploy_first(self) -> None:
        """A never deployed network is refused with deploy first."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "failed", None)
            response: httpx.Response = client.post("/deployments/d/publish")
            self.assertEqual(response.status_code, 400)
            self.assertIn("Deploy netd", response.json()["detail"])

    def test_a_stopped_network_is_refused_with_restart_first(self) -> None:
        """A stopped network is refused with restart first."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "stopped", "2026-09-23T22:00:05+00:00")
            response: httpx.Response = client.post("/deployments/d/publish")
            self.assertEqual(response.status_code, 400)
            self.assertIn("Restart it", response.json()["detail"])

    def test_a_refused_network_never_reaches_the_map(self) -> None:
        """A refused network never reaches the map."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "stopped", "2026-09-23T22:00:05+00:00")
            client.post("/deployments/d/publish")
            self.assertEqual(client.get("/graph").json()["nodes"], [])

    def test_the_view_carries_the_reason_for_the_console(self) -> None:
        """The view carries the reason for the console."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "failed", None)
            view: Dict[str, Any] = client.get("/deployments/d").json()
            self.assertFalse(view["publishable"])
            self.assertIn("Deploy netd", view["publish_blocked_reason"])

    def test_a_ready_network_is_publishable_with_no_reason(self) -> None:
        """A ready network is publishable with no reason."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready", "2026-09-23T22:00:05+00:00")
            view: Dict[str, Any] = client.get("/deployments/d").json()
            self.assertTrue(view["publishable"])
            self.assertIsNone(view["publish_blocked_reason"])

    def test_an_already_published_network_reports_no_reason(self) -> None:
        """An already published network reports no reason."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready", "2026-09-23T22:00:05+00:00")
            client.post("/deployments/d/publish")
            view: Dict[str, Any] = client.get("/deployments/d").json()
            self.assertTrue(view["published"])
            self.assertFalse(view["publishable"])
            self.assertIsNone(view["publish_blocked_reason"])


class MapVisibilityTest(unittest.TestCase):
    """The map shows published networks that are actually serving. Stopping one
    takes it off; restarting puts it back without re-publishing."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8730, port_end=8739)))

    def _row(self, supervisor: Supervisor, status: str, published: bool = True) -> None:
        org: Dict[str, Any] = supervisor.fallback_org
        work_dir: Path = self.root / "d"
        work_dir.mkdir(parents=True, exist_ok=True)
        supervisor.store.save_deployment({
            "id": "d", "org_id": org["id"], "name": "netd", "status": status,
            "url": "http://127.0.0.1:8730" if status == "ready" else None,
            "port": None, "created_at": "2026-09-23T22:00:00+00:00",
            "ready_at": "2026-09-23T22:00:05+00:00", "stopped_at": None,
            "expires_at": None, "error": None, "pid": None,
            "network_json": json.dumps({"front_man": "f", "agent_count": 1}),
            "warnings_json": None, "log_path": str(work_dir / "nsdeploy.log"),
            "work_dir": str(work_dir),
            "position_json": json.dumps({"x": 22, "y": 12}),
        })
        if published:
            supervisor.store.set_published("d", "2026-09-23T22:10:00+00:00")

    def test_a_published_and_ready_network_is_on_the_map(self) -> None:
        """A published and ready network is on the map."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            nodes: List[Dict[str, Any]] = client.get("/graph").json()["nodes"]
            self.assertEqual([n["name"] for n in nodes], ["netd"])

    def test_a_pin_carries_a_url_so_it_can_be_opened(self) -> None:
        """The map renders a pin as a link only when the node has a URL; without
        one, clicking it does nothing."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            node: Dict[str, Any] = client.get("/graph").json()["nodes"][0]
            self.assertTrue(node["url"])
            self.assertTrue(node["url"].startswith("http"))

    def test_stopping_takes_it_off_the_map(self) -> None:
        """Stopping takes it off the map."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "stopped")
            self.assertEqual(client.get("/graph").json()["nodes"], [])

    def test_the_publish_decision_survives_a_stop(self) -> None:
        """So restarting restores the pin instead of demanding a fresh publish."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "stopped")
            self.assertTrue(client.get("/deployments/d").json()["published"])

    def test_a_failed_published_network_is_not_on_the_map(self) -> None:
        """A failed published network is not on the map."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "failed")
            self.assertEqual(client.get("/graph").json()["nodes"], [])


class RemovalGuardTest(unittest.TestCase):
    """A running deployment cannot be removed. Removal discards the record, logs and
    uploaded HOCON, so it must not double as "tear the running site down"."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8740, port_end=8749)))

    def _row(self, supervisor: Supervisor, status: str) -> None:
        org: Dict[str, Any] = supervisor.fallback_org
        work_dir: Path = self.root / "d"
        work_dir.mkdir(parents=True, exist_ok=True)
        supervisor.store.save_deployment({
            "id": "d", "org_id": org["id"], "name": "netd", "status": status,
            "url": "http://127.0.0.1:8740" if status == "ready" else None,
            "port": None, "created_at": "2026-09-23T22:00:00+00:00",
            "ready_at": "2026-09-23T22:00:05+00:00", "stopped_at": None,
            "expires_at": None, "error": None, "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(work_dir / "nsdeploy.log"), "work_dir": str(work_dir),
        })

    def test_a_running_deployment_cannot_be_purged(self) -> None:
        """A running deployment cannot be purged."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            response: httpx.Response = client.delete("/deployments/d?purge=true")
            self.assertEqual(response.status_code, 400)
            self.assertIn("Stop it before removing", response.json()["detail"])

    def test_a_rejected_purge_does_not_stop_the_deployment(self) -> None:
        """The check runs before the teardown, so a refused request leaves the site
        exactly as it was."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            client.delete("/deployments/d?purge=true")
            self.assertEqual(client.get("/deployments/d").json()["status"], "ready")

    def test_a_rejected_purge_keeps_the_record(self) -> None:
        """A rejected purge keeps the record."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            client.delete("/deployments/d?purge=true")
            self.assertEqual(client.get("/deployments/d").status_code, 200)

    def test_a_stopped_deployment_can_be_purged(self) -> None:
        """A stopped deployment can be purged."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "stopped")
            self.assertEqual(client.delete("/deployments/d?purge=true").status_code, 200)
            self.assertEqual(client.get("/deployments/d").status_code, 404)

    def test_stopping_without_purge_is_still_allowed_while_running(self) -> None:
        """Stopping without purge is still allowed while running."""
        client: TestClient
        with self._client() as client:
            self._row(client.app.state.supervisor, "ready")
            self.assertEqual(client.delete("/deployments/d").status_code, 200)

    def test_forget_refuses_a_live_record_directly(self) -> None:
        """Forget refuses a live record directly."""
        supervisor: Supervisor = Supervisor(Settings(work_root=self.root,
                                                     port_start=8740, port_end=8749))
        try:
            self._row(supervisor, "ready")
            with self.assertRaises(DeploymentError):
                asyncio.run(supervisor.forget("d"))
        finally:
            supervisor.store.close()


class PublishedOriginWarningTest(unittest.TestCase):
    """The origin is baked into the bundle at build time, so a wrong one cannot be
    corrected afterwards: the deployment comes up `ready` and its URL answers
    nothing. /health says so instead of leaving it to be discovered."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _warnings(self, **over: Any) -> List[str]:
        base: Dict[str, Any] = {"work_root": self.root, "port_start": 8710, "port_end": 8719}
        base.update(over)
        client: TestClient
        with TestClient(create_app(Settings(**base))) as client:
            return client.get("/health").json()["warnings"]

    def test_https_with_port_per_deployment_is_flagged(self) -> None:
        """Https with port per deployment is flagged."""
        found: List[str] = self._warnings(public_scheme="https",
                                          public_host="x.eastus.azurecontainerapps.io")
        self.assertTrue(any("will not resolve" in w for w in found), found)

    def test_the_warning_names_the_port_pool(self) -> None:
        """The warning names the port pool."""
        found: List[str] = self._warnings(public_scheme="https", public_host="x.example.com")
        self.assertTrue(any("8710-8719" in w for w in found), found)

    def test_a_subdomain_template_clears_it(self) -> None:
        """A subdomain template clears it."""
        found: List[str] = self._warnings(public_scheme="https", public_host="x.example.com",
                                          subdomain_template="{id}")
        self.assertFalse(any("will not resolve" in w for w in found), found)

    def test_plain_http_is_not_flagged(self) -> None:
        """Plain http is not flagged."""
        found: List[str] = self._warnings(public_scheme="http", public_host="10.1.2.3")
        self.assertFalse(any("will not resolve" in w for w in found), found)
