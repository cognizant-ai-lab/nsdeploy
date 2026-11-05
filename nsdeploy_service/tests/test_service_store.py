import json
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.config import Settings
from nsdeploy_service.models import SUMMARY_SCHEMA_VERSION, DeploymentStatus, DeployOptions
from nsdeploy_service.ports import PortPoolExhausted
from nsdeploy_service.store import (
    RESTART_REASON,
    UNATTRIBUTED_NAME,
    Store,
    StoreError,
    org_name_key,
)
from nsdeploy_service.supervisor import DeploymentError, Supervisor


class StoreTempCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.store = Store(self.root / "service.db")

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def _deployment_row(self, deployment_id: str, org_id: str, status: str = "ready", **over):
        row = {
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
    def test_creates_and_reads_back_an_org(self):
        org = self.store.create_org("Acme Logistics", "1 Harbour Rd", "team@acme.example")
        fetched = self.store.get_org(org["id"])
        self.assertEqual(fetched["name"], "Acme Logistics")
        self.assertEqual(fetched["address"], "1 Harbour Rd")
        self.assertEqual(fetched["contact"], "team@acme.example")

    def test_org_names_are_unique_case_and_whitespace_insensitively(self):
        self.store.create_org("Acme")
        for duplicate in ("acme", "  ACME  ", "Acme"):
            with self.subTest(duplicate=duplicate):
                with self.assertRaises(StoreError):
                    self.store.create_org(duplicate)

    def test_normalises_internal_whitespace_in_the_key(self):
        self.assertEqual(org_name_key("  Acme   Logistics "), "acme logistics")
        self.store.create_org("Acme   Logistics")
        with self.assertRaises(StoreError):
            self.store.create_org("acme logistics")

    def test_rejects_a_blank_name(self):
        for blank in ("", "   ", "\t\n"):
            with self.subTest(blank=blank):
                with self.assertRaises(StoreError):
                    self.store.create_org(blank)

    def test_ensure_org_is_get_or_create(self):
        first = self.store.ensure_org(UNATTRIBUTED_NAME)
        second = self.store.ensure_org(UNATTRIBUTED_NAME)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.list_orgs()), 1)

    def test_list_orgs_reports_total_and_live_counts(self):
        org = self.store.create_org("Acme")
        self.store.save_deployment(self._deployment_row("d1", org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", org["id"], status="stopped"))
        self.store.save_deployment(self._deployment_row("d3", org["id"], status="building"))
        listed = self.store.list_orgs()[0]
        self.assertEqual(listed["deployment_count"], 3)
        self.assertEqual(listed["live_count"], 2)  # ready + building, not stopped

    def test_update_org_rejects_a_name_another_org_already_uses(self):
        first = self.store.create_org("Acme")
        self.store.create_org("Globex")
        with self.assertRaises(StoreError):
            self.store.update_org(first["id"], name="globex")
        self.assertEqual(self.store.get_org(first["id"])["name"], "Acme")

    def test_update_org_changes_fields_and_returns_none_for_unknown(self):
        org = self.store.create_org("Acme")
        updated = self.store.update_org(org["id"], contact="ops@acme.example")
        self.assertEqual(updated["contact"], "ops@acme.example")
        self.assertIsNone(self.store.update_org("nope", contact="x"))

    def test_delete_org_refuses_while_it_owns_deployment_records(self):
        org = self.store.create_org("Acme")
        self.store.save_deployment(self._deployment_row("d1", org["id"]))
        with self.assertRaises(StoreError):
            self.store.delete_org(org["id"])
        self.store.delete_deployment("d1")
        self.assertTrue(self.store.delete_org(org["id"]))


class DeploymentStoreTest(StoreTempCase):
    def setUp(self):
        super().setUp()
        self.org = self.store.create_org("Acme")

    def test_save_is_an_upsert_on_id(self):
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="queued"))
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], status="ready", ready_at="2026-09-22T20:01:00+00:00"))
        rows = self.store.list_deployments()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "ready")
        self.assertEqual(rows[0]["ready_at"], "2026-09-22T20:01:00+00:00")

    def test_read_joins_the_org_name(self):
        self.store.save_deployment(self._deployment_row("d1", self.org["id"]))
        self.assertEqual(self.store.get_deployment("d1")["org_name"], "Acme")

    def test_decodes_network_and_warnings_json(self):
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"],
            network_json='{"front_man": "boss", "agent_count": 4}',
            warnings_json='["one", "two"]'))
        row = self.store.get_deployment("d1")
        self.assertEqual(row["network"]["front_man"], "boss")
        self.assertEqual(row["warnings"], ["one", "two"])

    def test_survives_corrupt_json_columns(self):
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], network_json="{not json", warnings_json="also bad"))
        row = self.store.get_deployment("d1")
        self.assertIsNone(row["network"])
        self.assertEqual(row["warnings"], [])

    def test_filters_by_org_and_status(self):
        other = self.store.create_org("Globex")
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", other["id"], status="failed"))
        self.assertEqual([r["id"] for r in self.store.list_deployments(org_id=self.org["id"])], ["d1"])
        self.assertEqual([r["id"] for r in self.store.list_deployments(status="failed")], ["d2"])

    def test_unknown_reads_are_none_not_errors(self):
        self.assertIsNone(self.store.get_deployment("missing"))
        self.assertFalse(self.store.delete_deployment("missing"))

    def test_count_by_status(self):
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d2", self.org["id"], status="ready"))
        self.store.save_deployment(self._deployment_row("d3", self.org["id"], status="failed"))
        self.assertEqual(self.store.count_by_status(), {"ready": 2, "failed": 1})

    def test_rejects_a_deployment_for_an_unknown_org(self):
        # FK enforcement matters: an orphan row would break the directory's join.
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.save_deployment(self._deployment_row("d1", "no-such-org"))


