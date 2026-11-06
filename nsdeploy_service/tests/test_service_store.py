import json
import socket
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Sequence
from typing import Tuple
from unittest.case import _AssertRaisesContext

from nsdeploy_service.config import Settings
from nsdeploy_service.models import SUMMARY_SCHEMA_VERSION
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.models import NetworkSummary
from nsdeploy_service.ports import PortPool
from nsdeploy_service.ports import PortPoolExhausted
from nsdeploy_service.store import RESTART_REASON
from nsdeploy_service.store import UNATTRIBUTED_NAME
from nsdeploy_service.store import Store
from nsdeploy_service.store import StoreError
from nsdeploy_service.store import org_name_key
from nsdeploy_service.supervisor import RUN_SEPARATOR
from nsdeploy_service.supervisor import Deployment
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import Supervisor
from nsdeploy_service.supervisor import bundle_ready
from nsdeploy_service.supervisor import engine_supports_host
from nsdeploy_service.supervisor import latest_run
from nsdeploy_service.supervisor import probe_host
from nsdeploy_service.supervisor import summarize_build


class StoreTempCase(unittest.TestCase):
    """Base case that opens a Store in a temporary directory."""
    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)
        self.store: Store = Store(self.root / "service.db")

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def _deployment_row(self, deployment_id: str, org_id: str, status: str = "ready", **over: Any) -> Dict[str, Any]:
        row: Dict[str, Any] = {
            "id": deployment_id, "org_id": org_id, "name": f"net_{deployment_id}",
            "status": status, "url": "http://127.0.0.1:8100", "port": 8100,
            "created_at": "2026-09-22T20:00:00+00:00", "ready_at": None,
            "stopped_at": None, "expires_at": None, "error": None, "pid": 4242,
            "network_json": None, "warnings_json": None,
            "log_path": str(self.root / f"{deployment_id}.log"),
            "work_dir": str(self.root / deployment_id),
        }
        row.update(over)
        return row


