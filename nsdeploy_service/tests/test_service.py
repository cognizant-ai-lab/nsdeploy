import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import unittest
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Tuple
from pathlib import Path
from unittest import mock
from unittest.case import _AssertRaisesContext

import httpx
from fastapi.testclient import TestClient

from nsdeploy_service import __version__
from nsdeploy_service.app import ORG_NAME_MAX
from nsdeploy_service.app import ORG_NAME_PATTERN
from nsdeploy_service.app import create_app
from nsdeploy_service.app import read_ui_version
from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.models import NetworkSummary
from nsdeploy_service.ports import PortPool
from nsdeploy_service.ports import PortPoolExhausted
from nsdeploy_service.supervisor import Deployment
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import Supervisor
from nsdeploy_service.supervisor import _error_excerpt
from nsdeploy_service.supervisor import _parse_report
from nsdeploy_service.supervisor import build_warnings
from nsdeploy_service.supervisor import engine_supports_host
from nsdeploy_service.supervisor import safe_network_name
from nsdeploy_service.supervisor import summarize_build

# A verbatim slice of nsdeploy's stdout report — the format the service parses tool
# and agent *names* out of (they are not recorded anywhere in the generated bundle).
SAMPLE_REPORT: str = """\
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
    """Validates and normalizes uploaded network names."""
    def test_accepts_plain_identifiers_and_strips_known_suffix(self) -> None:
        """Plain identifiers pass and a known HOCON suffix is stripped."""
        self.assertEqual(safe_network_name("travel_agent_system"), "travel_agent_system")
        self.assertEqual(safe_network_name("travel_agent_system.hocon"), "travel_agent_system")
        self.assertEqual(safe_network_name("my-net.conf"), "my-net")
        self.assertEqual(safe_network_name("  spaced_out.hocon  "), "spaced_out")

    def test_strips_a_browsers_duplicate_download_marker(self) -> None:
        """A browser's duplicate-download marker such as ' (1)' is stripped."""
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

    def test_duplicate_marker_removal_does_not_loosen_the_rule(self) -> None:
        """Stripping the duplicate marker does not accept otherwise invalid names."""
        # Only a trailing parenthesised integer goes; a space anywhere else, or a
        # marker that leaves nothing behind, is still an error rather than a rename.
        bad: str
        for bad in ("my network (1).hocon", "(1).hocon", "(1)", "net (1) extra.hocon",
                    "net (x).hocon", "../../evil (1).hocon"):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)

    def test_rejects_traversal_rather_than_renaming(self) -> None:
        """Path traversal attempts are rejected rather than renamed."""
        # The bug this guards: Path(x).stem quietly turned "../../evil" into "evil".
        bad: str
        for bad in ("../../evil", "..\\evil", "/etc/passwd", "a/b", "a\\b", ".."):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)

    def test_rejects_empty_odd_and_overlong_names(self) -> None:
        """Empty, malformed and overlong names are rejected."""
        bad: str
        for bad in ("", "   ", "my network", "-leading", "weird$name", "a" * 65, ".hocon"):
            with self.subTest(bad=bad):
                with self.assertRaises(DeploymentError):
                    safe_network_name(bad)


class PortPoolTest(unittest.TestCase):
    """Reserves and releases deployment ports from a bounded range."""
    def test_reserves_distinct_ports_and_reuses_after_release(self) -> None:
        """Reserved ports are distinct, and a released port is reused."""
        pool: PortPool = PortPool(8300, 8302)
        first: int
        second: int
        first, second = pool.reserve(), pool.reserve()
        self.assertNotEqual(first, second)
        self.assertEqual(pool.reserved(), {first, second})
        pool.release(first)
        self.assertEqual(pool.reserve(), first)

    def test_raises_when_exhausted(self) -> None:
        """Reserving from an exhausted pool raises PortPoolExhausted."""
        pool: PortPool = PortPool(8310, 8310)
        pool.reserve()
        with self.assertRaises(PortPoolExhausted):
            pool.reserve()

    def test_skips_ports_already_listening(self) -> None:
        """A port that something already listens on is skipped."""
        held: socket.socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
            held.bind(("127.0.0.1", 0))
            held.listen(1)
            busy: int = held.getsockname()[1]
            pool: PortPool = PortPool(busy, busy + 1)
            self.assertEqual(pool.reserve(), busy + 1)

    def test_rejects_inverted_range(self) -> None:
        """An inverted port range is rejected."""
        with self.assertRaises(ValueError):
            PortPool(8400, 8399)