class ReconcileOrphansTest(StoreTempCase):
    """A restart kills every deployed site, so no row may keep claiming it is live."""

    def setUp(self):
        super().setUp()
        self.org = self.store.create_org("Acme")

    def test_settles_every_live_status_and_leaves_terminal_rows_alone(self):
        for index, status in enumerate(("queued", "building", "ready", "failed", "stopped")):
            self.store.save_deployment(
                self._deployment_row(f"d{index}", self.org["id"], status=status))

        orphans = self.store.reconcile_orphans()

        self.assertEqual(sorted(orphans), ["d0", "d1", "d2"])
        for deployment_id in ("d0", "d1", "d2"):
            row = self.store.get_deployment(deployment_id)
            self.assertEqual(row["status"], "stopped")
            self.assertIsNone(row["url"], "a stale row must not keep advertising a URL")
            self.assertIsNone(row["port"])
            self.assertIsNone(row["pid"])
            self.assertEqual(row["error"], RESTART_REASON)
        self.assertEqual(self.store.get_deployment("d3")["status"], "failed")
        self.assertEqual(self.store.get_deployment("d4")["status"], "stopped")

    def test_preserves_an_existing_error_message(self):
        self.store.save_deployment(self._deployment_row(
            "d1", self.org["id"], status="ready", error="something specific"))
        self.store.reconcile_orphans()
        self.assertEqual(self.store.get_deployment("d1")["error"], "something specific")

    def test_is_idempotent(self):
        self.store.save_deployment(self._deployment_row("d1", self.org["id"], status="ready"))
        self.assertEqual(self.store.reconcile_orphans(), ["d1"])
        self.assertEqual(self.store.reconcile_orphans(), [])


class SupervisorPersistenceTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._supervisors = []

    def tearDown(self):
        # Close in tearDown rather than per-test: a failing assertion would otherwise
        # leave the SQLite handle open and Windows cannot unlink the tempdir.
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self) -> Supervisor:
        supervisor = Supervisor(Settings(work_root=self.root, port_start=8600, port_end=8609))
        self._supervisors.append(supervisor)
        return supervisor

    def test_seeds_the_fallback_org_and_attributes_unowned_uploads_to_it(self):
        supervisor = self._supervisor()
        self.assertEqual(supervisor.fallback_org["name"], UNATTRIBUTED_NAME)
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])
        self.assertEqual(dep.org_name, UNATTRIBUTED_NAME)

    def test_attributes_to_a_named_org(self):
        supervisor = self._supervisor()
        org = supervisor.store.create_org("Acme")
        dep = supervisor.create(b"x", DeployOptions(name="demo", org_id=org["id"]))
        self.assertEqual(dep.org_name, "Acme")

    def test_rejects_an_unknown_org(self):
        supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_id="nope"))

    def test_create_writes_the_record_through_immediately(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        row = supervisor.store.get_deployment(dep.id)
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["name"], "demo")
        self.assertEqual(row["log_path"], str(dep.log_path))

    def test_a_queued_record_is_reconciled_by_the_next_supervisor(self):
        # The end-to-end restart guarantee: create, drop the process, start again.
        first = self._supervisor()
        dep = first.create(b"x", DeployOptions(name="demo"))

        second = self._supervisor()
        self.assertEqual(second.orphaned, [dep.id])
        row = second.store.get_deployment(dep.id)
        self.assertEqual(row["status"], "stopped")
        self.assertEqual(row["error"], RESTART_REASON)
        # The port must be free for reuse, not still reserved from the previous run.
        self.assertEqual(second.ports.reserved(), set())

    def test_row_hides_url_and_port_once_terminal(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        dep.status = DeploymentStatus.STOPPED
        row = dep.as_row()
        self.assertIsNone(row["url"])
        self.assertIsNone(row["port"])


class MigrationTest(unittest.TestCase):
    """A database created before options_json/hocon_path existed must still open."""

    def test_adds_missing_columns_to_an_older_database(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.db"
            legacy = sqlite3.connect(str(path))
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

            store = Store(path)
            try:
                row = store.get_deployment("d1")
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

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._supervisors = []

    def tearDown(self):
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self, **over) -> Supervisor:
        supervisor = Supervisor(Settings(work_root=self.root, port_start=8700,
                                         port_end=8709, **over))
        self._supervisors.append(supervisor)
        return supervisor

    def _stopped(self, supervisor, **option_kwargs):
        dep = supervisor.create(b'{"tools": []}', DeployOptions(name="demo", **option_kwargs))
        supervisor._teardown(dep, DeploymentStatus.STOPPED, "stopped for the test")
        return dep

    def test_reuses_the_record_id_and_the_original_port(self):
        supervisor = self._supervisor()
        original = self._stopped(supervisor)
        port, url = original.port, original.url

        restarted = supervisor.restart(original.id)

        self.assertEqual(restarted.id, original.id)
        self.assertEqual(restarted.port, port, "the URL is baked in, so keep the port")
        self.assertEqual(restarted.url, url)
        self.assertEqual(restarted.status, DeploymentStatus.QUEUED)
        self.assertIsNone(restarted.process)

    def test_replays_the_original_options_not_current_defaults(self):
        supervisor = self._supervisor(upstream="https://service-default/v1")
        original = self._stopped(supervisor, upstream="https://chosen/v1", cruse=False)

        restarted = supervisor.restart(original.id)
        command = supervisor._command(restarted)

        self.assertEqual(command[command.index("--upstream") + 1], "https://chosen/v1")
        self.assertIn("--no-cruse", command)

    def test_keeps_the_owning_organization(self):
        supervisor = self._supervisor()
        org = supervisor.store.create_org("Acme")
        original = self._stopped(supervisor, org_id=org["id"])
        restarted = supervisor.restart(original.id)
        self.assertEqual(restarted.org_id, org["id"])
        self.assertEqual(restarted.org_name, "Acme")

    def test_clears_the_previous_error_and_result(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        supervisor._fail(dep, "the HOCON could not be parsed")
        restarted = supervisor.restart(dep.id)
        self.assertIsNone(restarted.error)
        self.assertIsNone(restarted.network)
        self.assertEqual(restarted.warnings, [])
        self.assertIsNone(restarted.ready_at)

    def test_refuses_when_the_hocon_is_gone(self):
        supervisor = self._supervisor()
        original = self._stopped(supervisor)
        original.hocon_path.unlink()
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(original.id)
        self.assertIn("no longer on disk", str(caught.exception))
        # The failed attempt must not leak a port reservation.
        self.assertEqual(supervisor.ports.reserved(), set())

    def test_refuses_an_unknown_deployment(self):
        with self.assertRaises(DeploymentError):
            self._supervisor().restart("nope")

    def test_refuses_while_already_live(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))  # stays queued
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(dep.id)
        self.assertIn("already", str(caught.exception))

    def test_respects_the_capacity_limit(self):
        supervisor = self._supervisor(max_deployments=1)
        stopped = self._stopped(supervisor)
        supervisor.create(b"x", DeployOptions(name="other"))  # occupies the only slot
        with self.assertRaises(DeploymentError) as caught:
            supervisor.restart(stopped.id)
        message = str(caught.exception)
        # Asserted on the substance, not the prose: the refusal has to name the limit
        # and say what to do, because the person reading it is at an upload form and
        # cannot raise MAX_DEPLOYMENTS themselves.
        self.assertIn("maximum of 1", message)
        self.assertIn("Stop a network", message)

    def test_falls_back_to_a_free_port_when_the_original_is_taken(self):
        import socket

        supervisor = self._supervisor()
        original = self._stopped(supervisor)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as squatter:
            squatter.bind(("127.0.0.1", original.port))
            squatter.listen(1)
            restarted = supervisor.restart(original.id)
        self.assertNotEqual(restarted.port, original.port)
        self.assertEqual(restarted.url, f"http://127.0.0.1:{restarted.port}")

    def test_survives_a_corrupt_options_blob(self):
        supervisor = self._supervisor()
        original = self._stopped(supervisor)
        row = supervisor.store.get_deployment(original.id)
        supervisor.store.save_deployment({
            **{k: row[k] for k in (
                "id", "org_id", "name", "status", "url", "port", "created_at",
                "ready_at", "stopped_at", "expires_at", "error", "pid",
                "log_path", "work_dir", "hocon_path")},
            "network_json": None, "warnings_json": None,
            "options_json": "{not json",
        })
        restarted = supervisor.restart(original.id)
        self.assertEqual(restarted.name, "demo")


class LatestRunTest(unittest.TestCase):
    """A restart appends to the same log; parsing must ignore the earlier attempt."""

    def test_scopes_to_the_text_after_the_last_separator(self):
        from nsdeploy_service.supervisor import RUN_SEPARATOR, latest_run

        log = f"first attempt\n\n{RUN_SEPARATOR}\n\nsecond attempt\n"
        self.assertEqual(latest_run(log).strip(), "second attempt")

    def test_returns_everything_when_there_is_only_one_run(self):
        from nsdeploy_service.supervisor import latest_run

        self.assertEqual(latest_run("only run\n").strip(), "only run")

    def test_summary_ignores_a_previous_run_s_tools(self):
        from nsdeploy_service.supervisor import RUN_SEPARATOR, summarize_build

        old = ("✅ Hostable tools (will run as local MCP servers): 1\n"
               "   • stale_tool  →  x.Y  (MCP /_mcp/0/mcp)\n\n")
        new = ("✅ Hostable tools (will run as local MCP servers): 1\n"
               "   • fresh_tool  →  x.Y  (MCP /_mcp/0/mcp)\n\n")
        with tempfile.TemporaryDirectory() as tmp:
            summary = summarize_build(
                Path(tmp), "net", f"{old}{RUN_SEPARATOR}\n{new}")
        self.assertEqual(summary.hostable_tools, ["fresh_tool"])


class BundleReadinessCase(unittest.TestCase):
    """A deployment must not reach `ready` before the values the directory and the
    network map read from its bundle exist."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name) / "site"
        self.out.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _write_bundle(self, name="net", agents=2, links=()):
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

    def test_bundle_is_not_ready_before_nsdeploy_writes_it(self):
        from nsdeploy_service.supervisor import bundle_ready

        self.assertFalse(bundle_ready(self.out, "net"))

    def test_bundle_is_not_ready_with_only_the_manifest(self):
        from nsdeploy_service.supervisor import bundle_ready

        (self.out / "agent-manifest.json").write_text("{}", encoding="utf-8")
        self.assertFalse(bundle_ready(self.out, "net"))

    def test_bundle_is_ready_once_both_artifacts_exist(self):
        from nsdeploy_service.supervisor import bundle_ready

        self._write_bundle()
        self.assertTrue(bundle_ready(self.out, "net"))

    def test_bundle_readiness_is_per_network_name(self):
        from nsdeploy_service.supervisor import bundle_ready

        self._write_bundle(name="net")
        self.assertFalse(bundle_ready(self.out, "other_net"))

    def test_summary_keeps_the_resolved_links_between_networks(self):
        from nsdeploy_service.supervisor import summarize_build

        self._write_bundle(links=[("peer_net", "http://127.0.0.1:8101/peer_net")])
        summary = summarize_build(self.out, "net", "")
        self.assertEqual(summary.agent_count, 2)
        self.assertEqual([link.target for link in summary.links],
                         ["http://127.0.0.1:8101/peer_net"])


class SummaryRepairCase(unittest.TestCase):
    """A summary persisted empty is rebuilt from the bundle at startup, so the map
    stops hiding links between networks that can reach each other."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._supervisors = []

    def tearDown(self):
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self) -> Supervisor:
        supervisor = Supervisor(Settings(work_root=self.root, port_start=8700, port_end=8709))
        self._supervisors.append(supervisor)
        return supervisor

    def _seed_empty_record(self, supervisor, name="net", links=()):
        """A record exactly as the premature-ready bug left it: status ready, bundle
        on disk, stored summary blank."""
        org = supervisor.fallback_org
        work_dir = self.root / "dep1"
        out_dir = work_dir / "site"
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
        log_path = work_dir / "nsdeploy.log"
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

    def test_rebuilds_an_empty_summary_from_the_bundle(self):
        seeder = self._supervisor()
        self._seed_empty_record(
            seeder, links=[("peer_net", "http://127.0.0.1:8701/peer_net")])

        reopened = self._supervisor()
        self.assertEqual(reopened.resummarized, ["dep1"])
        row = reopened.store.get_deployment("dep1")
        self.assertEqual(row["network"]["front_man"], "front")
        self.assertEqual(row["network"]["agent_count"], 2)
        self.assertEqual(row["network"]["description"], "a network")
        self.assertEqual([link["target"] for link in row["network"]["links"]],
                         ["http://127.0.0.1:8701/peer_net"])

    def test_repair_also_restores_the_lost_warnings(self):
        seeder = self._supervisor()
        self._seed_empty_record(seeder)

        reopened = self._supervisor()
        self.assertEqual(reopened.resummarized, ["dep1"])
        row = reopened.store.get_deployment("dep1")
        self.assertTrue(any("unlinked_peer" in warning for warning in row["warnings"]))

    def test_repair_leaves_a_populated_summary_alone(self):
        seeder = self._supervisor()
        self._seed_empty_record(seeder)
        self._supervisor()  # repairs it

        third = self._supervisor()
        self.assertEqual(third.resummarized, [])

    def test_repair_stamps_the_schema_version_so_it_converges(self):
        """A front-man with no description of its own used to be re-derived forever:
        the completeness check read the fields, and a legitimately empty field looks
        the same as one that was never filled in."""
        seeder = self._supervisor()
        self._seed_empty_record(seeder)

        repaired = self._supervisor()
        summary = repaired.store.get_deployment("dep1")["network"]
        self.assertEqual(summary["schema_version"], SUMMARY_SCHEMA_VERSION)
        self.assertEqual(summary["front_man_description"], "")

        for _ in range(3):
            again = self._supervisor()
            self.assertEqual(again.resummarized, [])

    def test_repair_skips_a_record_with_no_bundle(self):
        seeder = self._supervisor()
        org = seeder.fallback_org
        seeder.store.save_deployment({
            "id": "dep2", "org_id": org["id"], "name": "never_built",
            "status": "failed", "url": None, "port": None,
            "created_at": "2026-09-23T17:00:00+00:00", "ready_at": None,
            "stopped_at": None, "expires_at": None, "error": "boom", "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(self.root / "dep2.log"),
            "work_dir": str(self.root / "dep2"),
        })

        reopened = self._supervisor()
        self.assertEqual(reopened.resummarized, [])
        self.assertIsNone(reopened.store.get_deployment("dep2")["network"])