class OrgStoreTest(StoreTempCase):
    """Organization records in the Store."""
    def test_creates_and_reads_back_an_org(self) -> None:
        """An org is created and read back with all its fields."""
        org: Dict[str, Any] = self.store.create_org("Acme Logistics", "1 Harbour Rd", "team@acme.example")
        fetched: Optional[Dict[str, Any]] = self.store.get_org(org["id"])
        self.assertEqual(fetched["name"], "Acme Logistics")
        self.assertEqual(fetched["address"], "1 Harbour Rd")
        self.assertEqual(fetched["contact"], "team@acme.example")

    def test_org_names_are_unique_case_and_whitespace_insensitively(self) -> None:
        """Org names are unique regardless of case and surrounding whitespace."""
        self.store.create_org("Acme")
        duplicate: str
        for duplicate in ("acme", "  ACME  ", "Acme"):
            with self.subTest(duplicate=duplicate):
                with self.assertRaises(StoreError):
                    self.store.create_org(duplicate)

    def test_normalises_internal_whitespace_in_the_key(self) -> None:
        """Internal whitespace runs are collapsed in the name key."""
        self.assertEqual(org_name_key("  Acme   Logistics "), "acme logistics")
        self.store.create_org("Acme   Logistics")
        with self.assertRaises(StoreError):
            self.store.create_org("acme logistics")

    def test_rejects_a_blank_name(self) -> None:
        """A blank org name is rejected."""
        blank: str
        for blank in ("", "   ", "\t\n"):
            with self.subTest(blank=blank):
                with self.assertRaises(StoreError):
                    self.store.create_org(blank)

    def test_ensure_org_is_get_or_create(self) -> None:
        """ensure_org returns the existing org instead of creating a second one."""
        first: Dict[str, Any] = self.store.ensure_org(UNATTRIBUTED_NAME)
        second: Dict[str, Any] = self.store.ensure_org(UNATTRIBUTED_NAME)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.list_orgs()), 1)

    def test_list_orgs_reports_total_and_live_counts(self) -> None:
        """list_orgs reports total and live deployment counts."""
        org: Dict[str, Any] = self.store.create_org("Acme")
        self.store.save_deployment(self._deployment_row("d1", org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", org["id"], status="stopped"))
        self.store.save_deployment(self._deployment_row("d3", org["id"], status="building"))
        listed: Dict[str, Any] = self.store.list_orgs()[0]
        self.assertEqual(listed["deployment_count"], 3)
        self.assertEqual(listed["live_count"], 2)  # ready + building, not stopped

    def test_update_org_rejects_a_name_another_org_already_uses(self) -> None:
        """update_org rejects a name another org already uses."""
        first: Dict[str, Any] = self.store.create_org("Acme")
        self.store.create_org("Globex")
        with self.assertRaises(StoreError):
            self.store.update_org(first["id"], name="globex")
        self.assertEqual(self.store.get_org(first["id"])["name"], "Acme")

    def test_update_org_changes_fields_and_returns_none_for_unknown(self) -> None:
        """update_org changes fields, and returns None for an unknown org."""
        org: Dict[str, Any] = self.store.create_org("Acme")
        updated: Optional[Dict[str, Any]] = self.store.update_org(org["id"], contact="ops@acme.example")
        self.assertEqual(updated["contact"], "ops@acme.example")
        self.assertIsNone(self.store.update_org("nope", contact="x"))

    def test_delete_org_refuses_while_it_owns_deployment_records(self) -> None:
        """delete_org refuses while the org still owns deployment records."""
        org: Dict[str, Any] = self.store.create_org("Acme")
        self.store.save_deployment(self._deployment_row("d1", org["id"]))
        with self.assertRaises(StoreError):
            self.store.delete_org(org["id"])
        self.store.delete_deployment("d1")
        self.assertTrue(self.store.delete_org(org["id"]))


class DeploymentStoreTest(StoreTempCase):
    """Deployment records in the Store."""
    def setUp(self) -> None:
        super().setUp()
        self.org: Dict[str, Any] = self.store.create_org("Acme")

    def test_save_is_an_upsert_on_id(self) -> None:
        """Saving a deployment upserts on its id."""
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="queued"))
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], status="ready", ready_at="2026-09-22T20:01:00+00:00"))
        rows: List[Dict[str, Any]] = self.store.list_deployments()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "ready")
        self.assertEqual(rows[0]["ready_at"], "2026-09-22T20:01:00+00:00")

    def test_read_joins_the_org_name(self) -> None:
        """A deployment read joins in the org name."""
        self.store.save_deployment(self._deployment_row("d1", self.org["id"]))
        self.assertEqual(self.store.get_deployment("d1")["org_name"], "Acme")

    def test_decodes_network_and_warnings_json(self) -> None:
        """The network and warnings JSON columns are decoded."""
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"],
            network_json='{"front_man": "boss", "agent_count": 4}',
            warnings_json='["one", "two"]'))
        row: Optional[Dict[str, Any]] = self.store.get_deployment("d1")
        self.assertEqual(row["network"]["front_man"], "boss")
        self.assertEqual(row["warnings"], ["one", "two"])

    def test_survives_corrupt_json_columns(self) -> None:
        """Corrupt JSON columns read back as empty values."""
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], network_json="{not json", warnings_json="also bad"))
        row: Optional[Dict[str, Any]] = self.store.get_deployment("d1")
        self.assertIsNone(row["network"])
        self.assertEqual(row["warnings"], [])

    def test_filters_by_org_and_status(self) -> None:
        """list_deployments filters by org and by status."""
        other: Dict[str, Any] = self.store.create_org("Globex")
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", other["id"], status="failed"))
        self.assertEqual([r["id"] for r in self.store.list_deployments(org_id=self.org["id"])], ["d1"])
        self.assertEqual([r["id"] for r in self.store.list_deployments(status="failed")], ["d2"])

    def test_unknown_reads_are_none_not_errors(self) -> None:
        """Reads of an unknown deployment return None rather than raising."""
        self.assertIsNone(self.store.get_deployment("missing"))
        self.assertFalse(self.store.delete_deployment("missing"))

    def test_count_by_status(self) -> None:
        """count_by_status counts deployments per status."""
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d3", self.org["id"], status="failed"))
        self.assertEqual(self.store.count_by_status(), {"ready": 2, "failed": 1})

    def test_rejects_a_deployment_for_an_unknown_org(self) -> None:
        """A deployment for an unknown org is rejected by the foreign key."""
        # FK enforcement matters: an orphan row would break the directory's join.
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.save_deployment(self._deployment_row("d1", "no-such-org"))


