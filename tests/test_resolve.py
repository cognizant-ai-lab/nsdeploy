import tempfile
import unittest
from pathlib import Path

from nsdeploy.generate import _seed_default_model
from nsdeploy.resolve import _parse_hocon_content
from nsdeploy.studio import LocalStudio


class NestedIncludeTests(unittest.TestCase):
    """pyhocon resolves an include nested inside an included file against that file's
    directory (config/llm_config.hocon -> config/developer_llm_config.hocon), so the
    prefetcher must materialize nested includes there, not at the source root."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; closed via addCleanup
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "config").mkdir()
        (self.root / "config" / "llm_config.hocon").write_text(
            'include "developer_llm_config.hocon"\n', encoding="utf-8")
        (self.root / "config" / "developer_llm_config.hocon").write_text(
            '{ "llm_config": { "fallbacks": [ { "model_name": "gpt-test" } ] } }\n', encoding="utf-8")
        self.source = LocalStudio(self.root)

    def test_nested_include_resolves_relative_to_including_file(self):
        """Check nested include resolves relative to including file."""
        text = '{\n  include "config/llm_config.hocon"\n  "tools": []\n}\n'
        config, missing = _parse_hocon_content(text, self.source)
        self.assertEqual(missing, [])
        self.assertEqual(config["llm_config"]["fallbacks"][0]["model_name"], "gpt-test")

    def test_truly_missing_nested_include_is_reported_once(self):
        """Check truly missing nested include is reported once."""
        (self.root / "config" / "llm_config.hocon").write_text(
            'include "developer_llm_config.hocon"\ninclude "nowhere.hocon"\n', encoding="utf-8")
        text = '{\n  include "config/llm_config.hocon"\n  "tools": []\n}\n'
        config, missing = _parse_hocon_content(text, self.source)
        self.assertEqual(config["llm_config"]["fallbacks"][0]["model_name"], "gpt-test")
        ours = [m for m in missing if m.startswith("Cannot include file nowhere.hocon")]
        self.assertEqual(len(ours), 1, missing)


class SeedDefaultModelTests(unittest.TestCase):
    """Tests for seeding the default model name from LLM fallbacks."""

    def test_seeds_model_name_from_first_fallback_with_a_model(self):
        """Check seeds model name from first fallback with a model."""
        config = {"llm_config": {"fallbacks": [{"class": "openai"}, {"model_name": "gpt-a"}, {"model_name": "gpt-b"}]}}
        _seed_default_model(config)
        self.assertEqual(config["llm_config"]["model_name"], "gpt-a")

    def test_keeps_explicit_model_name(self):
        """Check keeps explicit model name."""
        config = {"llm_config": {"model_name": "keep-me", "fallbacks": [{"model_name": "gpt-a"}]}}
        _seed_default_model(config)
        self.assertEqual(config["llm_config"]["model_name"], "keep-me")

    def test_noop_without_llm_config_or_fallbacks(self):
        """Check noop without llm config or fallbacks."""
        for config in ({}, {"llm_config": None}, {"llm_config": {}}, {"llm_config": {"fallbacks": []}}):
            _seed_default_model(config)
            self.assertNotIn("model_name", config.get("llm_config") or {})


if __name__ == "__main__":
    unittest.main()
