import json
import re
import unittest

from nsdeploy.generate import CRUSE_DIRECTIVE, rewrite_config
from nsdeploy.resolve import DeploymentPlan


class CruseDeploymentTests(unittest.TestCase):
    def test_protocol_injected_at_every_agent_without_mutating_source(self):
        config = {"tools": [
            {"name": "root", "instructions": "Root", "tools": ["child"]},
            {"name": "child", "instructions": "Child"},
        ]}
        plan = DeploymentPlan("test", config, "root")
        result = rewrite_config(plan, "http://localhost:8080")
        self.assertEqual(result["cruse"], {"version": 1})
        for agent in result["tools"]:
            self.assertIn("At EVERY level of the hierarchy", agent["instructions"])
            self.assertIn("supplement", agent["instructions"])
        self.assertEqual(config["tools"][0]["instructions"], "Root")
        disabled = rewrite_config(plan, "http://localhost:8080", cruse=False)
        self.assertNotIn("cruse", disabled)
        self.assertEqual(disabled["tools"][1]["instructions"], "Child")

    def test_every_prompt_example_is_valid_json_and_covers_rich_outputs(self):
        examples = [json.loads(line) for line in CRUSE_DIRECTIVE.splitlines() if line.startswith("{")]
        kinds = {example.get("kind") for example in examples}
        self.assertTrue({"form", "choice", "confirm", "info", "report", "table", "chart", "html"} <= kinds)
        block = re.search(r"```cruse-ui\n(.*?)\n```", CRUSE_DIRECTIVE, re.S)
        self.assertEqual(json.loads(block[1])["version"], 1)


if __name__ == "__main__":
    unittest.main()
