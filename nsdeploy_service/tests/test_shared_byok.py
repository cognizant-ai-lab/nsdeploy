import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.shared_byok import END_MARKER
from nsdeploy_service.shared_byok import START_MARKER
from nsdeploy_service.shared_byok import shared_byok_script
from nsdeploy_service.shared_byok import sync_shared_byok


class SharedByokTests(unittest.TestCase):
    """Generates and syncs the shared BYOK script block."""
    def test_script_is_48_hours_secure_and_adds_no_ui_content(self):
        """The script uses a 48-hour secure cookie and adds no UI content."""
        script = shared_byok_script()
        self.assertIn("48 * 60 * 60", script)
        self.assertIn("SameSite=Strict; Secure", script)
        self.assertIn("__Secure-nsdeploy_shared_byok_v1", script)
        self.assertIn('sessionStorage.setItem("nsweb-byok-key", sharedKey)', script)
        self.assertIn('applyButton?.addEventListener("click"', script)
        self.assertNotIn("createElement", script)
        self.assertNotIn("textContent", script)
        self.assertNotIn("innerHTML", script)

    def test_sync_preserves_authored_javascript_and_is_idempotent(self):
        """Sync preserves authored JavaScript and is idempotent."""
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            source = work / "site-source" / "site.js"
            built = work / "site" / "site.js"
            source.parent.mkdir(parents=True)
            built.parent.mkdir(parents=True)
            authored = "export function customize() { window.authored = true; }\n"
            source.write_text(authored, encoding="utf-8")
            built.write_text(authored, encoding="utf-8")

            self.assertEqual(set(sync_shared_byok(work)), {source, built})
            once = source.read_text(encoding="utf-8")
            self.assertIn(authored.strip(), once)
            self.assertEqual(once.count(START_MARKER), 1)
            self.assertEqual(once.count(END_MARKER), 1)
            self.assertEqual(sync_shared_byok(work), [])
            self.assertEqual(source.read_text(encoding="utf-8"), once)

    def test_disable_is_the_rollback_and_removes_only_the_marked_block(self):
        """Disabling removes only the marked block, restoring the authored file."""
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            path = work / "site" / "site.js"
            path.parent.mkdir(parents=True)
            authored = "export const customerCode = true;\n"
            path.write_text(authored, encoding="utf-8")
            sync_shared_byok(work)

            sync_shared_byok(work, enabled=False)

            self.assertEqual(path.read_text(encoding="utf-8"), authored)


if __name__ == "__main__":
    unittest.main()
