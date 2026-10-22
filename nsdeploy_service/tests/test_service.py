import json
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus, DeployOptions, NetworkSummary
from nsdeploy_service.ports import PortPool, PortPoolExhausted
from nsdeploy_service.supervisor import (
    DeploymentError,
    Supervisor,
    _error_excerpt,
    _parse_report,
    build_warnings,
    safe_network_name,
    summarize_build,
)

# A verbatim slice of nsdeploy's stdout report — the format the service parses tool
# and agent *names* out of (they are not recorded anywhere in the generated bundle).
SAMPLE_REPORT = """\
▶ Resolving travel_agent_system.hocon (tools from github:cognizant-ai-lab/neuro-san-studio@main) …

Network:   travel_agent_system
Front-man: travel_concierge_orchestrator
Agents:    10

✅ Hostable tools (will run as local MCP servers): 2
   • ddgs_search  →  neuro_san_studio.coded_tools.ddgs_search.DdgsSearch  (MCP /_mcp/0/mcp)
   • wikimedia_media_search  →  neuro_san_studio.coded_tools.wikimedia.Search  (MCP /_mcp/1/mcp)

⚠️  DEMO-MODE agents — NOT GROUNDED (2): these fabricate
    realistic-looking answers instead of using real data/tools.
   • traveler_intake_agent
   • itinerary_builder_agent

⚠️  Missing tools — NOT available in this studio checkout (2):
    these references are dropped from the deployed network;
   • web_fetch
   • webpage_rag

\U0001f517 Agent-network link slots (1):
   • flight_search_agent: demo fallback active (replaceable at link time)

    External MCP (proxied): /ext-mcp/0/mcp  →  https://api.you.com/mcp?profile=free
"""


class SafeNetworkNameTest(unittest.TestCase):
    def test_accepts_plain_identifiers_and_strips_known_suffix(self):
        self.assertEqual(safe_network_name("travel_agent_system"), "travel_agent_system")
        self.assertEqual(safe_network_name("travel_agent_system.hocon"), "travel_agent_system")
        self.assertEqual(safe_network_name("my-net.conf"), "my-net")
        self.assertEqual(safe_network_name("  spaced_out.hocon  "), "spaced_out")

    def test_strips_a_browsers_duplicate_download_marker(self):
        # Downloading a network's HOCON, editing it and uploading it again is a normal
        # round trip, and every browser names the second copy "thing (1).hocon".
        self.assertEqual(
            safe_network_name("acute_care_hospital_network (1).hocon"),
            "acute_care_hospital_network")
        self.assertEqual(safe_network_name("my-net (12).conf"), "my-net")
        # deploy.js renames .hocon to .txt on the way out, so that combination is the
        # one that actually arrives from the console.
        self.assertEqual(safe_network_name("travel_agent_system (2).txt"),
                         "travel_agent_system")
        self.assertEqual(safe_network_name("travel_agent_system(3)"),
                         "travel_agent_system")

    def test_duplicate_marker_removal_does_not_loosen_the_rule(self):
        # Only a trailing parenthesised integer goes; a space anywhere else, or a
        # marker that leaves nothing behind, is still an error rather than a rename.
        for bad in ("my network (1).hocon", "(1).hocon", "(1)", "net (1) extra.hocon",
                    "net (x).hocon", "../../evil (1).hocon"):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)

    def test_rejects_traversal_rather_than_renaming(self):
        # The bug this guards: Path(x).stem quietly turned "../../evil" into "evil".
        for bad in ("../../evil", "..\\evil", "/etc/passwd", "a/b", "a\\b", ".."):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)

    def test_rejects_empty_odd_and_overlong_names(self):
        for bad in ("", "   ", "my network", "-leading", "weird$name", "a" * 65, ".hocon"):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)


class PortPoolTest(unittest.TestCase):
    def test_reserves_distinct_ports_and_reuses_after_release(self):
        pool = PortPool(8300, 8302)
        first, second = pool.reserve(), pool.reserve()
        self.assertNotEqual(first, second)
        self.assertEqual(pool.reserved(), {first, second})
        pool.release(first)
        self.assertEqual(pool.reserve(), first)

    def test_raises_when_exhausted(self):
        pool = PortPool(8310, 8310)
        pool.reserve()
        with self.assertRaises(PortPoolExhausted):
            pool.reserve()

    def test_skips_ports_already_listening(self):
        import socket

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
            held.bind(("127.0.0.1", 0))
            held.listen(1)
            busy = held.getsockname()[1]
            pool = PortPool(busy, busy + 1)
            self.assertEqual(pool.reserve(), busy + 1)

    def test_rejects_inverted_range(self):
        with self.assertRaises(ValueError):
            PortPool(8400, 8399)