class SettingsTest(unittest.TestCase):
    """Builds site URLs and validates the service settings."""
    def test_site_url_uses_port_form_by_default(self) -> None:
        """The site URL uses the host:port form by default."""
        settings: Settings = Settings(public_host="127.0.0.1", port_start=8100, port_end=8199)
        self.assertEqual(settings.site_url("abc123", 8105), "http://127.0.0.1:8105")

    def test_site_url_uses_subdomain_form_when_templated(self) -> None:
        """The site URL uses the subdomain form when a template is set."""
        settings: Settings = Settings(public_scheme="https", public_host="deploys.example.com",
                                      subdomain_template="{id}")
        self.assertEqual(settings.site_url("abc123", 8105), "https://abc123.deploys.example.com")

    def test_rejects_service_port_inside_the_deployment_pool(self) -> None:
        """A service port inside the deployment pool is rejected."""
        # Otherwise the API and a deployed site would fight over the same port.
        with self.assertRaises(ValueError):
            Settings(port=8150, port_start=8100, port_end=8199).validate()

    def test_rejects_capacity_larger_than_the_pool(self) -> None:
        """A capacity larger than the port pool is rejected."""
        with self.assertRaises(ValueError):
            Settings(port_start=8100, port_end=8104, max_deployments=20).validate()

    def test_rejects_inverted_pool(self) -> None:
        """An inverted port pool is rejected."""
        with self.assertRaises(ValueError):
            Settings(port_start=8200, port_end=8100).validate()

    def test_reads_the_site_env_allow_list_from_the_environment(self) -> None:
        """
        NSDEPLOY_SERVICE_SITE_ENV_ALLOW is read as a comma-separated list of names.
        """
        with mock.patch.dict(os.environ, {"NSDEPLOY_SERVICE_SITE_ENV_ALLOW": "OPENAI_API_KEY, GEMINI_API_KEY"}):
            settings: Settings = Settings.from_env()
        self.assertEqual(settings.site_env_allow, ["OPENAI_API_KEY", "GEMINI_API_KEY"])
        self.assertEqual(Settings().site_env_allow, [])

    def test_health_warns_when_theming_cannot_get_the_key(self) -> None:
        """
        /health warns when THEME is on but site builds do not get OPENAI_API_KEY, and not once it is listed.
        """
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            withheld: Settings = Settings(work_root=Path(tmp) / "withheld", port_start=8900, port_end=8909, theme=True)
            listed: Settings = Settings(work_root=Path(tmp) / "listed", port_start=8900, port_end=8909, theme=True,
                                        site_env_allow=["OPENAI_API_KEY"])
            client: TestClient
            with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "fake-openai-key"}):
                with TestClient(create_app(withheld)) as client:
                    warned: List[str] = client.get("/health").json().get("warnings")
                with TestClient(create_app(listed)) as client:
                    quiet: List[str] = client.get("/health").json().get("warnings")
        self.assertIn("SITE_ENV_ALLOW", " ".join(warned))
        # /health needs no token, so its warnings must never contain the key itself.
        self.assertNotIn("fake-openai-key", " ".join(warned))
        self.assertNotIn("SITE_ENV_ALLOW", " ".join(quiet))

    def test_health_warns_when_theme_is_on_without_a_key(self) -> None:
        """
        /health warns when THEME is on and OPENAI_API_KEY is not set at all.
        """
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            settings: Settings = Settings(work_root=Path(tmp), port_start=8900, port_end=8909, theme=True)
            # patch.dict restores the environment on exit, including the removed key.
            with mock.patch.dict(os.environ):
                os.environ.pop("OPENAI_API_KEY", None)
                client: TestClient
                with TestClient(create_app(settings)) as client:
                    warnings: List[str] = client.get("/health").json().get("warnings")
        self.assertIn("OPENAI_API_KEY is not set", " ".join(warnings))

    def test_health_warns_when_the_allow_list_names_a_service_credential(self) -> None:
        """
        /health warns when SITE_ENV_ALLOW lists one of the service's own credentials, which sites never receive.
        """
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            settings: Settings = Settings(work_root=Path(tmp), port_start=8900, port_end=8909,
                                          site_env_allow=["NSDEPLOY_SERVICE_API_TOKEN"])
            client: TestClient
            with TestClient(create_app(settings)) as client:
                warnings: List[str] = client.get("/health").json().get("warnings")
        self.assertIn("NSDEPLOY_SERVICE_API_TOKEN", " ".join(warnings))


class UiVersionTest(unittest.TestCase):
    """The console's asset version, reported on /health.

    This exists because `Cache-Control: no-cache` on index.html only helps a *fresh*
    navigation. A tab already open when the service is updated never re-navigates and
    keeps running its old JavaScript — which looks exactly like a broken UI, and was
    reported as "I clicked Deploy and nothing happened" on a build where that button
    had been renamed. The console compares this value with the one it booted with.
    """

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.ui: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write(self, html: str) -> None:
        (self.ui / "index.html").write_text(html, encoding="utf-8")

    def test_reads_the_pinned_version(self) -> None:
        """The version pinned on the asset URLs is reported."""
        self._write('<link href="a.css?v=18"><script src="b.js?v=18"></script>')
        self.assertEqual(read_ui_version(self.ui), "18")

    def test_no_index_html_reports_nothing(self) -> None:
        """'Cannot tell' must be distinguishable from a mismatch, or a console with
        no readable version would nag about an update on every poll."""
        self.assertEqual(read_ui_version(self.ui), "")

    def test_unversioned_assets_report_nothing(self) -> None:
        """Assets with no version pin report an empty version."""
        self._write('<link href="a.css"><script src="b.js"></script>')
        self.assertEqual(read_ui_version(self.ui), "")

    def test_disagreeing_versions_report_nothing(self) -> None:
        """A document that pins its assets to two different versions has no single
        answer, and guessing one would compare against the wrong thing."""
        self._write('<link href="a.css?v=18"><script src="b.js?v=17"></script>')
        self.assertEqual(read_ui_version(self.ui), "")

    def test_health_reports_it(self) -> None:
        """/health reports the console's asset version."""
        self._write('<link href="a.css?v=42">')
        settings: Settings = Settings(work_root=self.ui / "work", ui_dir=self.ui,
                                      port_start=8730, port_end=8739)
        client: TestClient
        with TestClient(create_app(settings)) as client:
            self.assertEqual(client.get("/health").json()["ui_version"], "42")

    def test_health_reports_the_build(self) -> None:
        """/health reports the configured build, falling back to the package version."""
        self._write('<link href="a.css?v=42">')
        build: str
        expected: str
        client: TestClient
        for build, expected in (("1.2.3", "1.2.3"), ("", __version__)):
            settings: Settings = Settings(work_root=self.ui / "work", ui_dir=self.ui,
                                          port_start=8730, port_end=8739, build_version=build)
            with TestClient(create_app(settings)) as client:
                self.assertEqual(client.get("/health").json()["build"], expected)


