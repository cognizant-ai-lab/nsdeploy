import shutil
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from typing import List
from typing import Optional
from unittest import mock

from nsdeploy.coded_tool_module import CodedToolModule
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.toolboxworkspacefactory import ToolboxWorkspaceFactory
from nsdeploy.studio_content.github_content import GithubContent


class TestStudioLocal(unittest.TestCase):
    """
    Tests that `Studio.local` builds a workspace in which a local checkout is mirrored
    at the logical paths a build asks for.
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
        self.studio: ToolboxWorkspace = ToolboxWorkspaceFactory.local(self.checkout, cache_dir=self.cache)

    def write(self, rel_path: str, text: str) -> None:
        """
        Write a file into the checkout.

        :param rel_path: The file path relative to the checkout
        :param text: The file contents
        """
        path: Path = self.checkout / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def test_materialize_keeps_exact_paths(self) -> None:
        """
        Tests that a file at its logical path is mirrored at the same path.
        """
        self.assertEqual(self.studio.materialize("registries/aaosa.hocon"), self.cache / "registries" / "aaosa.hocon")

    def test_materialize_finds_file_by_suffix(self) -> None:
        """
        Tests that a file under a package directory is mirrored at its logical path.
        """
        path: Path = self.studio.materialize("toolbox/toolbox_info.hocon")
        self.assertEqual(path, self.cache / "toolbox" / "toolbox_info.hocon")
        self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_materialize_coded_tool_makes_nested_module_importable(self) -> None:
        """
        Tests that a coded tool under a package directory is found under `coded_tools`.
        """
        self.assertTrue(self.studio.ensure_coded_tool("web_fetch.py"))
        self.assertEqual(CodedToolModule.find(self.studio.import_root(), "web_fetch"), "coded_tools.web_fetch")

    def test_materialize_copies_current_contents(self) -> None:
        """
        Tests that an edit to the checkout reaches the mirror on the next request.
        """
        self.studio.ensure_coded_tool("web_fetch.py")
        self.write("neuro_san_studio/coded_tools/web_fetch.py", "VALUE = 2\n")
        self.studio.ensure_coded_tool("web_fetch.py")
        self.assertEqual((self.cache / "coded_tools" / "web_fetch.py").read_text(encoding="utf-8"), "VALUE = 2\n")

    def test_materialize_skips_virtualenv(self) -> None:
        """
        Tests that files in a virtualenv of the checkout are not studio sources.
        """
        self.assertFalse(self.studio.ensure_coded_tool("only_in_venv.py"))

    def test_materialize_rejects_path_outside_root(self) -> None:
        """
        Tests that a logical path cannot write outside the mirror directory.
        """
        self.assertIsNone(self.studio.materialize("../escape.txt"))

    def test_materialize_returns_none_for_unknown_file(self) -> None:
        """
        Tests that a file the checkout does not have is reported as unavailable.
        """
        self.assertIsNone(self.studio.materialize("toolbox/missing.hocon"))

    def test_materialize_drops_deleted_file(self) -> None:
        """
        Tests that a file deleted from the checkout is also removed from the mirror.
        """
        self.studio.materialize("registries/aaosa.hocon")
        (self.checkout / "registries" / "aaosa.hocon").unlink()
        self.assertIsNone(ToolboxWorkspaceFactory.local(self.checkout, cache_dir=self.cache).materialize("registries/aaosa.hocon"))
        self.assertFalse((self.cache / "registries" / "aaosa.hocon").exists())

    def test_concurrent_ensure_shares_mirror(self) -> None:
        """
        Tests that builds in several threads can mirror the same file at the same time.
        """
        studios: List[ToolboxWorkspace] = []
        # Give each thread its own workspace, as each build creates one.
        for _ in range(16):  # type: int
            studios.append(ToolboxWorkspaceFactory.local(self.checkout, cache_dir=self.cache))
        with ThreadPoolExecutor(max_workers=16) as pool:
            results: List[Optional[Path]] = list(pool.map(self.ensure_toolbox, studios))
        # Every thread gets the mirrored file.
        for result in results:  # type: Optional[Path]
            self.assertEqual(result, self.cache / "toolbox" / "toolbox_info.hocon")
        self.assertEqual(list(self.cache.glob("toolbox/.*")), [])

    @staticmethod
    def ensure_toolbox(studio: ToolboxWorkspace) -> Optional[Path]:
        """
        Mirror the toolbox file through one workspace.

        :param studio: The workspace to use
        :return: The mirrored path
        """
        return studio.materialize("toolbox/toolbox_info.hocon")


class TestStudioGithub(unittest.TestCase):
    """
    Tests that `Studio.github` builds a workspace in which a repository is mirrored at
    the logical paths a build asks for, and that a build that cannot reach the
    repository is served from the mirror.
    """

    REPO: str = "cognizant-ai-lab/neuro-san-studio"

    def setUp(self) -> None:
        """
        Create an empty mirror and a workspace that reads the repository into it.

        The mirror sits in a test-owned parent, because a test writes a file next to it.
        """
        parent: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, parent)
        self.cache: Path = parent / "studio"
        self.studio: ToolboxWorkspace = ToolboxWorkspaceFactory.github(self.REPO, "main", cache_dir=self.cache)

    @staticmethod
    def repository(paths: List[str], raw: bytes = b"{}") -> Any:
        """
        Answer every repository call from the test, so no test reaches the network.

        All three calls are replaced together, because an unpatched one is a real
        request to GitHub.

        :param paths: What the repository lists.
        :param raw: What every file read returns.
        :return: The patch to use as a context manager.
        """
        return mock.patch.multiple(GithubContent,
                                   list_paths=mock.MagicMock(return_value=paths),
                                   read=mock.MagicMock(return_value=raw),
                                   revision=mock.MagicMock(return_value="sha"))

    @staticmethod
    def offline_repository() -> Any:
        """
        Fail every repository call the way an unreachable network does.

        :return: The patch to use as a context manager.
        """
        return mock.patch.multiple(GithubContent,
                                   list_paths=mock.MagicMock(side_effect=OSError("offline")),
                                   read=mock.MagicMock(side_effect=OSError("offline")),
                                   revision=mock.MagicMock(side_effect=OSError("offline")))

    def test_materialize_mirrors_a_repository_file_at_its_logical_path(self) -> None:
        """
        Tests that a file under the repository's package directory is mirrored at the
        path the including file names.
        """
        with self.repository(["neuro_san_studio/registries/aaosa.hocon"]):
            path: Optional[Path] = self.studio.materialize("registries/aaosa.hocon")
        self.assertEqual(path, self.cache / "registries" / "aaosa.hocon")
        self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_a_later_build_reads_the_repository_again(self) -> None:
        """
        Tests that each build reads the repository, so a file edited upstream reaches
        the next build and replaces the mirrored copy.
        """
        with self.repository(["neuro_san_studio/registries/aaosa.hocon"]):
            self.studio.materialize("registries/aaosa.hocon")
        # A workspace with no memory, as the next build process has.
        later: ToolboxWorkspace = ToolboxWorkspaceFactory.github(self.REPO, "main", cache_dir=self.cache)
        with self.repository(["neuro_san_studio/registries/aaosa.hocon"], raw=b"{ edited }"):
            path: Optional[Path] = later.materialize("registries/aaosa.hocon")
        self.assertEqual(path.read_bytes(), b"{ edited }")

    def test_refs_with_slashes_get_separate_flat_mirrors(self) -> None:
        """
        Tests that a ref containing `/` does not put its mirror inside the mirror of a
        shorter ref, where that ref's includes could reach it, and that
        refs which read alike once sanitized still get separate mirrors.
        """
        home: Path = self.cache.parent / "home"
        root: Path = (home / ".cache" / "nsdeploy").resolve()
        bases: List[Path] = []
        with mock.patch.object(Path, "home", return_value=home):
            # One workspace per ref, recording where each mirror is.
            for ref in ["release", "release/feature", "release_feature"]:  # type: str
                bases.append(ToolboxWorkspaceFactory.github(self.REPO, ref).include_base())
        self.assertEqual(len(set(bases)), 3)
        # Every mirror is directly under the nsdeploy cache root, so none holds another.
        for base in bases:  # type: Path
            self.assertEqual(base.parent, root)

    def test_an_offline_build_uses_the_mirror(self) -> None:
        """
        Tests that a mirror filled by an earlier build still serves a build that cannot
        reach the repository, and that a file it lacks still fails.
        """
        mirrored: Path = self.cache / "registries" / "aaosa.hocon"
        mirrored.parent.mkdir(parents=True)
        mirrored.write_text("{}", encoding="utf-8")
        with self.offline_repository():
            self.assertEqual(self.studio.materialize("registries/aaosa.hocon"), mirrored)
            with self.assertRaises(OSError):
                self.studio.materialize("registries/absent.hocon")
            self.assertIsNone(self.studio.materialize("../escape.hocon"))

    def test_an_offline_build_uses_a_mirrored_coded_tool(self) -> None:
        """
        Tests that a coded tool left in the mirror by an earlier build is importable
        when the repository cannot be reached.
        """
        tools: Path = self.cache / "coded_tools"
        tools.mkdir(parents=True)
        (tools / "__init__.py").write_text("", encoding="utf-8")
        (tools / "web_fetch.py").write_text("VALUE = 1\n", encoding="utf-8")
        with self.offline_repository():
            self.assertTrue(self.studio.ensure_coded_tool("web_fetch.py"))
            with self.assertRaises(OSError):
                self.studio.ensure_coded_tool("absent.py")

    def test_materialize_rejects_a_path_outside_the_mirror(self) -> None:
        """
        Tests that a `..` in a network's include cannot answer with a file outside the
        mirror.
        """
        outside: Path = self.cache.parent / "escape.hocon"
        outside.write_text("{}", encoding="utf-8")
        self.addCleanup(outside.unlink)
        with self.repository(["escape.hocon"]):
            self.assertIsNone(self.studio.materialize("../escape.hocon"))
