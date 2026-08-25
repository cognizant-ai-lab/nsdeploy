import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REBUILD = ROOT / "cailville" / "rebuild_all.sh"
LAUNCH_ALL = ROOT / "cailville" / "launch_all.sh"


class CailvilleRebuildScriptTests(unittest.TestCase):
    def test_script_is_valid_bash_and_documents_the_destructive_refresh(self):
        subprocess.run(["bash", "-n", str(REBUILD)], check=True)
        result = subprocess.run(
            ["bash", str(REBUILD), "--help"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("thirteen public browser sites", result.stdout)
        self.assertIn("deliberately regenerated", result.stdout)

    def test_generation_precedes_forced_public_theme_launch(self):
        source = REBUILD.read_text(encoding="utf-8")
        generate = source.index('"$PROJECT_DIR/scripts/generate-runtime-and-launch.sh"')
        refresh = source.index("export NSDEPLOY_THEME_REFRESH=1")
        launch = source.index('exec "$CAILVILLE_DIR/launch_all.sh"')
        self.assertLess(generate, refresh)
        self.assertLess(refresh, launch)
        self.assertIn("export NSDEPLOY_THEME=1", source)
        self.assertIn("export NSDEPLOY_THEME_REFRESH_REQUIRED=1", source)
        self.assertIn("export NSDEPLOY_PRIVATE_STUDIO=0", source)
        self.assertIn('export NSDEPLOY_NEURO_SAN_WEB_DIR="$NEURO_SAN_WEB_DIR"', source)

    def test_public_only_launch_does_not_reserve_private_studio_ports(self):
        source = LAUNCH_ALL.read_text(encoding="utf-8")
        guard = 'if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ && -d "$PRIVATE_STUDIO_DIR" ]]'
        self.assertIn(guard, source)
        self.assertLess(source.index(guard), source.index("Private Neuro-SAN studio port %s is already in use."))

    def test_required_refresh_is_verified_for_every_ready_site(self):
        source = LAUNCH_ALL.read_text(encoding="utf-8")
        self.assertIn('THEME_REFRESH_REQUIRED="${NSDEPLOY_THEME_REFRESH_REQUIRED:-0}"', source)
        self.assertIn('grep -q "theme: proposed via" "$LOG_DIR/$site.log"', source)


if __name__ == "__main__":
    unittest.main()
