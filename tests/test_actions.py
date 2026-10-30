import json
from pathlib import Path
import tempfile
import unittest

from nsdeploy.generate import generate_site
from nsdeploy.resolve import DeploymentPlan


class ActionBundleTests(unittest.TestCase):
    def test_adapter_and_bridge_are_published_without_hocon_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            adapter = source / "actions.js"
            adapter.write_text("export function registerActions(actions) {}\n")
            original = {"tools": [{"name": "front", "instructions": "Help.", "tools": []}]}
            plan = DeploymentPlan(network_name="example", config=original, front_man="front")
            for static in (False, True):
                out = root / str(static)
                manifest = generate_site(plan, out, "browser://mock", "https://model.test/v1", "", site_source_dir=source, static_bundle=static)
                self.assertEqual(manifest["actions"]["module"], "./actions.js")
                self.assertEqual((out / "actions.js").read_text(), adapter.read_text())
                self.assertIn("./runtime/action-bridge.js", (out / "action-bridge.html").read_text())
                config = json.loads((out / "example.network.json").read_text())
                self.assertEqual(config["tools"][0]["tools"], [])
                self.assertEqual(plan.config, original)
                # No adapter on regeneration means no discovery or execution,
                # even if stale static files remain on the host.
                manifest = generate_site(plan, out, "browser://mock", "https://model.test/v1", "", static_bundle=static)
                self.assertNotIn("actions", manifest)

    def test_explicit_adapter_overrides_site_convention(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = root / "custom.js"
            adapter.write_text("export function registerActions() {}")
            plan = DeploymentPlan(network_name="example", config={"tools": [{"name": "front", "instructions": "Help."}]}, front_man="front")
            manifest = generate_site(plan, root / "out", "browser://mock", "", "", actions_file=adapter)
            self.assertEqual(manifest["actions"]["version"], 1)
            self.assertEqual((root / "out/actions.js").read_text(), adapter.read_text())