class ReconcileOrphansTest(StoreTempCase):
    """A restart kills every deployed site, so no row may keep claiming it is live."""

    def setUp(self) -> None:
        super().setUp()
        self.org: Dict[str, Any] = self.store.create_org("Acme")

    def test_settles_every_live_status_and_leaves_terminal_rows_alone(self) -> None:
        """Every live status is settled to stopped and terminal rows are left alone."""
        index: int
        status: str
        for index, status in enumerate(("queued", "building", "ready", "failed", "stopped")):
            self.store.save_deployment(
                self._deployment_row(f"d{index}", self.org["id"], status=status))

        orphans: List[str] = self.store.reconcile_orphans()

        self.assertEqual(sorted(orphans), ["d0", "d1", "d2"])
        deployment_id: str
        row: Optional[Dict[str, Any]]
        for deployment_id in ("d0", "d1", "d2"):
            row = self.store.get_deployment(deployment_id)
            self.assertEqual(row["status"], "stopped")
            self.assertIsNone(row["url"], "a stale row must not keep advertising a URL")
            self.assertIsNone(row["port"])
            self.assertIsNone(row["pid"])
            self.assertEqual(row["error"], RESTART_REASON)
        self.assertEqual(self.store.get_deployment("d3")["status"], "failed")
        self.assertEqual(self.store.get_deployment("d4")["status"], "stopped")

    def test_preserves_an_existing_error_message(self) -> None:
        """An existing error message is preserved by reconciliation."""
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], status="ready", error="something specific"))
        self.store.reconcile_orphans()
        self.assertEqual(self.store.get_deployment("d1")["error"], "something specific")

    def test_is_idempotent(self) -> None:
        """Reconciliation is idempotent."""
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.assertEqual(self.store.reconcile_orphans(), ["d1"])
        self.assertEqual(self.store.reconcile_orphans(), [])


class SupervisorPersistenceTest(unittest.TestCase):
    """Supervisor persistence of deployment records through the Store."""
    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)
        self._supervisors: List[Supervisor] = []

    def tearDown(self) -> None:
        # Close in tearDown rather than per-test: a failing assertion would otherwise
        # leave the SQLite handle open and Windows cannot unlink the tempdir.
        supervisor: Supervisor
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self) -> Supervisor:
        supervisor: Supervisor = Supervisor(Settings(work_root=self.root, port_start=8600, port_end=8609))
        self._supervisors.append(supervisor)
        return supervisor

    def test_seeds_the_fallback_org_and_attributes_unowned_uploads_to_it(self) -> None:
        """The fallback org is seeded and unowned uploads are attributed to it."""
        supervisor: Supervisor = self._supervisor()
        self.assertEqual(supervisor.fallback_org["name"], UNATTRIBUTED_NAME)
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])
        self.assertEqual(dep.org_name, UNATTRIBUTED_NAME)

    def test_attributes_to_a_named_org(self) -> None:
        """An upload naming an org is attributed to it."""
        supervisor: Supervisor = self._supervisor()
        org: Dict[str, Any] = supervisor.store.create_org("Acme")
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo", org_id=org["id"]))
        self.assertEqual(dep.org_name, "Acme")

    def test_rejects_an_unknown_org(self) -> None:
        """An upload naming an unknown org is rejected."""
        supervisor: Supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_id="nope"))

    def test_create_writes_the_record_through_immediately(self) -> None:
        """create writes the deployment record through immediately."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        row: Optional[Dict[str, Any]] = supervisor.store.get_deployment(dep.id)
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["name"], "demo")
        self.assertEqual(row["log_path"], str(dep.log_path))

    def test_a_queued_record_is_reconciled_by_the_next_supervisor(self) -> None:
        """A queued record is reconciled by the next supervisor."""
        # The end-to-end restart guarantee: create, drop the process, start again.
        first: Supervisor = self._supervisor()
        dep: Deployment = first.create(b"x", DeployOptions(name="demo"))

        second: Supervisor = self._supervisor()
        self.assertEqual(second.orphaned, [dep.id])
        row: Optional[Dict[str, Any]] = second.store.get_deployment(dep.id)
        self.assertEqual(row["status"], "stopped")
        self.assertEqual(row["error"], RESTART_REASON)
        # The port must be free for reuse, not still reserved from the previous run.
        self.assertEqual(second.ports.reserved(), set())

    def test_row_hides_url_and_port_once_terminal(self) -> None:
        """A terminal deployment row hides its URL and port."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        dep.status = DeploymentStatus.STOPPED
        row: Dict[str, Any] = dep.as_row()
        self.assertIsNone(row["url"])
        self.assertIsNone(row["port"])