class ReportParsingTest(unittest.TestCase):
    """Extracts tool and agent names from the nsdeploy stdout report."""
    def test_extracts_names_per_section(self) -> None:
        """Each report section yields its own list of names."""
        parsed: Dict[str, List[str]] = _parse_report(SAMPLE_REPORT)
        self.assertEqual(parsed["hostable_tools"], ["ddgs_search", "wikimedia_media_search"])
        self.assertEqual(parsed["missing_tools"], ["web_fetch", "webpage_rag"])
        self.assertEqual(parsed["demo_mode_agents"],
                         ["traveler_intake_agent", "itinerary_builder_agent"])
        self.assertEqual(parsed["external_mcps"], ["https://api.you.com/mcp?profile=free"])

    def test_does_not_leak_link_slot_bullets_into_other_sections(self) -> None:
        """Link-slot bullets do not leak into the preceding section."""
        # Link-slot bullets sit under an unparsed header; a blank line must end the
        # previous section so they are not misattributed to "Missing tools".
        parsed: Dict[str, List[str]] = _parse_report(SAMPLE_REPORT)
        key: str
        for key in ("hostable_tools", "missing_tools", "demo_mode_agents"):
            self.assertNotIn("flight_search_agent", parsed[key])

    def test_tolerates_output_with_no_recognisable_sections(self) -> None:
        """Output with no recognizable sections yields empty lists."""
        parsed: Dict[str, List[str]] = _parse_report("nothing useful here\n")
        self.assertEqual(parsed["hostable_tools"], [])
        self.assertEqual(parsed["external_mcps"], [])


class SummarizeBuildTest(unittest.TestCase):
    """Summarizes a build from its bundle files and its report."""
    def test_reads_bundle_for_structure_and_log_for_names(self) -> None:
        """Structure comes from the bundle and names come from the log."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            out: Path = Path(tmp)
            (out / "agent-manifest.json").write_text(json.dumps({
                "brand": "Travel Agent System",
                "agent_mcp": {"front_man": "travel_concierge_orchestrator"},
                "networks": [{"description": "concierge", "sample_queries": ["q1"]}],
            }), encoding="utf-8")
            (out / "travel_agent_system.network.json").write_text(json.dumps({
                "tools": [{"name": f"a{i}"} for i in range(10)],
                "link_slots": {"flight_search_agent": {"callers": ["x"]}},
            }), encoding="utf-8")

            summary: NetworkSummary = summarize_build(out, "travel_agent_system", SAMPLE_REPORT)

        self.assertEqual(summary.front_man, "travel_concierge_orchestrator")
        self.assertEqual(summary.agent_count, 10)
        self.assertEqual(summary.brand, "Travel Agent System")
        self.assertEqual(summary.link_slots, ["flight_search_agent"])
        self.assertEqual(summary.sample_queries, ["q1"])
        self.assertEqual(summary.hostable_tools, ["ddgs_search", "wikimedia_media_search"])

    def test_missing_bundle_files_yield_an_empty_summary_not_an_error(self) -> None:
        """Missing bundle files yield an empty summary rather than an error."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            summary: NetworkSummary = summarize_build(Path(tmp), "absent", "")
        self.assertEqual(summary.front_man, "")
        self.assertEqual(summary.agent_count, 0)

    def test_records_the_front_mans_own_purpose_separately_from_the_tagline(self) -> None:
        """Theming rewrites `networks[0].description` and leaves the agent alone.

        On a themed build the two diverge completely: the manifest carries a brand
        tagline while the front-man still has the paragraph its author wrote. The
        console's connect prompt needs the paragraph, because a tagline cannot tell an
        agent-network designer what a down-chain agent actually does.
        """
        indented: str = "\n    Sets business priorities\n    and delegates execution.\n    "
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            out: Path = Path(tmp)
            (out / "agent-manifest.json").write_text(json.dumps({
                "agent_mcp": {"front_man": "general_manager"},
                "networks": [{"description": "Prep, staff, sell, recover."}],
            }), encoding="utf-8")
            (out / "food_truck_ops_network.network.json").write_text(json.dumps({
                "tools": [
                    {"name": "kitchen_prep_line_lead",
                     "function": {"description": "Runs the prep line."}},
                    # HOCON block strings arrive wrapped and indented.
                    {"name": "general_manager",
                     "function": {"description": indented}},
                ],
            }), encoding="utf-8")

            summary: NetworkSummary = summarize_build(out, "food_truck_ops_network", "")

        self.assertEqual(summary.description, "Prep, staff, sell, recover.")
        # Whitespace collapsed, and taken from the front-man rather than the first agent.
        self.assertEqual(
            summary.front_man_description,
            "Sets business priorities and delegates execution.",
        )

    def test_a_front_man_with_no_description_is_empty_not_an_error(self) -> None:
        """A front-man with no description yields an empty description."""
        # Also covers a front-man absent from `tools` entirely, which `next(..., "")`
        # has to absorb rather than raising StopIteration.
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            out: Path = Path(tmp)
            (out / "agent-manifest.json").write_text(json.dumps({
                "agent_mcp": {"front_man": "nobody"},
                "networks": [{"description": "x"}],
            }), encoding="utf-8")
            (out / "n.network.json").write_text(json.dumps({
                "tools": [{"name": "someone_else", "function": {"description": "d"}}],
            }), encoding="utf-8")

            summary: NetworkSummary = summarize_build(out, "n", "")

        self.assertEqual(summary.front_man_description, "")


