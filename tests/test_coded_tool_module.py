import shutil
import tempfile
import unittest
from pathlib import Path

from nsdeploy.coded_tool_module import CodedToolModule


class TestCodedToolModule(unittest.TestCase):
    """
    Tests that coded-tool module names resolve only to files in `coded_tools`.
    """

    def setUp(self) -> None:
        """
        Create a studio root with one coded tool.
        """
        self.root: Path = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "coded_tools").mkdir()
        (self.root / "coded_tools" / "__init__.py").write_text("", encoding="utf-8")
        (self.root / "coded_tools" / "search_tool.py").write_text("", encoding="utf-8")

    def test_find_returns_listed_module(self) -> None:
        """
        Tests that an existing coded tool resolves to its dotted name.
        """
        self.assertEqual(CodedToolModule.find(self.root, "search_tool"), "coded_tools.search_tool")
        self.assertEqual(CodedToolModule.find_dotted(self.root, "coded_tools.search_tool"),
                         "coded_tools.search_tool")

    def test_find_rejects_unknown_or_unsafe_names(self) -> None:
        """
        Tests that missing files, non-identifiers and other packages resolve to None.
        """
        name: str = None
        # Each name must fail to resolve.
        for name in ["missing", "../search_tool", "search_tool.py", "os; x", "", "__init__ x"]:
            self.assertIsNone(CodedToolModule.find(self.root, name), name)
        self.assertIsNone(CodedToolModule.find_dotted(self.root, "os.path"))
        self.assertIsNone(CodedToolModule.find_dotted(self.root, "coded_tools.search_tool.extra"))
        self.assertIsNone(CodedToolModule.find_dotted(self.root, None))

    def test_find_without_package_dir(self) -> None:
        """
        Tests that a studio root without `coded_tools` resolves to None.
        """
        self.assertIsNone(CodedToolModule.find(self.root / "coded_tools", "search_tool"))


if __name__ == "__main__":
    unittest.main()