class MigrationTest(unittest.TestCase):
    """A database created before options_json/hocon_path existed must still open."""

    def test_adds_missing_columns_to_an_older_database(self) -> None:
        """Missing columns are added to an older database."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            path: Path = Path(tmp) / "old.db"
            legacy: sqlite3.Connection = sqlite3.connect(str(path))
            legacy.executescript("""
                CREATE TABLE organizations (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
                    address TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL);
                CREATE TABLE deployments (
                    id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id),
                    name TEXT NOT NULL, status TEXT NOT NULL, url TEXT, port INTEGER,
                    created_at TEXT NOT NULL, ready_at TEXT, stopped_at TEXT, expires_at TEXT,
                    error TEXT, pid INTEGER, network_json TEXT, warnings_json TEXT,
                    log_path TEXT NOT NULL, work_dir TEXT NOT NULL);
                INSERT INTO organizations VALUES ('o1','Acme','acme','','','2026-01-01T00:00:00+00:00');
                INSERT INTO deployments VALUES ('d1','o1','net','stopped',NULL,NULL,
                    '2026-01-01T00:00:00+00:00',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'l.log','w');
            """)
            legacy.commit()
            legacy.close()

            store: Store = Store(path)
            try:
                row: Optional[Dict[str, Any]] = store.get_deployment("d1")
                self.assertEqual(row["name"], "net")
                # Present but empty for a pre-migration record.
                self.assertIsNone(row["options"])
                self.assertIsNone(row["hocon_path"])
                # And the migration is idempotent across reopens.
                store.close()
                store = Store(path)
                self.assertEqual(store.get_deployment("d1")["name"], "net")
            finally:
                store.close()


class RestartTest(unittest.TestCase):
    """restart() relaunches in place from the stored HOCON."""

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

    def _supervisor(self, **over: Any) -> Supervisor:
        supervisor: Supervisor = Supervisor(Settings(work_root=self.root, port_start=8700,
                                                     port_end=8709, **over))
        self._supervisors.append(supervisor)
        return supervisor

    def _stopped(self, supervisor: Supervisor, **option_kwargs: Any) -> Deployment:
        dep: Deployment = supervisor.create(b'{"tools": []}', DeployOptions(name="demo", **option_kwargs))
        # pylint: disable-next=protected-access  # exercises an internal step
        supervisor._teardown(dep, DeploymentStatus.STOPPED, "stopped for the test")
        return dep

    def test_reuses_the_record_id_and_the_original_port(self) -> None:
        """A restart reuses the record id and the original port."""
        supervisor: Supervisor = self._supervisor()
        original: Deployment = self._stopped(supervisor)
        port: int
        url: str
        port, url = original.port, original.url

        restarted: Deployment = supervisor.restart(original.id)

        self.assertEqual(restarted.id, original.id)
        self.assertEqual(restarted.port, port, "the URL is baked in, so keep the port")
        self.assertEqual(restarted.url, url)
        self.assertEqual(restarted.status, DeploymentStatus.QUEUED)
        self.assertIsNone(restarted.process)

    def test_replays_the_original_options_not_current_defaults(self) -> None:
        """A restart replays the original options, not the current defaults."""
        supervisor: Supervisor = self._supervisor(upstream="https://service-default/v1")
        original: Deployment = self._stopped(supervisor, upstream="https://chosen/v1", cruse=False)

        restarted: Deployment = supervisor.restart(original.id)
        command: List[str]
        command = supervisor._command(restarted)  # pylint: disable=protected-access; exercises an internal step

        self.assertEqual(command[command.index("--upstream") + 1], "https://chosen/v1")
        self.assertIn("--no-cruse", command)

    def test_keeps_the_owning_organization(self) -> None:
        """A restart keeps the owning organization."""
        supervisor: Supervisor = self._supervisor()
        org: Dict[str, Any] = supervisor.store.create_org("Acme")
        original: Deployment = self._stopped(supervisor, org_id=org["id"])
        restarted: Deployment = supervisor.restart(original.id)
        self.assertEqual(restarted.org_id, org["id"])
        self.assertEqual(restarted.org_name, "Acme")

    def test_clears_the_previous_error_and_result(self) -> None:
        """A restart clears the previous error and result."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        # pylint: disable-next=protected-access  # exercises an internal step
        supervisor._fail(dep, "the HOCON could not be parsed")
        restarted: Deployment = supervisor.restart(dep.id)
        self.assertIsNone(restarted.error)
        self.assertIsNone(restarted.network)
        self.assertEqual(restarted.warnings, [])
        self.assertIsNone(restarted.ready_at)

    def test_refuses_when_the_hocon_is_gone(self) -> None:
        """A restart is refused when the HOCON is gone."""
        supervisor: Supervisor = self._supervisor()
        original: Deployment = self._stopped(supervisor)
        original.hocon_path.unlink()
        caught: _AssertRaisesContext[DeploymentError]
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(original.id)
        self.assertIn("no longer on disk", str(caught.exception))
        # The failed attempt must not leak a port reservation.
        self.assertEqual(supervisor.ports.reserved(), set())

    def test_refuses_an_unknown_deployment(self) -> None:
        """A restart of an unknown deployment is refused."""
        with self.assertRaises(DeploymentError):
            self._supervisor().restart("nope")

    def test_refuses_while_already_live(self) -> None:
        """A restart is refused while the deployment is already live."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))  # stays queued
        caught: _AssertRaisesContext[DeploymentError]
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(dep.id)
        self.assertIn("already", str(caught.exception))

    def test_respects_the_capacity_limit(self) -> None:
        """A restart respects the capacity limit."""
        supervisor: Supervisor = self._supervisor(max_deployments=1)
        stopped: Deployment = self._stopped(supervisor)
        supervisor.create(b"x", DeployOptions(name="other"))  # occupies the only slot
        caught: _AssertRaisesContext[DeploymentError]
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(stopped.id)
        message: str = str(caught.exception)
        # Asserted on the substance, not the prose: the refusal has to name the limit
        # and say what to do, because the person reading it is at an upload form and
        # cannot raise MAX_DEPLOYMENTS themselves.
        self.assertIn("maximum of 1", message)
        self.assertIn("Stop a network", message)

    def test_falls_back_to_a_free_port_when_the_original_is_taken(self) -> None:
        """A restart falls back to a free port when the original one is taken."""
        supervisor: Supervisor = self._supervisor()
        original: Deployment = self._stopped(supervisor)
        squatter: socket.socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as squatter:
            squatter.bind(("127.0.0.1", original.port))
            squatter.listen(1)
            restarted: Deployment = supervisor.restart(original.id)
        self.assertNotEqual(restarted.port, original.port)
        self.assertEqual(restarted.url, f"http://127.0.0.1:{restarted.port}")

    def test_survives_a_corrupt_options_blob(self) -> None:
        """A restart survives a corrupt options blob."""
        supervisor: Supervisor = self._supervisor()
        original: Deployment = self._stopped(supervisor)
        row: Optional[Dict[str, Any]] = supervisor.store.get_deployment(original.id)
        supervisor.store.save_deployment({
            **{k: row[k] for k in (
                "id", "org_id", "name", "status", "url", "port", "created_at",
                "ready_at", "stopped_at", "expires_at", "error", "pid",
                "log_path", "work_dir", "hocon_path")},
            "network_json": None, "warnings_json": None,
            "options_json": "{not json",
        })
        restarted: Deployment = supervisor.restart(original.id)
        self.assertEqual(restarted.name, "demo")


class LatestRunTest(unittest.TestCase):
    """A restart appends to the same log; parsing must ignore the earlier attempt."""

    def test_scopes_to_the_text_after_the_last_separator(self) -> None:
        """latest_run keeps only the text after the last separator."""
        log: str = f"first attempt\n\n{RUN_SEPARATOR}\n\nsecond attempt\n"
        self.assertEqual(latest_run(log).strip(), "second attempt")

    def test_returns_everything_when_there_is_only_one_run(self) -> None:
        """latest_run returns everything when there is only one run."""
        self.assertEqual(latest_run("only run\n").strip(), "only run")

    def test_summary_ignores_a_previous_run_s_tools(self) -> None:
        """The build summary ignores the tools of a previous run."""
        old: str = ("✅ Hostable tools (will run as local MCP servers): 1\n"
                    "   • stale_tool  →  x.Y  (MCP /_mcp/0/mcp)\n\n")
        new: str = ("✅ Hostable tools (will run as local MCP servers): 1\n"
                    "   • fresh_tool  →  x.Y  (MCP /_mcp/0/mcp)\n\n")
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            summary: NetworkSummary = summarize_build(
                Path(tmp), "net", f"{old}{RUN_SEPARATOR}\n{new}")
        self.assertEqual(summary.hostable_tools, ["fresh_tool"])


class BundleReadinessCase(unittest.TestCase):
    """A deployment must not reach `ready` before the values the directory and the
    network map read from its bundle exist."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.out: Path = Path(self._tmp.name) / "site"
        self.out.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_bundle(self, name: str = "net", agents: int = 2, links: Sequence[Tuple[str, str]] = ()) -> None:
        (self.out / "agent-manifest.json").write_text(json.dumps({
            "brand": "Net", "networks": [{"name": name, "description": "d"}],
            "agent_mcp": {"front_man": "front"},
            "linking": {"imports": [
                {"reference": r, "target": t, "status": "linked", "callers": ["front"]}
                for r, t in links
            ]},
        }), encoding="utf-8")
        (self.out / f"{name}.network.json").write_text(json.dumps({
            "tools": [{"name": f"a{i}"} for i in range(agents)],
        }), encoding="utf-8")

    def test_bundle_is_not_ready_before_nsdeploy_writes_it(self) -> None:
        """A bundle is not ready before nsdeploy writes it."""
        self.assertFalse(bundle_ready(self.out, "net"))

    def test_bundle_is_not_ready_with_only_the_manifest(self) -> None:
        """A bundle is not ready with only the manifest."""
        (self.out / "agent-manifest.json").write_text("{}", encoding="utf-8")
        self.assertFalse(bundle_ready(self.out, "net"))

    def test_bundle_is_ready_once_both_artifacts_exist(self) -> None:
        """A bundle is ready once both artifacts exist."""
        self._write_bundle()
        self.assertTrue(bundle_ready(self.out, "net"))

    def test_bundle_readiness_is_per_network_name(self) -> None:
        """Bundle readiness is checked per network name."""
        self._write_bundle(name="net")
        self.assertFalse(bundle_ready(self.out, "other_net"))

    def test_summary_keeps_the_resolved_links_between_networks(self) -> None:
        """The build summary keeps the resolved links between networks."""
        self._write_bundle(links=[("peer_net", "http://127.0.0.1:8101/peer_net")])
        summary: NetworkSummary = summarize_build(self.out, "net", "")
        self.assertEqual(summary.agent_count, 2)
        self.assertEqual([link.target for link in summary.links],
                         ["http://127.0.0.1:8101/peer_net"])


