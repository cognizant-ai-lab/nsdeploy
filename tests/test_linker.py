import json
import tempfile
import unittest
from pathlib import Path

from nsdeploy.generate import rewrite_config
from nsdeploy.linker import NetworkDescription, describe_config, load_link_file, write_link_file
from nsdeploy.resolve import build_plan
from nsdeploy.studio import LocalStudio


class LinkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = LocalStudio(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_dangling_reference_becomes_link_slot(self):
        config = {
            "tools": [{
                "name": "travel_concierge",
                "instructions": "Arrange a trip.",
                "tools": ["airline_reservations"],
            }]
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        self.assertEqual(plan.missing_tools, [])
        self.assertEqual(plan.link_slots, {"airline_reservations": ["travel_concierge"]})

        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)
        self.assertEqual(deployed["tools"][0]["tools"], ["airline_reservations"])
        self.assertIn("airline_reservations", deployed["link_slots"])

    def test_configured_link_rewrites_reference_to_remote_network(self):
        config = {
            "links": {"airline_reservations": "http://127.0.0.1:8092/link_demo_airline"},
            "tools": [{
                "name": "travel_concierge",
                "instructions": "Arrange a trip.",
                "tools": ["airline_reservations"],
            }],
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)
        self.assertEqual(
            deployed["tools"][0]["tools"],
            ["http://127.0.0.1:8092/link_demo_airline"],
        )
        self.assertEqual(deployed["link_slots"], {})

    def test_sidecar_round_trip(self):
        path = self.root / "travel.links.json"
        expected = {"airline_reservations": "http://127.0.0.1:8092/link_demo_airline"}
        write_link_file(path, "travel", expected)
        self.assertEqual(load_link_file(path, "travel"), expected)
        self.assertEqual(json.loads(path.read_text())["version"], 1)

    def test_exports_include_configured_alias(self):
        config = {
            "metadata": {"link_aliases": ["airline_reservations"]},
            "tools": [{"name": "airline_front", "instructions": "Book flights."}],
        }
        desc = describe_config(config, "link_demo_airline")
        self.assertIsInstance(desc, NetworkDescription)
        self.assertEqual(
            desc.aliases,
            ["link_demo_airline", "airline_front", "airline_reservations"],
        )


if __name__ == "__main__":
    unittest.main()