class SettingsTest(unittest.TestCase):
    def test_site_url_uses_port_form_by_default(self):
        settings = Settings(public_host="127.0.0.1", port_start=8100, port_end=8199)
        self.assertEqual(settings.site_url("abc123", 8105), "http://127.0.0.1:8105")

    def test_site_url_uses_subdomain_form_when_templated(self):
        settings = Settings(public_scheme="https", public_host="deploys.example.com",
                            subdomain_template="{id}")
        self.assertEqual(settings.site_url("abc123", 8105), "https://abc123.deploys.example.com")

    def test_rejects_service_port_inside_the_deployment_pool(self):
        # Otherwise the API and a deployed site would fight over the same port.
        with self.assertRaises(ValueError):
            Settings(port=8150, port_start=8100, port_end=8199).validate()

    def test_rejects_capacity_larger_than_the_pool(self):
        with self.assertRaises(ValueError):
            Settings(port_start=8100, port_end=8104, max_deployments=20).validate()

    def test_rejects_inverted_pool(self):
        with self.assertRaises(ValueError):
            Settings(port_start=8200, port_end=8100).validate()


class UiVersionTest(unittest.TestCase):
    """The console's asset version, reported on /health.

    This exists because `Cache-Control: no-cache` on index.html only helps a *fresh*
    navigation. A tab already open when the service is updated never re-navigates and
    keeps running its old JavaScript — which looks exactly like a broken UI, and was
    reported as "I clicked Deploy and nothing happened" on a build where that button
    had been renamed. The console compares this value with the one it booted with.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ui = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, html):
        (self.ui / "index.html").write_text(html, encoding="utf-8")

    def test_reads_the_pinned_version(self):
        from nsdeploy_service.app import read_ui_version

        self._write('<link href="a.css?v=18"><script src="b.js?v=18"></script>')
        self.assertEqual(read_ui_version(self.ui), "18")

    def test_no_index_html_reports_nothing(self):
        """'Cannot tell' must be distinguishable from a mismatch, or a console with
        no readable version would nag about an update on every poll."""
        from nsdeploy_service.app import read_ui_version

        self.assertEqual(read_ui_version(self.ui), "")

    def test_unversioned_assets_report_nothing(self):
        from nsdeploy_service.app import read_ui_version

        self._write('<link href="a.css"><script src="b.js"></script>')
        self.assertEqual(read_ui_version(self.ui), "")

    def test_disagreeing_versions_report_nothing(self):
        """A document that pins its assets to two different versions has no single
        answer, and guessing one would compare against the wrong thing."""
        from nsdeploy_service.app import read_ui_version

        self._write('<link href="a.css?v=18"><script src="b.js?v=17"></script>')
        self.assertEqual(read_ui_version(self.ui), "")

    def test_health_reports_it(self):
        from fastapi.testclient import TestClient

        from nsdeploy_service.app import create_app

        self._write('<link href="a.css?v=42">')
        settings = Settings(work_root=self.ui / "work", ui_dir=self.ui,
                            port_start=8730, port_end=8739)
        with TestClient(create_app(settings)) as client:
            self.assertEqual(client.get("/health").json()["ui_version"], "42")


class ReportParsingTest(unittest.TestCase):
    def test_extracts_names_per_section(self):
        parsed = _parse_report(SAMPLE_REPORT)
        self.assertEqual(parsed["hostable_tools"], ["ddgs_search", "wikimedia_media_search"])
        self.assertEqual(parsed["missing_tools"], ["web_fetch", "webpage_rag"])
        self.assertEqual(parsed["demo_mode_agents"],
                         ["traveler_intake_agent", "itinerary_builder_agent"])
        self.assertEqual(parsed["external_mcps"], ["https://api.you.com/mcp?profile=free"])

    def test_does_not_leak_link_slot_bullets_into_other_sections(self):
        # Link-slot bullets sit under an unparsed header; a blank line must end the
        # previous section so they are not misattributed to "Missing tools".
        parsed = _parse_report(SAMPLE_REPORT)
        for key in ("hostable_tools", "missing_tools", "demo_mode_agents"):
            self.assertNotIn("flight_search_agent", parsed[key])

    def test_tolerates_output_with_no_recognisable_sections(self):
        parsed = _parse_report("nothing useful here\n")
        self.assertEqual(parsed["hostable_tools"], [])
        self.assertEqual(parsed["external_mcps"], [])


class SummarizeBuildTest(unittest.TestCase):
    def test_reads_bundle_for_structure_and_log_for_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            (out / "agent-manifest.json").write_text(json.dumps({
                "brand": "Travel Agent System",
                "agent_mcp": {"front_man": "travel_concierge_orchestrator"},
                "networks": [{"description": "concierge", "sample_queries": ["q1"]}],
            }), encoding="utf-8")
            (out / "travel_agent_system.network.json").write_text(json.dumps({
                "tools": [{"name": f"a{i}"} for i in range(10)],
                "link_slots": {"flight_search_agent": {"callers": ["x"]}},
            }), encoding="utf-8")

            summary = summarize_build(out, "travel_agent_system", SAMPLE_REPORT)

        self.assertEqual(summary.front_man, "travel_concierge_orchestrator")
        self.assertEqual(summary.agent_count, 10)
        self.assertEqual(summary.brand, "Travel Agent System")
        self.assertEqual(summary.link_slots, ["flight_search_agent"])
        self.assertEqual(summary.sample_queries, ["q1"])
        self.assertEqual(summary.hostable_tools, ["ddgs_search", "wikimedia_media_search"])

    def test_missing_bundle_files_yield_an_empty_summary_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = summarize_build(Path(tmp), "absent", "")
        self.assertEqual(summary.front_man, "")
        self.assertEqual(summary.agent_count, 0)


class WarningsTest(unittest.TestCase):
    def test_flags_dropped_tools_demo_agents_and_open_link_slots(self):
        warnings = build_warnings(NetworkSummary(
            missing_tools=["web_fetch"],
            demo_mode_agents=["intake"],
            link_slots=["flight_search_agent"],
        ))
        self.assertEqual(len(warnings), 3)
        self.assertIn("web_fetch", warnings[0])
        self.assertIn("demo_mode", warnings[1])
        self.assertIn("flight_search_agent", warnings[2])

    def test_clean_network_has_no_warnings(self):
        self.assertEqual(build_warnings(NetworkSummary(front_man="x", agent_count=3)), [])


class ErrorExcerptTest(unittest.TestCase):
    def _log(self, tmp: str, text: str) -> Path:
        path = Path(tmp) / "nsdeploy.log"
        path.write_text(text, encoding="utf-8")
        return path

    def test_summarizes_a_hocon_parse_failure_instead_of_dumping_the_grammar(self):
        noise = "pyparsing.exceptions.ParseSyntaxException: Expected " + "{'x' | 'y'} " * 400
        with tempfile.TemporaryDirectory() as tmp:
            path = self._log(tmp, f"{noise}\nfound end of text  (at char 1), (line:1, col:2)\n")
            excerpt = _error_excerpt(path, 1)
        self.assertIn("HOCON could not be parsed", excerpt)
        self.assertIn("line 1, column 2", excerpt)
        self.assertLess(len(excerpt), 300)

    def test_prefers_nsdeploys_own_error_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._log(tmp, "▶ Resolving x\nerror: no front-man agent found.\n")
            excerpt = _error_excerpt(path, 1)
        self.assertIn("no front-man agent found.", excerpt)

    def test_falls_back_to_the_last_exception_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._log(tmp, "Traceback...\nRuntimeError: could not start MCP tool ddgs\n")
            excerpt = _error_excerpt(path, 3)
        self.assertIn("RuntimeError", excerpt)
        self.assertIn("could not start MCP tool ddgs", excerpt)

    def test_reports_status_when_there_is_no_log(self):
        self.assertIn("status 9", _error_excerpt(Path("does-not-exist.log"), 9))


class SupervisorCreateTest(unittest.TestCase):
    """create() validates and reserves; it must not spawn anything."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._supervisors = []

    def tearDown(self):
        # Each Supervisor owns an open SQLite handle; Windows will not unlink the
        # tempdir while one is still open, so close before cleanup.
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self, **overrides) -> Supervisor:
        settings = Settings(work_root=Path(self._tmp.name), port_start=8500, port_end=8509,
                            max_deployments=overrides.pop("max_deployments", 10), **overrides)
        supervisor = Supervisor(settings)
        self._supervisors.append(supervisor)
        return supervisor

    def test_writes_the_hocon_and_reserves_a_port_without_starting_a_process(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b'{"tools": []}', DeployOptions(name="demo.hocon"))
        self.assertEqual(dep.name, "demo")
        self.assertEqual(dep.status, DeploymentStatus.QUEUED)
        self.assertIsNone(dep.process)
        self.assertTrue(dep.hocon_path.is_file())
        self.assertEqual(dep.hocon_path.read_text(encoding="utf-8"), '{"tools": []}')
        self.assertIn(dep.port, supervisor.ports.reserved())
        self.assertEqual(dep.url, f"http://127.0.0.1:{dep.port}")

    def test_endpoints_are_hidden_until_the_site_is_ready(self):
        dep = self._supervisor().create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.endpoints(), {})
        dep.status = DeploymentStatus.READY
        self.assertEqual(dep.endpoints()["mcp_facade"], f"{dep.url}/mcp")

    def test_rejects_empty_oversized_and_non_utf8_uploads(self):
        supervisor = self._supervisor(max_hocon_bytes=32)
        with self.assertRaises(DeploymentError):
            supervisor.create(b"   \n", DeployOptions(name="demo"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x" * 64, DeployOptions(name="demo"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"\xff\xfe\x00bad", DeployOptions(name="demo"))

    def test_rejects_beyond_capacity_and_frees_nothing_reserved(self):
        supervisor = self._supervisor(max_deployments=2)
        for i in range(2):
            supervisor.create(b"x", DeployOptions(name=f"demo{i}"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo3"))
        self.assertEqual(len(supervisor.ports.reserved()), 2)

    def test_ttl_override_of_zero_means_no_expiry(self):
        supervisor = self._supervisor(ttl_seconds=3600)
        forever = supervisor.create(b"x", DeployOptions(name="forever", ttl_seconds=0))
        default = supervisor.create(b"x", DeployOptions(name="default"))
        self.assertIsNone(forever.expires_at)
        self.assertIsNotNone(default.expires_at)

    def test_deployments_are_long_lived_by_default(self):
        # Long-lived is the chosen product behaviour: an org's URL stays up until
        # somebody stops it, so the default TTL must be off.
        self.assertEqual(Settings().ttl_seconds, 0)
        dep = self._supervisor().create(b"x", DeployOptions(name="demo"))
        self.assertIsNone(dep.expires_at)

    # --- organization attribution -------------------------------------------
    # The console asks for one free-text organization name rather than making an
    # operator create a profile and then pick its id, so org_name is get-or-create.

    def test_org_name_creates_the_organization_on_first_use(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo", org_name="Acme Logistics"))
        self.assertEqual(dep.org_name, "Acme Logistics")
        self.assertIsNotNone(supervisor.store.find_org_by_name("Acme Logistics"))

    def test_the_same_org_name_reuses_one_organization(self):
        """Two uploads by the same team must not produce two organizations —
        otherwise the map labels them as unrelated owners."""
        supervisor = self._supervisor()
        first = supervisor.create(b"x", DeployOptions(name="a", org_name="Acme Logistics"))
        # Different case and spacing: the same team typing their name again.
        second = supervisor.create(b"x", DeployOptions(name="b", org_name="  acme   logistics "))
        self.assertEqual(first.org_id, second.org_id)
        self.assertEqual(
            len([o for o in supervisor.store.list_orgs() if "ogistics" in o["name"]]), 1)

    def test_org_id_wins_over_org_name(self):
        supervisor = self._supervisor()
        existing = supervisor.store.create_org("Chosen Org")
        dep = supervisor.create(b"x", DeployOptions(
            name="demo", org_id=existing["id"], org_name="Ignored Org"))
        self.assertEqual(dep.org_id, existing["id"])
        self.assertIsNone(supervisor.store.find_org_by_name("Ignored Org"))

    def test_an_unknown_org_id_is_rejected_rather_than_reattributed(self):
        """A caller naming a specific organization that is gone is an error. Quietly
        re-attributing their network to Unattributed would hide that."""
        supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_id="nope"))

    def test_an_unusable_org_name_is_bad_input_not_a_conflict(self):
        supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_name="x" * 200))

    def test_neither_falls_back_to_the_unattributed_org(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])

    def test_a_blank_org_name_falls_back_rather_than_creating_a_nameless_org(self):
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo", org_name="   "))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])

    def test_command_declares_the_site_url_that_will_be_returned(self):
        # The origin is baked into the generated bundle, so --site-url must match
        # the URL handed to the caller or the site's own MCP URLs point elsewhere.
        supervisor = self._supervisor()
        dep = supervisor.create(b"x", DeployOptions(name="demo"))
        cmd = supervisor._command(dep)
        self.assertEqual(cmd[cmd.index("--site-url") + 1], dep.url)
        self.assertEqual(cmd[cmd.index("--port") + 1], str(dep.port))
        self.assertNotIn("--theme", cmd)

    def test_per_deployment_options_override_service_defaults(self):
        supervisor = self._supervisor(upstream="https://default/v1")
        dep = supervisor.create(b"x", DeployOptions(
            name="demo", upstream="https://override/v1", theme=True,
            theme_model="gpt-5.5", cruse=False))
        cmd = supervisor._command(dep)
        self.assertEqual(cmd[cmd.index("--upstream") + 1], "https://override/v1")
        self.assertEqual(cmd[cmd.index("--theme-model") + 1], "gpt-5.5")
        self.assertIn("--no-cruse", cmd)


if __name__ == "__main__":
    unittest.main()