class WarningsTest(unittest.TestCase):
    """Builds the user-facing warnings for a network summary."""
    def test_flags_dropped_tools_demo_agents_and_open_link_slots(self) -> None:
        """Dropped tools, demo-mode agents and open link slots each produce a warning."""
        warnings: List[str] = build_warnings(NetworkSummary(
            missing_tools=["web_fetch"],
            demo_mode_agents=["intake"],
            link_slots=["flight_search_agent"],
        ))
        self.assertEqual(len(warnings), 3)
        self.assertIn("web_fetch", warnings[0])
        self.assertIn("demo_mode", warnings[1])
        self.assertIn("flight_search_agent", warnings[2])

    def test_clean_network_has_no_warnings(self) -> None:
        """A clean network produces no warnings."""
        self.assertEqual(build_warnings(NetworkSummary(front_man="x", agent_count=3)), [])


class ErrorExcerptTest(unittest.TestCase):
    """Extracts a short, readable error from a failed build's log."""
    def _log(self, tmp: str, text: str) -> Path:
        path: Path = Path(tmp) / "nsdeploy.log"
        path.write_text(text, encoding="utf-8")
        return path

    def test_summarizes_a_hocon_parse_failure_instead_of_dumping_the_grammar(self) -> None:
        """A HOCON parse failure is summarized instead of dumping the grammar."""
        noise: str = "pyparsing.exceptions.ParseSyntaxException: Expected " + "{'x' | 'y'} " * 400
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            path: Path = self._log(tmp, f"{noise}\nfound end of text  (at char 1), (line:1, col:2)\n")
            excerpt: str = _error_excerpt(path, 1)
        self.assertIn("HOCON could not be parsed", excerpt)
        self.assertIn("line 1, column 2", excerpt)
        self.assertLess(len(excerpt), 300)

    def test_prefers_nsdeploys_own_error_line(self) -> None:
        """nsdeploy's own error line is preferred over other output."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            path: Path = self._log(tmp, "▶ Resolving x\nerror: no front-man agent found.\n")
            excerpt: str = _error_excerpt(path, 1)
        self.assertIn("no front-man agent found.", excerpt)

    def test_falls_back_to_the_last_exception_line(self) -> None:
        """The last exception line is used when nsdeploy reports no error line."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            path: Path = self._log(tmp, "Traceback...\nRuntimeError: could not start MCP tool ddgs\n")
            excerpt: str = _error_excerpt(path, 3)
        self.assertIn("RuntimeError", excerpt)
        self.assertIn("could not start MCP tool ddgs", excerpt)

    def test_reports_status_when_there_is_no_log(self) -> None:
        """A missing log reports the exit status."""
        self.assertIn("status 9", _error_excerpt(Path("does-not-exist.log"), 9))


