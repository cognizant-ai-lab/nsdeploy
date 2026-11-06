import json
import shutil
import tempfile
import unittest
from pathlib import Path

from nsdeploy.site_manifest import SiteManifest


class TestSiteManifest(unittest.TestCase):
    """
    Tests reading network values from a site's agent-manifest.json.
    """

    def setUp(self) -> None:
        """
        Create a site directory with a manifest that lists two networks.
        """
        self.site: Path = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.site)
        networks = [{"name": "other", "front_man": "wrong"}, {"name": "net", "front_man": "front"}]
        (self.site / "agent-manifest.json").write_text(json.dumps({"networks": networks}), encoding="utf-8")

    def test_front_man_comes_from_matching_network(self) -> None:
        """
        Tests that the front-man of the network named by the config file is returned.
        """
        self.assertEqual(SiteManifest.front_man(self.site / "net.network.json"), "front")

    def test_unknown_network_raises(self) -> None:
        """
        Tests that a network missing from the manifest raises ValueError.
        """
        with self.assertRaises(ValueError):
            SiteManifest.front_man(self.site / "missing.network.json")


if __name__ == "__main__":
    unittest.main()
