import json
import re
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Set
import unittest

from nsdeploy.generate import CRUSE_DIRECTIVE
from nsdeploy.generate import rewrite_config
from nsdeploy.resolve import DeploymentPlan


class CruseDeploymentTests(unittest.TestCase):
    """Tests for CRUSE protocol injection into deployed networks."""

    def test_protocol_injected_at_every_agent_without_mutating_source(self) -> None:
        """Check protocol injected at every agent without mutating source."""
        config: Dict[str, Any] = {"tools": [
            {"name": "root", "instructions": "Root", "tools": ["child"]},
            {"name": "child", "instructions": "Child"},
        ]}
        plan: DeploymentPlan = DeploymentPlan("test", config, "root")
        result: Dict[str, Any] = rewrite_config(plan, "http://localhost:8080")
        self.assertEqual(result["cruse"], {"version": 1})
        agent: Dict[str, Any]
        for agent in result["tools"]:
            self.assertIn("At EVERY level of the hierarchy", agent["instructions"])
            self.assertIn("supplement", agent["instructions"])
        self.assertEqual(config["tools"][0]["instructions"], "Root")
        disabled: Dict[str, Any] = rewrite_config(plan, "http://localhost:8080", cruse=False)
        self.assertNotIn("cruse", disabled)
        self.assertEqual(disabled["tools"][1]["instructions"], "Child")

    def test_every_prompt_example_is_valid_json_and_covers_rich_outputs(self) -> None:
        """Check every prompt example is valid json and covers rich outputs."""
        examples: List[Dict[str, Any]] = [json.loads(line) for line in CRUSE_DIRECTIVE.splitlines()
                                          if line.startswith("{")]
        kinds: Set[Optional[str]] = {example.get("kind") for example in examples}
        self.assertTrue({"form", "choice", "confirm", "info", "report", "table", "chart", "html"} <= kinds)
        block: Optional[re.Match[str]] = re.search(r"```cruse-ui\n(.*?)\n```", CRUSE_DIRECTIVE, re.S)
        self.assertEqual(json.loads(block[1])["version"], 1)


if __name__ == "__main__":
    unittest.main()