class SummaryRepairCase(unittest.TestCase):
    """A summary persisted empty is rebuilt from the bundle at startup, so the map
    stops hiding links between networks that can reach each other."""

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

    def _supervisor(self) -> Supervisor:
        supervisor: Supervisor = Supervisor(Settings(work_root=self.root, port_start=8700, port_end=8709))
        self._supervisors.append(supervisor)
        return supervisor

    def _seed_empty_record(self, supervisor: Supervisor, name: str = "net",
                           links: Sequence[Tuple[str, str]] = ()) -> None:
        """A record exactly as the premature-ready bug left it: status ready, bundle
        on disk, stored summary blank."""
        org: Dict[str, Any] = supervisor.fallback_org
        work_dir: Path = self.root / "dep1"
        out_dir: Path = work_dir / "site"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "agent-manifest.json").write_text(json.dumps({
            "brand": "Net", "networks": [{"name": name, "description": "a network"}],
            "agent_mcp": {"front_man": "front"},
            "linking": {"imports": [
                {"reference": r, "target": t, "status": "linked", "callers": ["front"]}
                for r, t in links
            ]},
        }), encoding="utf-8")
        (out_dir / f"{name}.network.json").write_text(json.dumps({
            "tools": [{"name": "front"}, {"name": "second"}],
            "link_slots": {"unlinked_peer": {"callers": ["front"]}},
        }), encoding="utf-8")
        log_path: Path = work_dir / "nsdeploy.log"
        log_path.write_text("", encoding="utf-8")
        supervisor.store.save_deployment({
            "id": "dep1", "org_id": org["id"], "name": name, "status": "ready",
            "url": "http://127.0.0.1:8700", "port": 8700,
            "created_at": "2026-09-23T17:17:51+00:00",
            "ready_at": "2026-09-23T17:17:51+00:00", "stopped_at": None,
            "expires_at": None, "error": None, "pid": 1,
            "network_json": json.dumps({"front_man": "", "agent_count": 0}),
            "warnings_json": None, "log_path": str(log_path), "work_dir": str(work_dir),
        })

    def test_rebuilds_an_empty_summary_from_the_bundle(self) -> None:
        """An empty summary is rebuilt from the bundle."""
        seeder: Supervisor = self._supervisor()
        self._seed_empty_record(
            seeder, links=[("peer_net", "http://127.0.0.1:8701/peer_net")])

        reopened: Supervisor = self._supervisor()
        self.assertEqual(reopened.resummarized, ["dep1"])
        row: Optional[Dict[str, Any]] = reopened.store.get_deployment("dep1")
        self.assertEqual(row["network"]["front_man"], "front")
        self.assertEqual(row["network"]["agent_count"], 2)
        self.assertEqual(row["network"]["description"], "a network")
        self.assertEqual([link["target"] for link in row["network"]["links"]],
                         ["http://127.0.0.1:8701/peer_net"])

    def test_repair_also_restores_the_lost_warnings(self) -> None:
        """The repair also restores the lost warnings."""
        seeder: Supervisor = self._supervisor()
        self._seed_empty_record(seeder)

        reopened: Supervisor = self._supervisor()
        self.assertEqual(reopened.resummarized, ["dep1"])
        row: Optional[Dict[str, Any]] = reopened.store.get_deployment("dep1")
        self.assertTrue(any("unlinked_peer" in warning for warning in row["warnings"]))

    def test_repair_leaves_a_populated_summary_alone(self) -> None:
        """The repair leaves a populated summary alone."""
        seeder: Supervisor = self._supervisor()
        self._seed_empty_record(seeder)
        self._supervisor()  # repairs it

        third: Supervisor = self._supervisor()
        self.assertEqual(third.resummarized, [])

    def test_repair_stamps_the_schema_version_so_it_converges(self) -> None:
        """A front-man with no description of its own used to be re-derived forever:
        the completeness check read the fields, and a legitimately empty field looks
        the same as one that was never filled in."""
        seeder: Supervisor = self._supervisor()
        self._seed_empty_record(seeder)

        repaired: Supervisor = self._supervisor()
        summary: Dict[str, Any] = repaired.store.get_deployment("dep1")["network"]
        self.assertEqual(summary["schema_version"], SUMMARY_SCHEMA_VERSION)
        self.assertEqual(summary["front_man_description"], "")

        for _ in range(3):
            again: Supervisor = self._supervisor()
            self.assertEqual(again.resummarized, [])

    def test_repair_skips_a_record_with_no_bundle(self) -> None:
        """The repair skips a record with no bundle."""
        seeder: Supervisor = self._supervisor()
        org: Dict[str, Any] = seeder.fallback_org
        seeder.store.save_deployment({
            "id": "dep2", "org_id": org["id"], "name": "never_built",
            "status": "failed", "url": None, "port": None,
            "created_at": "2026-09-23T17:00:00+00:00", "ready_at": None,
            "stopped_at": None, "expires_at": None, "error": "boom", "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(self.root / "dep2.log"),
            "work_dir": str(self.root / "dep2"),
        })

        reopened: Supervisor = self._supervisor()
        self.assertEqual(reopened.resummarized, [])
        self.assertIsNone(reopened.store.get_deployment("dep2")["network"])


