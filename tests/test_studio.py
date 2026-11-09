import shutil
import tempfile
import unittest
from pathlib import Path

from nsdeploy.coded_tool_module import CodedToolModule
from nsdeploy.studio import LocalStudio


class TestLocalStudio(unittest.TestCase):
    """
    Tests that a local checkout is mirrored at the logical paths a build asks for.
    """

    def setUp(self) -> None:
        """
        Create a checkout laid out like neuro-san-studio, and an empty mirror directory.
        """
        self.checkout: Path = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.checkout)
        self.cache: Path = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.cache)
        self.write("neuro_san_studio/toolbox/toolbox_info.hocon", "{}")
        self.write("neuro_san_studio/coded_tools/web_fetch.py", "VALUE = 1\n")
        self.write("registries/aaosa.hocon", "{}")
        self.write("venv/lib/coded_tools/only_in_venv.py", "")
        self.write("escape.txt", "")
        self.studio: LocalStudio = LocalStudio(self.checkout, cache_dir=self.cache)

    def write(self, rel_path: str, text: str) -> None:
        """
        Write a file into the checkout.

        :param rel_path: The file path relative to the checkout
        :param text: The file contents
        """
        path: Path = self.checkout / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_ensure_keeps_exact_paths(self) -> None:
        """
        Tests that a file at its logical path is mirrored at the same path.
        """
        self.assertEqual(self.studio.ensure("registries/aaosa.hocon"), self.cache / "registries" / "aaosa.hocon")

    def test_ensure_finds_file_by_suffix(self) -> None:
        """
        Tests that a file under a package directory is mirrored at its logical path.
        """
        path: Path = self.studio.ensure("toolbox/toolbox_info.hocon")
        self.assertEqual(path, self.cache / "toolbox" / "toolbox_info.hocon")
        self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_ensure_coded_tool_makes_nested_module_importable(self) -> None:
        """
        Tests that a coded tool under a package directory is found under `coded_tools`.
        """
        self.assertTrue(self.studio.ensure_coded_tool("web_fetch.py"))
        self.assertEqual(CodedToolModule.find(self.studio.root, "web_fetch"), "coded_tools.web_fetch")

    def test_ensure_copies_current_contents(self) -> None:
        """
        Tests that an edit to the checkout reaches the mirror on the next request.
        """
        self.studio.ensure_coded_tool("web_fetch.py")
        self.write("neuro_san_studio/coded_tools/web_fetch.py", "VALUE = 2\n")
        self.studio.ensure_coded_tool("web_fetch.py")
        self.assertEqual((self.cache / "coded_tools" / "web_fetch.py").read_text(encoding="utf-8"), "VALUE = 2\n")

    def test_ensure_skips_virtualenv(self) -> None:
        """
        Tests that files in a virtualenv of the checkout are not studio sources.
        """
        self.assertFalse(self.studio.ensure_coded_tool("only_in_venv.py"))

    def test_ensure_rejects_path_outside_root(self) -> None:
        """
        Tests that a logical path cannot write outside the mirror directory.
        """
        self.assertIsNone(self.studio.ensure("../escape.txt"))

    def test_ensure_returns_none_for_unknown_file(self) -> None:
        """
        Tests that a file the checkout does not have is reported as unavailable.
        """
        self.assertIsNone(self.studio.ensure("toolbox/missing.hocon"))
