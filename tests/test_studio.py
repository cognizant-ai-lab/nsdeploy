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
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio
from nsdeploy.studio_content.cached_content import CachedContent
from nsdeploy.studio_content.github_content import GithubContent


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

    def test_ensure_drops_deleted_file(self) -> None:
        """
        Tests that a file deleted from the checkout is also removed from the mirror.
        """
        self.studio.ensure("registries/aaosa.hocon")
        (self.checkout / "registries" / "aaosa.hocon").unlink()
        self.assertIsNone(LocalStudio(self.checkout, cache_dir=self.cache).ensure("registries/aaosa.hocon"))
        self.assertFalse((self.cache / "registries" / "aaosa.hocon").exists())

    def test_concurrent_ensure_shares_mirror(self) -> None:
        """
        Tests that builds in several threads can mirror the same file at the same time.
        """
        studios: List[LocalStudio] = []
        # Give each thread its own source, as each build creates one.
        for _ in range(16):  # type: int
            studios.append(LocalStudio(self.checkout, cache_dir=self.cache))
        with ThreadPoolExecutor(max_workers=16) as pool:
            results: List[Optional[Path]] = list(pool.map(self.ensure_toolbox, studios))
        # Every thread gets the mirrored file.
        for result in results:  # type: Optional[Path]
            self.assertEqual(result, self.cache / "toolbox" / "toolbox_info.hocon")
        self.assertEqual(list(self.cache.glob("toolbox/.*")), [])

    @staticmethod
    def ensure_toolbox(studio: LocalStudio) -> Optional[Path]:
        """
        Mirror the toolbox file through one source.

        :param studio: The source to use
        :return: The mirrored path
        """
        return studio.ensure("toolbox/toolbox_info.hocon")