class SupervisorCreateTest(unittest.TestCase):
    """create() validates and reserves; it must not spawn anything."""

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self._supervisors: List[Supervisor] = []

    def tearDown(self) -> None:
        # Each Supervisor owns an open SQLite handle; Windows will not unlink the
        # tempdir while one is still open, so close before cleanup.
        supervisor: Supervisor
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self, **overrides: Any) -> Supervisor:
        settings: Settings = Settings(work_root=Path(self._tmp.name), port_start=8500, port_end=8509,
                                      max_deployments=overrides.pop("max_deployments", 10), **overrides)
        supervisor: Supervisor = Supervisor(settings)
        self._supervisors.append(supervisor)
        return supervisor

    def test_writes_the_hocon_and_reserves_a_port_without_starting_a_process(self) -> None:
        """create() writes the HOCON and reserves a port without starting a process."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b'{"tools": []}', DeployOptions(name="demo.hocon"))
        self.assertEqual(dep.name, "demo")
        self.assertEqual(dep.status, DeploymentStatus.QUEUED)
        self.assertIsNone(dep.process)
        self.assertTrue(dep.hocon_path.is_file())
        self.assertEqual(dep.hocon_path.read_text(encoding="utf-8"), '{"tools": []}')
        self.assertIn(dep.port, supervisor.ports.reserved())
        self.assertEqual(dep.url, f"http://127.0.0.1:{dep.port}")

    def test_endpoints_are_hidden_until_the_site_is_ready(self) -> None:
        """Endpoints stay hidden until the site is ready."""
        dep: Deployment = self._supervisor().create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.endpoints(), {})
        dep.status = DeploymentStatus.READY
        self.assertEqual(dep.endpoints()["mcp_facade"], f"{dep.url}/mcp")

    def test_rejects_empty_oversized_and_non_utf8_uploads(self) -> None:
        """Empty, oversized and non-UTF-8 uploads are rejected."""
        supervisor: Supervisor = self._supervisor(max_hocon_bytes=32)
        with self.assertRaises(DeploymentError):
            supervisor.create(b"   \n", DeployOptions(name="demo"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x" * 64, DeployOptions(name="demo"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"\xff\xfe\x00bad", DeployOptions(name="demo"))

    def test_rejects_beyond_capacity_and_frees_nothing_reserved(self) -> None:
        """Creation beyond capacity is rejected without freeing reserved ports."""
        supervisor: Supervisor = self._supervisor(max_deployments=2)
        i: int
        for i in range(2):
            supervisor.create(b"x", DeployOptions(name=f"demo{i}"))
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo3"))
        self.assertEqual(len(supervisor.ports.reserved()), 2)

    def test_ttl_override_of_zero_means_no_expiry(self) -> None:
        """A TTL override of zero means the deployment never expires."""
        supervisor: Supervisor = self._supervisor(ttl_seconds=3600)
        forever: Deployment = supervisor.create(b"x", DeployOptions(name="forever", ttl_seconds=0))
        default: Deployment = supervisor.create(b"x", DeployOptions(name="default"))
        self.assertIsNone(forever.expires_at)
        self.assertIsNotNone(default.expires_at)

    def test_deployments_are_long_lived_by_default(self) -> None:
        """Deployments have no expiry by default."""
        # Long-lived is the chosen product behaviour: an org's URL stays up until
        # somebody stops it, so the default TTL must be off.
        self.assertEqual(Settings().ttl_seconds, 0)
        dep: Deployment = self._supervisor().create(b"x", DeployOptions(name="demo"))
        self.assertIsNone(dep.expires_at)

    # --- organization attribution -------------------------------------------
    # The console asks for one free-text organization name rather than making an
    # operator create a profile and then pick its id, so org_name is get-or-create.

    def test_org_name_creates_the_organization_on_first_use(self) -> None:
        """An org_name creates the organization on first use."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo", org_name="Acme Logistics"))
        self.assertEqual(dep.org_name, "Acme Logistics")
        self.assertIsNotNone(supervisor.store.find_org_by_name("Acme Logistics"))

    def test_the_same_org_name_reuses_one_organization(self) -> None:
        """Two uploads by the same team must not produce two organizations —
        otherwise the map labels them as unrelated owners."""
        supervisor: Supervisor = self._supervisor()
        first: Deployment = supervisor.create(b"x", DeployOptions(name="a", org_name="Acme Logistics"))
        # Different case and spacing: the same team typing their name again.
        second: Deployment = supervisor.create(b"x", DeployOptions(name="b", org_name="  acme   logistics "))
        self.assertEqual(first.org_id, second.org_id)
        self.assertEqual(
            len([o for o in supervisor.store.list_orgs() if "ogistics" in o["name"]]), 1)

    def test_org_id_wins_over_org_name(self) -> None:
        """An explicit org_id takes precedence over org_name."""
        supervisor: Supervisor = self._supervisor()
        existing: Dict[str, Any] = supervisor.store.create_org("Chosen Org")
        dep: Deployment = supervisor.create(b"x", DeployOptions(
            name="demo", org_id=existing["id"], org_name="Ignored Org"))
        self.assertEqual(dep.org_id, existing["id"])
        self.assertIsNone(supervisor.store.find_org_by_name("Ignored Org"))

    def test_an_unknown_org_id_is_rejected_rather_than_reattributed(self) -> None:
        """A caller naming a specific organization that is gone is an error. Quietly
        re-attributing their network to Unattributed would hide that."""
        supervisor: Supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_id="nope"))

    def test_an_unusable_org_name_is_bad_input_not_a_conflict(self) -> None:
        """An unusable org_name is rejected as bad input."""
        supervisor: Supervisor = self._supervisor()
        with self.assertRaises(DeploymentError):
            supervisor.create(b"x", DeployOptions(name="demo", org_name="x" * 200))

    def test_neither_falls_back_to_the_unattributed_org(self) -> None:
        """With neither org_id nor org_name, the unattributed organization is used."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])

    def test_a_blank_org_name_falls_back_rather_than_creating_a_nameless_org(self) -> None:
        """A blank org_name falls back to the unattributed organization."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo", org_name="   "))
        self.assertEqual(dep.org_id, supervisor.fallback_org["id"])

    def test_command_declares_the_site_url_that_will_be_returned(self) -> None:
        """The command passes the same site URL and port that the caller receives."""
        # The origin is baked into the generated bundle, so --site-url must match
        # the URL handed to the caller or the site's own MCP URLs point elsewhere.
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        cmd: List[str] = supervisor._command(dep)  # pylint: disable=protected-access; the test inspects internals
        self.assertEqual(cmd[cmd.index("--site-url") + 1], dep.url)
        self.assertEqual(cmd[cmd.index("--port") + 1], str(dep.port))
        self.assertNotIn("--theme", cmd)

    def test_per_deployment_options_override_service_defaults(self) -> None:
        """Per-deployment options override the service defaults in the command."""
        supervisor: Supervisor = self._supervisor()
        dep: Deployment = supervisor.create(b"x", DeployOptions(
            name="demo", theme=True, theme_model="gpt-5.5", cruse=False))
        cmd: List[str] = supervisor._command(dep)  # pylint: disable=protected-access; the test inspects internals
        self.assertEqual(cmd[cmd.index("--theme-model") + 1], "gpt-5.5")
        self.assertIn("--no-cruse", cmd)

    def test_spawn_gives_the_site_no_service_secrets(self) -> None:
        """
        _spawn hands Popen an environment without the service's secrets, honouring SITE_ENV_ALLOW.
        """
        supervisor: Supervisor = self._supervisor(site_env_allow=["ANTHROPIC_API_KEY"])
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo"))
        fake_env: Dict[str, str] = {
            "NSDEPLOY_SERVICE_API_TOKEN": "fake-service-token",
            "NSDEPLOY_SERVICE_STUDIO": "/fake/studio",
            "OPENAI_API_KEY": "fake-openai-key",
            "ANTHROPIC_API_KEY": "fake-anthropic-key",
        }
        popen: mock.MagicMock
        with mock.patch.dict(os.environ, fake_env):
            with mock.patch("nsdeploy_service.supervisor.subprocess.Popen") as popen:
                supervisor._spawn(dep)  # pylint: disable=protected-access; the test inspects internals
        popen.assert_called_once()
        env: Dict[str, str] = popen.call_args.kwargs.get("env")
        self.assertIsInstance(env, dict)
        # Compared by name only, so a failure never prints the real environment's values.
        self.assertNotIn("NSDEPLOY_SERVICE_API_TOKEN", env.keys())
        self.assertNotIn("OPENAI_API_KEY", env.keys())
        self.assertEqual(env.get("ANTHROPIC_API_KEY"), "fake-anthropic-key")
        self.assertEqual(env.get("NSDEPLOY_SERVICE_STUDIO"), "/fake/studio")
        self.assertEqual(env.get("PYTHONUNBUFFERED"), "1")

    def test_command_always_passes_the_service_upstream(self) -> None:
        """The command passes the service upstream even when the options name another."""
        # The site's /byok/v1 forwards every visitor's key to this URL, so a
        # deployment's own value must never reach the command.
        supervisor: Supervisor = self._supervisor(upstream="https://router.example/v1")
        dep: Deployment = supervisor.create(b"x", DeployOptions(name="demo", upstream="https://uploader.example/v1"))
        cmd: List[str] = supervisor._command(dep)  # pylint: disable=protected-access; the test inspects internals
        self.assertEqual(cmd[cmd.index("--upstream") + 1], "https://router.example/v1")
        self.assertNotIn("https://uploader.example/v1", cmd)


