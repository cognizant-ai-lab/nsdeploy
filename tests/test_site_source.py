import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Dict

from nsdeploy.site_source import load_site_theme
from nsdeploy.site_source import seed_site_source
from nsdeploy.site_source import site_source_exists
from nsdeploy.theme import ThemeSpec


class SiteSourceTests(unittest.TestCase):
    """Tests for seeding and loading editable site source packages."""

    def test_seed_creates_editable_source_package(self) -> None:
        """Check seed creates editable source package."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            site_dir: Path = Path(tmp) / "sites" / "harbor"
            seed_site_source(site_dir, ThemeSpec(brand="Harbor Desk"), "Harbor Desk")

            self.assertTrue(site_source_exists(site_dir))
            self.assertIn('data-ns-layout="fixed"', (site_dir / "layout.html").read_text())
            self.assertTrue((site_dir / "theme.css").is_file())
            self.assertIn("export function customize", (site_dir / "site.js").read_text())
            metadata: Dict[str, Any] = json.loads((site_dir / "theme.json").read_text())
            self.assertEqual(metadata["brand"], "Harbor Desk")
            self.assertNotIn("body", metadata)
            self.assertNotIn("style", metadata)

    def test_normal_seed_preserves_edits_and_refresh_preserves_site_js(self) -> None:
        """Check normal seed preserves edits and refresh preserves site js."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            site_dir: Path = Path(tmp)
            original: ThemeSpec = ThemeSpec.coerce({
                "brand": "Original",
                "body": '<div id="app"><section class="first"></section></div>',
                "style": ".first { color: red; }",
            })
            seed_site_source(site_dir, original, "Original")
            (site_dir / "layout.html").write_text('<div id="app"><main class="edited"></main></div>')
            (site_dir / "theme.css").write_text(".edited { color: green; }")
            (site_dir / "site.js").write_text("export const keep = true;")

            replacement: ThemeSpec = ThemeSpec.coerce({
                "brand": "Replacement",
                "body": '<div id="app"><section class="fresh"></section></div>',
                "style": ".fresh { color: blue; }",
            })
            seed_site_source(site_dir, replacement, "Replacement")
            self.assertIn("edited", (site_dir / "layout.html").read_text())
            self.assertIn("green", (site_dir / "theme.css").read_text())

            seed_site_source(site_dir, replacement, "Replacement", overwrite_theme=True)
            self.assertIn("fresh", (site_dir / "layout.html").read_text())
            self.assertIn("blue", (site_dir / "theme.css").read_text())
            self.assertEqual((site_dir / "site.js").read_text(), "export const keep = true;")

    def test_load_combines_metadata_layout_and_css(self) -> None:
        """Check load combines metadata layout and css."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            site_dir: Path = Path(tmp)
            (site_dir / "theme.json").write_text(json.dumps({"brand": "Edited Harbor"}))
            (site_dir / "layout.html").write_text('<div id="app"><main class="harbor"></main></div>')
            (site_dir / "theme.css").write_text('.harbor{background:url("assets/harbor.jpg")}')

            theme: ThemeSpec = load_site_theme(site_dir)
            self.assertEqual(theme.brand, "Edited Harbor")
            self.assertIn('class="harbor"', theme.body)
            self.assertIn("assets/harbor.jpg", theme.style)


if __name__ == "__main__":
    unittest.main()