class DeployHostCase(unittest.TestCase):
    """The site listener's bind address. Configurable because loopback is unreachable
    from outside a container, and the readiness probe follows it. Passed to nsdeploy
    only when it differs from the default, so an unmodified nsdeploy still works."""

    def test_the_bind_address_is_passed_when_the_engine_accepts_it(self) -> None:
        """A non-default bind address reaches nsdeploy — if this engine can take it.

        Conditional because `--host` is the one flag this project added to the engine
        and upstream drops keep removing it. Asserting it unconditionally made the
        suite fail against a stock nsdeploy, which reports the wrong thing: the engine
        is not broken, the service simply has to cope. When the flag is absent the
        service refuses the configuration instead, which the companion assertion below
        covers.
        """
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            settings: Settings = Settings(work_root=Path(tmp), port_start=8750, port_end=8759,
                                          deploy_host="0.0.0.0")
            supervisor: Supervisor = Supervisor(settings)
            try:
                dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
                if engine_supports_host(sys.executable):
                    cmd: List[str]
                    cmd = supervisor._command(dep)  # pylint: disable=protected-access; exercises an internal step
                    self.assertIn("--host", cmd)
                    self.assertEqual(cmd[cmd.index("--host") + 1], "0.0.0.0")
                else:
                    # Refused up front rather than passed to an engine that would
                    # reject the whole command, or worse, accept and ignore it.
                    with self.assertRaises(DeploymentError):
                        supervisor._command(dep)  # pylint: disable=protected-access; exercises an internal step
            finally:
                supervisor.ports.release(dep.port)
                supervisor.store.close()

    def test_no_host_flag_at_the_default(self) -> None:
        """--host is a flag this project added to nsdeploy. Omitting it unless it is
        actually needed is what lets the service run against an unmodified
        nsdeploy — loopback is already nsdeploy's own default."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            supervisor: Supervisor = Supervisor(Settings(work_root=Path(tmp),
                                                         port_start=8760, port_end=8769))
            try:
                dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
                # pylint: disable-next=protected-access  # exercises an internal step
                self.assertNotIn("--host", supervisor._command(dep))
            finally:
                supervisor.ports.release(dep.port)
                supervisor.store.close()

    def test_a_wildcard_bind_is_probed_over_loopback(self) -> None:
        """A wildcard bind address is probed over loopback."""
        wildcard: str
        for wildcard in ("0.0.0.0", "::", "*", ""):
            with self.subTest(wildcard=wildcard):
                self.assertEqual(probe_host(wildcard), "127.0.0.1")

    def test_a_specific_bind_is_probed_at_that_address(self) -> None:
        """A specific bind address is probed at that address."""
        self.assertEqual(probe_host("10.1.2.3"), "10.1.2.3")
        self.assertEqual(probe_host("127.0.0.1"), "127.0.0.1")


class PortProbeCase(unittest.TestCase):
    """Port availability probing in PortPool."""
    def test_a_port_with_a_live_listener_is_not_free(self) -> None:
        """SO_REUSEADDR on the probe made this pass on Windows even with a listener,
        so the pool handed out ports that were still serving another site."""
        server: socket.socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port: int = server.getsockname()[1]
            pool: PortPool = PortPool(port, port)
            self.assertFalse(pool._is_free(port))  # pylint: disable=protected-access; exercises an internal step
            with self.assertRaises(PortPoolExhausted):
                pool.reserve()

    def test_a_free_port_is_reserved(self) -> None:
        """A free port is reserved from the pool range."""
        pool: PortPool = PortPool(8710, 8719)
        self.assertIn(pool.reserve(), range(8710, 8720))


if __name__ == "__main__":
    unittest.main()