if __name__ == "__main__":
    unittest.main()


class OrgNameLimitTest(unittest.TestCase):
    """The upload fields that create an organization on first use are bounded.

    An unbounded org_name let a deployment arrive with the service's own API token
    pasted into it — 48 characters, which then rendered as an organization in the
    directory, the filter dropdown and the map's hover callout, and widened the
    filter until the control bar wrapped. These assert the bound exists on *both*
    upload paths, because only one of them was ever going to be remembered.

    Rejection happens at the HTTP layer (FastAPI validates Form/Query), not in the
    supervisor, so these go through TestClient rather than supervisor.create.
    """

    def setUp(self) -> None:
        self._tmp: tempfile.TemporaryDirectory[str]
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root: Path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8890, port_end=8899)))

    def test_both_upload_paths_declare_the_limit(self) -> None:
        """Asserted from the schema, not by uploading something that fits.

        Posting an acceptable name starts a real build, which opens nsdeploy.log and
        leaves the temp directory undeletable on Windows — the test then fails in
        teardown for a reason that has nothing to do with the limit. The schema is
        what actually changed, and reading it back exercises both paths without
        spawning a process.
        """
        client: TestClient
        with self._client() as client:
            schema: Dict[str, Any] = client.get("/openapi.json").json()

        def max_length(node: Dict[str, Any]) -> Optional[int]:
            """maxLength, wherever the generator put it.

            An Optional[str] is emitted as anyOf[{string, maxLength}, {null}] rather
            than carrying maxLength at the top level, so looking only at the top finds
            nothing even when the constraint is correctly applied. Checking both shapes
            also survives a Pydantic upgrade that flattens it.
            """
            if "maxLength" in node:
                return node["maxLength"]
            branch: Dict[str, Any]
            for branch in node.get("anyOf", []):
                if "maxLength" in branch:
                    return branch["maxLength"]
            return None

        form: Dict[str, Any] = (schema["paths"]["/deployments"]["post"]["requestBody"]["content"]
                                ["multipart/form-data"]["schema"])
        ref: str = form.get("$ref", "").rsplit("/", 1)[-1]
        body: Dict[str, Any] = schema["components"]["schemas"][ref] if ref else form
        self.assertEqual(max_length(body["properties"]["org_name"]), ORG_NAME_MAX)

        raw: List[Dict[str, Any]] = schema["paths"]["/deployments/raw"]["post"]["parameters"]
        org: Dict[str, Any] = next(p for p in raw if p["name"] == "org_name")
        self.assertEqual(max_length(org["schema"]), ORG_NAME_MAX)

    def test_a_name_past_the_limit_is_rejected(self) -> None:
        """An org_name longer than the limit is rejected with 422."""
        client: TestClient
        with self._client() as client:
            response: httpx.Response = client.post(
                "/deployments",
                files={"file": ("n.hocon", b"x", "application/octet-stream")},
                data={"org_name": "a" * (ORG_NAME_MAX + 1)})
            self.assertEqual(response.status_code, 422, response.text)

    def test_the_raw_upload_path_is_bounded_too(self) -> None:
        """The raw upload path bounds org_name as well."""
        # The one that would have been forgotten: /deployments/raw takes org_name as a
        # query parameter rather than a form field, so it needed its own limit.
        client: TestClient
        with self._client() as client:
            response: httpx.Response = client.post(
                f"/deployments/raw?name=n&org_name={'a' * (ORG_NAME_MAX + 1)}",
                content=b"x")
            self.assertEqual(response.status_code, 422, response.text)

    def test_a_real_team_name_still_fits(self) -> None:
        """Real team names fit within the limit."""
        # The limit is useless if it rejects the names people actually use. These are
        # drawn from what is deployed today plus a plausibly verbose one.
        name: str
        for name in ("Icecream store", "Acme Logistics", "Team Phoenix",
                     "Cognizant Agentic Engineering Team"):
            with self.subTest(name=name):
                self.assertLessEqual(len(name), ORG_NAME_MAX)

    def test_the_api_token_shape_that_caused_this_is_refused(self) -> None:
        """A pasted API token is longer than the limit."""
        self.assertGreater(len("0123456789abcdef" * 3),
                           ORG_NAME_MAX)


