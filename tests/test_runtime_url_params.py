import re
import unittest
from pathlib import Path


class TestRuntimeUrlParams(unittest.TestCase):
    """
    Guards the browser runtime against taking inference settings from the page URL.

    A link must not choose the key, the router that receives it, or the model billed to it. Apply keeps them for the
    tab in session storage instead, and only the key is removed from the page URL. These checks read the runtime
    source as text, because the repo has no JavaScript test harness for the boot code.
    """

    RUNTIME_DIR: Path = Path(__file__).resolve().parents[1] / "nsdeploy" / "runtime"
    SETTINGS: tuple[str, ...] = ("key", "router", "model")

    def find_calls(self, file_name: str, pattern: str) -> list[str]:
        """
        Find every match of a pattern in one runtime source file.

        :param file_name: File name inside nsdeploy/runtime.
        :param pattern: Regular expression to find, with no capturing groups.
        :return: The matched text, in source order.
        """
        source: str = (self.RUNTIME_DIR / file_name).read_text(encoding="utf-8")
        return re.findall(pattern, source)

    def test_boot_does_not_read_settings_from_url(self) -> None:
        """
        Check that boot never reads key, router or model from the URL query.
        """
        name: str
        # Each setting must not be read by name with get() or getAll().
        for name in self.SETTINGS:
            pattern: str = rf"\.get(?:All)?\(\s*['\"`]{name}['\"`]"
            with self.subTest(name=name):
                self.assertEqual(self.find_calls("index.js", pattern), [])

    def test_boot_does_not_store_key(self) -> None:
        """
        Check that boot never writes the BYOK key or the tab setup into session storage.
        """
        pattern: str
        # Neither a direct key write nor the tab setup writer may appear in boot.
        for pattern in (r"sessionStorage\.setItem\(\s*['\"`]nsweb-byok-key['\"`]", r"saveTabByokSetup\("):
            with self.subTest(pattern=pattern):
                self.assertEqual(self.find_calls("index.js", pattern), [])

    def test_settings_panel_keeps_settings_out_of_url(self) -> None:
        """
        Check that the settings panel never reads or writes key, router or model in the URL query.
        """
        name: str
        # Each setting must not be read, set or appended by name.
        for name in self.SETTINGS:
            pattern: str = rf"\.(?:get|getAll|set|append)\(\s*['\"`]{name}['\"`]"
            with self.subTest(name=name):
                self.assertEqual(self.find_calls("ui.js", pattern), [])

    def test_apply_keeps_setup_in_tab_session(self) -> None:
        """
        Check that Apply saves key, router and model for this tab and that boot reads them back.
        """
        expected: tuple[tuple[str, str], ...] = (
            ("ui.js", r"saveTabByokSetup\("),
            ("index.js", r"loadTabByokSetup\("),
            ("byok.js", r"['\"`]nsweb-byok-router['\"`]"),
            ("byok.js", r"['\"`]nsweb-byok-model['\"`]"),
        )
        file_name: str
        pattern: str
        # Each part of the tab setup must still be in place.
        for file_name, pattern in expected:
            with self.subTest(file_name=file_name, pattern=pattern):
                self.assertNotEqual(self.find_calls(file_name, pattern), [])

    def test_page_url_keeps_router_and_model(self) -> None:
        """
        Check that boot and Apply remove only the key from the page URL, so a host page keeps its own parameters.
        """
        with self.subTest(file_name="index.js"):
            self.assertEqual(self.find_calls("index.js", r"\.delete\([^)]*\)"), ['.delete("key")'])
        with self.subTest(file_name="ui.js"):
            self.assertEqual(self.find_calls("ui.js", r"\.delete\(\s*['\"`](?:router|model)['\"`]"), [])
