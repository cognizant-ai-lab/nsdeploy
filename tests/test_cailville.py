import json
import os
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List

from nsdeploy.cailville import CommunityDraft
from nsdeploy.cailville import DATA_END
from nsdeploy.cailville import DATA_START
from nsdeploy.cailville import allocate_port
from nsdeploy.cailville import cailville_ports
from nsdeploy.cailville import commit_addition
from nsdeploy.cailville import latest_download_hocon
from nsdeploy.cailville import plan_addition
from nsdeploy.cailville import prepare_runtime_sources


class CailvilleCommunityTests(unittest.TestCase):
    """Tests for the Cailville community runtime sources."""

    def setUp(self) -> None:
        self.temp: tempfile.TemporaryDirectory[str] = (
            tempfile.TemporaryDirectory())  # pylint: disable=consider-using-with; closed in tearDown
        self.root: Path = Path(self.temp.name)
        self.cailville: Path = self.root / "cailville"
        self.cailville.mkdir()
        self.base: Dict[str, Any] = {
            "version": 1,
            "sites": [
                self._site("main_street_exchange", 8097, "broker", 25, 25),
                self._site("neighbor_exchange", 8098, "broker", 70, 30),
                self._site("harbor_town_hall", 8103, "civic", 50, 60),
            ],
            "relationships": [],
        }
        (self.cailville / "community.base.json").write_text(json.dumps(self.base))
        expanded: Dict[str, Any] = json.loads(json.dumps(self.base))
        expanded["sites"].append({
            **self._site("old_demo", 8088, "business", 80, 70),
            "base": False,
        })
        (self.cailville / "community.json").write_text(json.dumps(expanded))
        (self.cailville / "cailville.html").write_text(
            f"<html>{DATA_START}<script></script>{DATA_END}</html>"
        )
        site: Dict[str, Any]
        for site in self.base["sites"]:
            site["studio"] = str(self.root)
            self._write_hocon(site["id"])
        (self.cailville / "community.base.json").write_text(json.dumps(self.base))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _site(self, name: str, port: int, site_type: str, x: int, y: int) -> Dict[str, Any]:
        return {
            "id": name,
            "name": name.replace("_", " ").title(),
            "description": name.replace("_", " "),
            "kind": "Community service",
            "type": site_type,
            "icon": "landmark" if site_type == "civic" else "store",
            "port": port,
            "hocon": f"{name}.hocon",
            "site_dir": f"sites/{name}",
            "base": True,
            "position": {"x": x, "y": y, "mx": 25, "my_px": 100},
        }

    def _write_hocon(self, name: str) -> None:
        config: Dict[str, Any] = {"tools": [{
            "name": f"{name}_front",
            "function": {"description": f"Front desk for {name}"},
            "instructions": f"Help users with {name}.",
            "tools": [],
        }]}
        (self.cailville / f"{name}.hocon").write_text(json.dumps(config))

    def test_latest_download_hocon_uses_mtime(self) -> None:
        """Check latest download hocon uses mtime."""
        downloads: Path = self.root / "Downloads"
        downloads.mkdir()
        old: Path = downloads / "old.hocon"
        new: Path = downloads / "new.hocon"
        old.write_text("{}")
        new.write_text("{}")
        os.utime(old, (10, 10))
        os.utime(new, (20, 20))
        self.assertEqual(latest_download_hocon(downloads), new.resolve())

    def test_allocate_port_skips_base_and_prior_additions(self) -> None:
        """Check allocate port skips base and prior additions."""
        community: Dict[str, Any] = json.loads((self.cailville / "community.json").read_text())
        self.assertEqual(allocate_port(community), 8089)
        with self.assertRaises(ValueError):
            allocate_port(community, 8097)

    def test_cleanup_ports_include_prior_generated_bundles(self) -> None:
        """Check cleanup ports include prior generated bundles."""
        bundle: Path = self.root / ".nsdeploy" / "cailville" / "prior_demo"
        bundle.mkdir(parents=True)
        (bundle / "agent-manifest.json").write_text(json.dumps({
            "agent_mcp": {"endpoint": "http://127.0.0.1:8127/mcp"},
        }))

        ports: List[int] = cailville_ports(self.cailville, self.root)

        self.assertIn(8127, ports)
        self.assertIn(8097, ports)

    def test_base_map_addition_updates_map_links_and_reverse_runtime_sources(self) -> None:
        """Check base map addition updates map links and reverse runtime sources."""
        bank: Path = self.root / "community_bank.hocon"
        bank.write_text(json.dumps({"tools": [{
            "name": "bank_front",
            "function": {"description": "Community bank accounts, loans, and local financial services."},
            "instructions": "Help residents and businesses with community banking.",
            "tools": [],
        }]}))
        draft: CommunityDraft = plan_addition(
            json.loads(bank.read_text()), bank, port=None,
            site_dir=self.root / "sites" / "community_bank",
            cailville_dir=self.cailville, base_map=True,
            use_model=False, studio=str(self.root),
        )
        self.assertNotIn("old_demo", {site["id"] for site in draft.community["sites"]})
        self.assertEqual(draft.site["port"], 8088)
        self.assertIn("main_street_exchange", draft.connect_to)
        front: Dict[str, Any] = draft.augmented_config["tools"][0]
        self.assertIn("main_street_exchange", front["tools"])
        self.assertEqual(
            draft.augmented_config["links"]["main_street_exchange"],
            "http://127.0.0.1:8097/main_street_exchange",
        )

        commit_addition(draft)
        html: str = (self.cailville / "cailville.html").read_text()
        self.assertIn('"id": "community_bank"', html)
        self.assertIn('id="cailville-community-data"', html)
        runtime: Dict[str, Path] = prepare_runtime_sources(self.cailville, self.root)
        self.assertIn("community_bank", runtime)
        source: str
        for source in draft.connect_from:
            config: Dict[str, Any] = json.loads(runtime[source].read_text())
            front = config["tools"][0]
            self.assertIn("community_bank", front["tools"])
            self.assertEqual(
                config["links"]["community_bank"],
                "http://127.0.0.1:8088/community_bank",
            )

    def test_cumulative_additions_receive_distinct_ports_and_map_positions(self) -> None:
        """Check cumulative additions receive distinct ports and map positions."""
        first: Path = self.root / "bakery.hocon"
        second: Path = self.root / "clinic.hocon"
        path: Path
        description: str
        for path, description in (
            (first, "Neighborhood bakery, food orders, and event catering."),
            (second, "Community clinic appointments and health services."),
        ):
            path.write_text(json.dumps({"tools": [{
                "name": f"{path.stem}_front",
                "function": {"description": description},
                "instructions": description,
                "tools": [],
            }]}))

        first_draft: CommunityDraft = plan_addition(
            json.loads(first.read_text()), first, port=None,
            site_dir=self.root / "sites" / first.stem,
            cailville_dir=self.cailville, use_model=False, studio=str(self.root),
        )
        commit_addition(first_draft)
        second_draft: CommunityDraft = plan_addition(
            json.loads(second.read_text()), second, port=None,
            site_dir=self.root / "sites" / second.stem,
            cailville_dir=self.cailville, use_model=False, studio=str(self.root),
        )

        self.assertEqual(first_draft.site["port"], 8089)
        self.assertEqual(second_draft.site["port"], 8090)
        self.assertNotEqual(first_draft.site["position"], second_draft.site["position"])
        self.assertIn("bakery", {site["id"] for site in second_draft.community["sites"]})


if __name__ == "__main__":
    unittest.main()
