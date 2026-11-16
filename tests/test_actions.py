import json
import contextlib
import io
from pathlib import Path
import tempfile
from typing import Any
from typing import Dict
from typing import List
import unittest

from nsdeploy.generate import generate_site
from nsdeploy.resolve import DeploymentPlan
from nsdeploy.form_actions import action_discovery_config


class ActionBundleTests(unittest.TestCase):
    """Tests for generated site action bundles and discovery configuration."""

    def test_discovery_has_no_guessed_route_and_host_forms_are_explicit(self) -> None:
        """Check discovery has no guessed route and host forms are explicit."""
        self.assertEqual(action_discovery_config(), {})
        config: Dict[str, Any] = action_discovery_config(host_page=True)
        self.assertTrue(config["hostPage"])
        self.assertEqual(config["pages"], [])
        with self.assertRaises(ValueError):
            action_discovery_config(host_page=True, callers=["https://caller.test"])

    def test_subpath_headers_only_expose_public_agent_data(self) -> None:
        """Check subpath headers only expose public agent data."""
        directory: str
        with tempfile.TemporaryDirectory() as directory:
            out: Path = Path(directory)
            config: Dict[str, Any] = {"tools": [{"name": "front", "instructions": "Help."}]}
            plan: DeploymentPlan = DeploymentPlan(network_name="example", config=config, front_man="front")
            log: io.StringIO = io.StringIO()
            with contextlib.redirect_stdout(log):
                manifest: Dict[str, Any] = generate_site(plan, out, "browser://mock", "",
                                                         "https://app.test/agents/example", static_bundle=True)
            self.assertNotIn("actions", manifest)
            self.assertIn("NONE configured", log.getvalue())
            headers: str = (out / "_headers").read_text()
            self.assertIn("/agents/example/example.network.json\n  Access-Control-Allow-Origin: *", headers)
            self.assertIn("/agents/example/runtime/sandbox-worker.js\n  Content-Security-Policy:", headers)
            self.assertNotIn("/*", headers)
            self.assertNotIn("actions.js", headers)
            self.assertNotIn("action-bridge.html", headers)
            self.assertIn("<FilesMatch", (out / ".htaccess").read_text())
            with contextlib.redirect_stdout(log):
                generate_site(plan, out, "browser://mock", "", "https://app.test/agents/example", static_bundle=True,
                              action_pages=["/agents/example/"])
            self.assertIn("targets the generated agent page, which has no native forms", log.getvalue())

    def test_native_forms_need_no_adapter_and_remain_static(self) -> None:
        """Check native forms need no adapter and remain static."""
        directory: str
        with tempfile.TemporaryDirectory() as directory:
            config: Dict[str, Any] = {"tools": [{"name": "front", "instructions": "Help."}]}
            plan: DeploymentPlan = DeploymentPlan(network_name="example", config=config, front_man="front")
            out: Path = Path(directory)
            manifest: Dict[str, Any] = generate_site(plan, out, "browser://mock", "", "", static_bundle=True,
                                                     action_pages=["/booking"], action_modules=["/js/cart.js"],
                                                     action_caller_origins=["https://caller.example"])
            self.assertEqual(manifest["actions"]["pages"], ["/booking"])
            self.assertNotIn("module", manifest["actions"])
            self.assertFalse((out / "actions.js").exists())
            self.assertTrue((out / "action-bridge.html").exists())
            self.assertTrue((out / "runtime/form-actions.js").exists())

    def test_discovery_configuration_rejects_foreign_pages_and_inexact_callers(self) -> None:
        """Check discovery configuration rejects foreign pages and inexact callers."""
        paths: List[str] = ["https://elsewhere.test/form", "//elsewhere.test/form", "/\\elsewhere.test/form", "form",
                            "/form#x"]
        path: str
        for path in paths:
            with self.assertRaises(ValueError):
                action_discovery_config([path])
        caller: str
        for caller in ["*", "https://caller.test/path", "https://caller.test/", "https://user:password@caller.test"]:
            with self.assertRaises(ValueError):
                action_discovery_config(["/form"], callers=[caller])

    def test_adapter_and_bridge_are_published_without_hocon_changes(self) -> None:
        """Check adapter and bridge are published without hocon changes."""
        directory: str
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            source: Path = root / "source"
            source.mkdir()
            adapter: Path = source / "actions.js"
            adapter.write_text("export function registerActions(actions) {}\n")
            original: Dict[str, Any] = {"tools": [{"name": "front", "instructions": "Help.", "tools": []}]}
            plan: DeploymentPlan = DeploymentPlan(network_name="example", config=original, front_man="front")
            static: bool
            for static in (False, True):
                out: Path = root / str(static)
                manifest: Dict[str, Any] = generate_site(plan, out, "browser://mock", "https://model.test/v1", "",
                                                         site_source_dir=source, static_bundle=static)
                self.assertEqual(manifest["actions"]["module"], "./actions.js")
                self.assertEqual((out / "actions.js").read_text(), adapter.read_text())
                self.assertIn("./runtime/action-bridge.js", (out / "action-bridge.html").read_text())
                config: Dict[str, Any] = json.loads((out / "example.network.json").read_text())
                self.assertEqual(config["tools"][0]["tools"], [])
                self.assertEqual(plan.config, original)
                # No adapter on regeneration means no discovery or execution,
                # even if stale static files remain on the host.
                manifest = generate_site(plan, out, "browser://mock", "https://model.test/v1", "", static_bundle=static)
                self.assertNotIn("actions", manifest)

    def test_explicit_adapter_overrides_site_convention(self) -> None:
        """Check explicit adapter overrides site convention."""
        directory: str
        with tempfile.TemporaryDirectory() as directory:
            root: Path = Path(directory)
            adapter: Path = root / "custom.js"
            adapter.write_text("export function registerActions() {}")
            config: Dict[str, Any] = {"tools": [{"name": "front", "instructions": "Help."}]}
            plan: DeploymentPlan = DeploymentPlan(network_name="example", config=config, front_man="front")
            manifest: Dict[str, Any] = generate_site(plan, root / "out", "browser://mock", "", "", actions_file=adapter)
            self.assertEqual(manifest["actions"]["version"], 1)
            self.assertEqual((root / "out/actions.js").read_text(), adapter.read_text())