class OrgNameCharacterTest(unittest.TestCase):
    """Which characters an organization name may contain.

    Tested against the pattern directly rather than over HTTP: an accepted name starts
    a real build, which holds nsdeploy.log open and breaks the temp-directory teardown
    on Windows. The pattern is the thing being specified, and both endpoints are wired
    to this same constant (asserted in OrgNameLimitTest).
    """

    def _matches(self, value: str) -> bool:
        return bool(re.match(ORG_NAME_PATTERN, value))

    def test_real_team_names_are_accepted(self) -> None:
        """Real team names, including common punctuation, are accepted."""
        # Drawn from what is actually deployed, plus the punctuation that turns up in
        # company names. A rule that rejects "Smith, Jones & Co." is not usable.
        name: str
        for name in ("Max Retail", "Icecream store", "Acme Logistics", "BOFA",
                     "cailville", "Team Phoenix", "AT&T", "O'Brien Ltd",
                     "Smith, Jones & Co.", "Cognizant (India)", "R&D / Platform",
                     "Team #4", "C++ Guild", "team_phoenix"):
            with self.subTest(name=name):
                self.assertTrue(self._matches(name), f"should accept {name!r}")

    def test_non_ascii_names_are_accepted(self) -> None:
        """Non-ASCII team names are accepted."""
        # International event: an ASCII-only rule would refuse real team names.
        name: str
        for name in ("Zürich Analytics", "北京团队",
                     "Equipe Numéro 1"):
            with self.subTest(name=name):
                self.assertTrue(self._matches(name), f"should accept {name!r}")

    def test_markup_and_shell_characters_are_refused(self) -> None:
        """Markup and shell metacharacters are refused."""
        name: str
        for name in ("<script>alert(1)</script>", 'He said "hi"', "a`b", "a|b",
                     "a;b", "a$b", "a*b", "a=b", "a\b"):
            with self.subTest(name=name):
                self.assertFalse(self._matches(name), f"should refuse {name!r}")

    def test_whitespace_and_control_characters_are_refused(self) -> None:
        """Leading or trailing whitespace and control characters are refused."""
        # A name carrying a line break breaks every place it is listed.
        name: str
        for name in ("", " ", "  Max Retail", "Max Retail  ", "a\nb", "a\tb",
                     "line1\r\nline2"):
            with self.subTest(name=repr(name)):
                self.assertFalse(self._matches(name), f"should refuse {name!r}")

    def test_names_that_are_only_punctuation_are_refused(self) -> None:
        """Names made only of punctuation are refused."""
        name: str
        for name in ("....", "!!!", "@@@", "***", "-Max", "---"):
            with self.subTest(name=name):
                self.assertFalse(self._matches(name), f"should refuse {name!r}")

    def test_a_pasted_url_is_refused(self) -> None:
        """A pasted URL is refused."""
        self.assertFalse(self._matches("https://evil.example/x"))

    def test_length_not_characters_is_what_stops_a_pasted_token(self) -> None:
        """The division of labour, stated so it is not mistaken for a gap.

        A hex token is made entirely of legal characters, so the pattern cannot refuse
        it and is not meant to. ORG_NAME_MAX is what does — and the token that caused
        all this was 48 characters.
        """
        pasted: str = "0123456789abcdef" * 3
        self.assertTrue(self._matches(pasted[:30]), "characters alone cannot catch this")
        self.assertGreater(len(pasted), ORG_NAME_MAX, "but the length limit does")