class TestGithubStudio(unittest.TestCase):
    """
    Tests that a repository is mirrored at the logical paths a build asks for, and that
    a later build answers from the cache without reading the repository again.
    """

    REPO: str = "cognizant-ai-lab/neuro-san-studio"

    def setUp(self) -> None:
        """
        Create an empty cache and a studio that reads the repository through it.

        The cache sits in a test-owned parent, because the repository cache is written
        beside it and a test writes files next to it.
        """
        parent: Path = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, parent)
        self.cache: Path = parent / "studio"
        self.studio: GithubStudio = GithubStudio(self.REPO, "main", cache_dir=self.cache)

    @staticmethod
    def repository(paths: List[str], raw: bytes = b"{}") -> Any:
        """
        Answer every repository call from the test, so no test reaches the network.

        All three calls are replaced together: the cache asks for the revision as well
        as the file list, and an unpatched one is a real request to GitHub.

        :param paths: What the repository lists.
        :param raw: What every file read returns.
        :return: The patch to use as a context manager.
        """
        return mock.patch.multiple(GithubContent,
                                   list_paths=mock.MagicMock(return_value=paths),
                                   read=mock.MagicMock(return_value=raw),
                                   revision=mock.MagicMock(return_value="sha"))

    @staticmethod
    def unreachable_repository() -> Any:
        """
        Fail any repository call, so a test can prove that none is made.

        :return: The patch to use as a context manager.
        """
        return mock.patch.multiple(GithubContent,
                                   list_paths=mock.MagicMock(side_effect=AssertionError("listed")),
                                   read=mock.MagicMock(side_effect=AssertionError("read")),
                                   revision=mock.MagicMock(side_effect=AssertionError("revision")))

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

    def test_ensure_mirrors_a_repository_file_at_its_logical_path(self) -> None:
        """
        Tests that a file under the repository's package directory is mirrored at the
        path the including file names.
        """
        with self.repository(["neuro_san_studio/registries/aaosa.hocon"]):
            path: Optional[Path] = self.studio.ensure("registries/aaosa.hocon")
        self.assertEqual(path, self.cache / "registries" / "aaosa.hocon")
        self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_a_later_build_reads_nothing_from_the_repository(self) -> None:
        """
        Tests that a warm cache costs no request, in this process or the next one. This
        is what keeps a repeat build off the network, and the file list, which is the
        rate-limited call, unasked for.
        """
        with self.repository(["neuro_san_studio/registries/aaosa.hocon"]):
            self.studio.ensure("registries/aaosa.hocon")
        # A studio with no memory, as the next build process has.
        later: GithubStudio = GithubStudio(self.REPO, "main", cache_dir=self.cache)
        with self.unreachable_repository():
            path: Optional[Path] = later.ensure("registries/aaosa.hocon")
        self.assertEqual(path, self.cache / "registries" / "aaosa.hocon")
        self.assertEqual(path.read_text(encoding="utf-8"), "{}")

    def test_the_repository_cache_is_kept_out_of_the_include_base(self) -> None:
        """
        Tests that the cache's own bookkeeping does not appear in the mirror. pyhocon
        parses a network against the mirror, so anything written there is a file a
        network could include.
        """
        with self.repository(["registries/aaosa.hocon"]):
            self.studio.ensure("registries/aaosa.hocon")
        upstream: Path = self.cache.parent / (self.cache.name + GithubStudio.UPSTREAM_SUFFIX)
        self.assertTrue((upstream / CachedContent.LISTING_NAME).is_file())
        written: List[Path] = []
        # Every file the build left in the mirror.
        for path in self.cache.rglob("*"):
            if path.is_file():
                written.append(path.relative_to(self.cache))
        self.assertEqual(written, [Path("registries/aaosa.hocon")])

    def test_an_include_cannot_reach_the_repository_cache(self) -> None:
        """
        Tests that a network naming the cache's own files cannot overwrite a cached
        file or remove the file list. Both are inputs to every later build.
        """
        repository: List[str] = ["a/common.hocon", "b/common.hocon"]
        with self.repository(repository):
            self.studio.ensure("a/common.hocon")
            self.studio.ensure("b/common.hocon")
        upstream: Path = self.cache.parent / (self.cache.name + GithubStudio.UPSTREAM_SUFFIX)
        listing: Path = upstream / CachedContent.LISTING_NAME
        cached: List[Path] = sorted((upstream / CachedContent.FILES_DIR).iterdir())
        reach: str = f"../{upstream.name}"
        with self.repository(repository, raw=b"overwritten"):
            self.assertIsNone(self.studio.ensure(f"{reach}/{CachedContent.FILES_DIR}/{cached[-1].name}"))
            self.assertIsNone(self.studio.ensure(f"{reach}/{CachedContent.LISTING_NAME}"))
            self.assertIsNone(self.studio.ensure(f"{GithubStudio.UPSTREAM_SUFFIX}/{CachedContent.LISTING_NAME}"))
        self.assertEqual(len(cached), 2)
        # Each cached file still holds what the repository returned.
        for path in cached:  # type: Path
            self.assertEqual(path.read_bytes(), b"{}")
        self.assertTrue(listing.is_file())

    def test_an_offline_build_uses_a_mirror_with_no_repository_cache(self) -> None:
        """
        Tests that a mirror filled before the repository cache existed still serves a
        build that cannot reach the repository, and that a file it lacks still fails.
        """
        mirrored: Path = self.cache / "registries" / "aaosa.hocon"
        mirrored.parent.mkdir(parents=True)
        mirrored.write_text("{}", encoding="utf-8")
        with self.offline_repository():
            self.assertEqual(self.studio.ensure("registries/aaosa.hocon"), mirrored)
            self.assertEqual(self.studio.read("registries/aaosa.hocon"), "{}")
            with self.assertRaises(OSError):
                self.studio.ensure("registries/absent.hocon")
            self.assertIsNone(self.studio.ensure("../escape.hocon"))

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

    def test_ensure_rejects_a_path_outside_the_cache(self) -> None:
        """
        Tests that a `..` in a network's include cannot answer with a file outside the
        cache, cached or not.
        """
        outside: Path = self.cache.parent / "escape.hocon"
        outside.write_text("{}", encoding="utf-8")
        self.addCleanup(outside.unlink)
        with self.repository(["escape.hocon"]):
            self.assertIsNone(self.studio.ensure("../escape.hocon"))