class DeployHostCase(unittest.TestCase):
    """The site listener's bind address. Configurable because loopback is unreachable
    from outside a container, and the readiness probe follows it. Passed to nsdeploy
    only when it differs from the default, so an unmodified nsdeploy still works."""

    def test_the_bind_address_is_passed_when_the_engine_accepts_it(self):
        """A non-default bind address reaches nsdeploy — if this engine can take it.

        Conditional because `--host` is the one flag this project added to the engine
        and upstream drops keep removing it. Asserting it unconditionally made the
        suite fail against a stock nsdeploy, which reports the wrong thing: the engine
        is not broken, the service simply has to cope. When the flag is absent the
        service refuses the configuration instead, which the companion assertion below
        covers.
        """
        import sys

        from nsdeploy_service.supervisor import (
            DeploymentError,
            Supervisor,
            engine_supports_host,
        )

        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(work_root=Path(tmp), port_start=8750, port_end=8759,
                                deploy_host="0.0.0.0")
            supervisor = Supervisor(settings)
            try:
                dep = supervisor.create(b"x", DeployOptions(name="demo"))
                if engine_supports_host(sys.executable):
                    cmd = supervisor._command(dep)
                    self.assertIn("--host", cmd)
                    self.assertEqual(cmd[cmd.index("--host") + 1], "0.0.0.0")
                else:
                    # Refused up front rather than passed to an engine that would
                    # reject the whole command, or worse, accept and ignore it.
                    with self.assertRaises(DeploymentError):
                        supervisor._command(dep)
            finally:
                supervisor.ports.release(dep.port)
                supervisor.store.close()

    def test_no_host_flag_at_the_default(self):
        """--host is a flag this project added to nsdeploy. Omitting it unless it is
        actually needed is what lets the service run against an unmodified
        nsdeploy — loopback is already nsdeploy's own default."""
        from nsdeploy_service.supervisor import Supervisor

        with tempfile.TemporaryDirectory() as tmp:
            supervisor = Supervisor(Settings(work_root=Path(tmp),
                                             port_start=8760, port_end=8769))
            try:
                dep = supervisor.create(b"x", DeployOptions(name="demo"))
                self.assertNotIn("--host", supervisor._command(dep))
            finally:
                supervisor.ports.release(dep.port)
                supervisor.store.close()

    def test_a_wildcard_bind_is_probed_over_loopback(self):
        from nsdeploy_service.supervisor import probe_host

        for wildcard in ("0.0.0.0", "::", "*", ""):
            with self.subTest(wildcard=wildcard):
                self.assertEqual(probe_host(wildcard), "127.0.0.1")

    def test_a_specific_bind_is_probed_at_that_address(self):
        from nsdeploy_service.supervisor import probe_host

        self.assertEqual(probe_host("10.1.2.3"), "10.1.2.3")
        self.assertEqual(probe_host("127.0.0.1"), "127.0.0.1")


class PortProbeCase(unittest.TestCase):
    def test_a_port_with_a_live_listener_is_not_free(self):
        """SO_REUSEADDR on the probe made this pass on Windows even with a listener,
        so the pool handed out ports that were still serving another site."""
        import socket

        from nsdeploy_service.ports import PortPool

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            pool = PortPool(port, port)
            self.assertFalse(pool._is_free(port))
            with self.assertRaises(PortPoolExhausted):
                pool.reserve()

    def test_a_free_port_is_reserved(self):
        from nsdeploy_service.ports import PortPool

        pool = PortPool(8710, 8719)
        self.assertIn(pool.reserve(), range(8710, 8720))


if __name__ == "__main__":
    unittest.main()