class EngineCliContractTest(unittest.TestCase):
    """Every CLI flag the supervisor passes must exist in the installed nsdeploy.

    The service invokes `python -m nsdeploy` as a child process, so nothing here is
    checked at import time — a flag that disappears from the engine is found at
    deployment time, by a participant, as a failed build.

    This exists because exactly that happened: a new engine build dropped `--host`,
    whose help text read "use 0.0.0.0 in a container". Locally that changes nothing,
    because the default is loopback and there is no container. On the VM, where
    DEPLOY_HOST=0.0.0.0, it meant every deployment would have died on an argparse
    error — and had the flag merely been ignored rather than rejected, every site
    would have bound container-loopback and returned connection refused through
    Docker's published port while the build reported success.

    Asserted against --help rather than by deploying, so it costs a subprocess and
    not a build.
    """

    # Mirrors the command assembled in supervisor.py. Kept as a literal list because
    # parsing it out of the source would fail silently the day that code is reshaped.
    #
    # `--host` is deliberately NOT here. It is the one flag this project ever added to
    # the engine, and three successive drops removed it; requiring it made this test
    # fail against every stock nsdeploy, which is the wrong signal — the engine is not
    # broken, the service just has to cope. The service now probes for it
    # (engine_supports_host) and refuses to start a deployment that would need it and
    # cannot have it. OPTIONAL records the intent so nobody re-adds it here.
    REQUIRED: Tuple[str, ...] = (
        "--port", "--out", "--site-dir", "--site-url", "--upstream",
        "--facade-upstream", "--studio", "--repo", "--ref",
        "--theme", "--theme-model", "--theme-refresh", "--theme-prompt", "--no-cruse",
    )
    OPTIONAL: Tuple[str, ...] = ("--host",)

    def test_every_flag_the_supervisor_passes_exists(self) -> None:
        """Every flag in REQUIRED appears in the installed nsdeploy's --help output."""
        result: subprocess.CompletedProcess[str] = subprocess.run(
            [sys.executable, "-m", "nsdeploy", "--help"],
            capture_output=True, text=True, timeout=120, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[:400])
        help_text: str = result.stdout + result.stderr

        missing: List[str] = [flag for flag in self.REQUIRED if flag not in help_text]
        self.assertEqual(
            missing, [],
            f"nsdeploy no longer accepts {missing}. The supervisor passes these; a "
            f"missing one fails every deployment. If the engine was just replaced, "
            f"restore the flag (see nsdeploy/launcher.py serve(host=...)).")

    def test_host_is_detected_rather_than_assumed(self) -> None:
        """Whatever the engine does about --host, the service must agree with it.

        Replaces an assertion that the flag exists. It does not, in a stock engine, and
        three drops in a row removed it — so requiring it meant a red suite that said
        "the engine is wrong" when the engine was simply upstream. What actually
        matters is that the service's belief matches reality, because the failure it
        guards is silent: a site binds container-loopback, Docker's published port
        forwards to the container's interface instead, and every URL answers connection
        refused while the build reports `ready`.
        """
        supported: bool = engine_supports_host(sys.executable)
        launcher: str = (Path(__file__).resolve().parents[2]
                         / "nsdeploy" / "launcher.py").read_text(encoding="utf-8")
        binds_given_host: bool = "(host, port), make_handler" in launcher

        self.assertEqual(
            supported, binds_given_host,
            "engine_supports_host() and launcher.serve() disagree: the flag is "
            f"{'advertised' if supported else 'absent'} but the listener "
            f"{'does' if binds_given_host else 'does not'} bind what it is given. "
            "A flag accepted and ignored is worse than one rejected.")

    def test_a_host_needing_config_fails_loudly_on_a_stock_engine(self) -> None:
        """DEPLOY_HOST=0.0.0.0 against an engine with no --host must raise, not warn.

        This is the combination that cost two silent outages. The old code passed the
        flag regardless; on an engine without it, argparse rejected the whole command
        and every build failed with an opaque error. Now it is refused up front with
        the two ways out named — `--network host`, or SUBDOMAIN_TEMPLATE.
        """
        if engine_supports_host(sys.executable):
            self.skipTest("this engine has --host; nothing to refuse")

        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            settings: Settings = Settings(work_root=Path(tmp), port_start=8600, port_end=8601,
                                          deploy_host="0.0.0.0")
            supervisor: Supervisor = Supervisor(settings)
            try:
                dep: Deployment = supervisor.create(b"x", DeployOptions(name="needs_host"))
                caught: _AssertRaisesContext[DeploymentError]
                with self.assertRaises(DeploymentError) as caught:
                    supervisor._command(dep)  # pylint: disable=protected-access; the test inspects internals
                message: str = str(caught.exception)
                self.assertIn("--host", message)
                self.assertIn("network host", message)
                self.assertIn("SUBDOMAIN_TEMPLATE", message)
            finally:
                supervisor.store.close()
