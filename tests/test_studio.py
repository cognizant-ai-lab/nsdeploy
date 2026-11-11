import json
import os
import shutil
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict
from typing import List
from typing import Optional
from unittest import mock

import nsdeploy.studio as studio_module
from nsdeploy.coded_tool_module import CodedToolModule
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.studio import FILE_LIST_CACHE_NAME
from nsdeploy.studio import FILE_LIST_CACHE_TTL_SECONDS
from nsdeploy.studio import TOKEN_ENV_NAMES
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio

FILES = ["coding/aaosa.hocon", "toolbox/toolbox_info.hocon"]

# The cache and the token are internals on purpose: nothing public exposes the file
# list, and these tests exist to pin exactly that behaviour.
# pylint: disable=protected-access


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
        self.assertEqual(list(self.cache.glob("toolbox/*.tmp")), [])

    @staticmethod
    def ensure_toolbox(studio: LocalStudio) -> Optional[Path]:
        """
        Mirror the toolbox file through one source.

        :param studio: The source to use
        :return: The mirrored path
        """
        return studio.ensure("toolbox/toolbox_info.hocon")


class TestGithubStudio(unittest.TestCase):
    """The repo's file list: cached between processes, and authenticated when a
    token is available.

    The listing is one api.github.com call, and a deployment service runs one
    process per build. Unauthenticated that allowance is 60 calls an hour per IP,
    after which resolving an include raises rather than slowing down — so both the
    cache and the token are availability measures, not optimizations.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.cache = Path(self._tmp.name)
        self._http_get = studio_module._http_get
        self.requested: List[str] = []
        # Saved and cleared, not merely cleared: a developer's own token would
        # otherwise decide what these tests assert, and tearDown would then take
        # it away from every test that runs after them.
        self._tokens: Dict[str, str] = {}
        for name in TOKEN_ENV_NAMES:
            if name in os.environ:
                self._tokens[name] = os.environ.pop(name)

    def tearDown(self) -> None:
        studio_module._http_get = self._http_get
        # Whatever this test set goes, whatever the developer had comes back.
        for name in TOKEN_ENV_NAMES:
            os.environ.pop(name, None)
        for name, value in self._tokens.items():
            os.environ[name] = value
        self._tmp.cleanup()

    def _serve_file_list(self, payload: Optional[str]) -> None:
        """
        Answer every HTTP call with `payload`, recording the URLs asked for.

        :param payload: The body to return, or None for a 404.
        """
        self.requested = []
        studio_module._http_get = self._record(payload)

    def _record(self, payload: Optional[str]):
        """
        Build a replacement for `_http_get` that records its calls.

        :param payload: The body to return.
        :return: The replacement callable.
        """
        requested = self.requested

        def _get(url: str) -> Optional[str]:
            requested.append(url)
            return payload

        return _get

    @staticmethod
    def _payload(paths: List[str]) -> str:
        """
        Render a GitHub tree response.

        :param paths: The file paths it should list.
        :return: The JSON body.
        """
        entries = []
        # GitHub's own names: a "blob" entry per file, plus a "tree" entry for a
        # directory, which the loader must ignore.
        for path in paths:
            entries.append({"path": path, "type": "blob"})
        entries.append({"path": "coding", "type": "tree"})
        return json.dumps({"tree": entries})

    def test_the_first_build_fetches_the_listing(self):
        """The first build fetches the file list."""
        self._serve_file_list(self._payload(FILES))
        studio = GithubStudio(cache_dir=self.cache)
        self.assertEqual(studio._list_files(), FILES)
        self.assertEqual(len(self.requested), 1)

    def test_a_later_process_reads_the_cache_instead_of_the_api(self):
        """This is the whole point: a second deployment must not spend a second API
        call, because the hourly allowance is what runs out first."""
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache)._list_files()
        self._serve_file_list(self._payload(FILES))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(self.requested, [])

    def test_an_expired_cache_is_refetched(self):
        """The ref moves, so a cache that never expired would pin every later build
        to the file list as it was the first time anything deployed."""
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache)._list_files()
        stale = time.time() - FILE_LIST_CACHE_TTL_SECONDS - 60
        os.utime(self.cache / FILE_LIST_CACHE_NAME, (stale, stale))
        self._serve_file_list(self._payload(FILES))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(len(self.requested), 1)

    def test_a_corrupt_cache_is_ignored_rather_than_raised(self):
        """Several builds write this file concurrently. A half-written one must cost
        an API call, not a failed deployment."""
        (self.cache / FILE_LIST_CACHE_NAME).write_text("{not json", encoding="utf-8")
        self._serve_file_list(self._payload(FILES))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(len(self.requested), 1)

    def test_a_cache_holding_the_wrong_shape_is_ignored(self):
        """A cache holding the wrong shape is ignored."""
        (self.cache / FILE_LIST_CACHE_NAME).write_text('{"tree": []}', encoding="utf-8")
        self._serve_file_list(self._payload(FILES))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(len(self.requested), 1)

    def test_an_unreadable_listing_is_still_an_error(self):
        """An unreadable listing is still an error."""
        self._serve_file_list(None)
        with self.assertRaises(RuntimeError) as caught:
            GithubStudio(cache_dir=self.cache)._list_files()
        self.assertIn("cannot read git tree", str(caught.exception))

    def test_a_cache_holding_a_non_string_entry_is_ignored(self):
        """_resolve_upstream calls endswith() on every entry, so [null] would raise
        AttributeError instead of falling back to a fetch."""
        for payload in ("[null]", "[{}]", '["ok", 7]'):
            with self.subTest(payload=payload):
                (self.cache / FILE_LIST_CACHE_NAME).write_text(payload, encoding="utf-8")
                self._serve_file_list(self._payload(FILES))
                self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
                self.assertEqual(len(self.requested), 1)

    def test_concurrent_writers_do_not_share_a_temporary_path(self):
        """A deployment service builds several bundles at once in worker threads of
        one process, so a pid-based temporary name would be shared and one writer
        could replace the file while another still held it open."""
        first = GithubStudio(cache_dir=self.cache)
        second = GithubStudio(cache_dir=self.cache)
        with mock.patch.object(studio_module.os, "replace") as replace:
            first._store_file_list(["one.hocon"])
            second._store_file_list(["two.hocon"])
            written = [call.args[0] for call in replace.call_args_list]
        self.assertEqual(len(written), 2)
        self.assertNotEqual(written[0], written[1])

    def test_a_failed_write_leaves_no_temporary_file_behind(self):
        """A failed write leaves no temporary file behind."""
        with mock.patch.object(studio_module.os, "replace", side_effect=OSError("nope")):
            with self.assertLogs(studio_module.LOGGER, level="WARNING"):
                GithubStudio(cache_dir=self.cache)._store_file_list(["one.hocon"])
        leftovers = sorted(item.name for item in self.cache.iterdir())
        self.assertEqual(leftovers, [])

    def test_a_failed_write_is_reported_with_its_destination(self):
        """A silent failure means every later build spends another API call until the
        hourly allowance is gone, with nothing saying why."""
        with mock.patch.object(studio_module.os, "replace", side_effect=OSError("disk full")):
            with self.assertLogs(studio_module.LOGGER, level="WARNING") as logged:
                GithubStudio(cache_dir=self.cache)._store_file_list(["one.hocon"])
        report = "\n".join(logged.output)
        self.assertIn(FILE_LIST_CACHE_NAME, report)
        self.assertIn("disk full", report)
        self.assertIn(DEFAULT_REPO, report)

    def test_a_failed_cleanup_is_reported_too(self):
        """The leftover is what a later write has to work around, so it is worth
        naming even though neither failure stops the build."""
        with mock.patch.object(studio_module.os, "replace", side_effect=OSError("nope")):
            with mock.patch.object(Path, "unlink", autospec=True,
                                   side_effect=OSError("read-only")):
                with self.assertLogs(studio_module.LOGGER, level="WARNING") as logged:
                    GithubStudio(cache_dir=self.cache)._store_file_list(["one.hocon"])
        self.assertIn("read-only", "\n".join(logged.output))

    def test_a_successful_write_says_nothing(self):
        """Caching is the normal path; a line per build would be noise."""
        studio = GithubStudio(cache_dir=self.cache)
        with mock.patch.object(studio_module.LOGGER, "warning") as warned:
            studio._store_file_list(["one.hocon"])
        warned.assert_not_called()


class TestStudioWarmUp(unittest.TestCase):
    """Warming the file list in the service, so no child has to fetch it.

    A site process receives no GitHub credential, so a child that found the cached
    list expired would fetch it anonymously and could meet the 60-an-hour limit even
    where the service holds a token. The service therefore refreshes on a schedule
    shorter than the TTL, which is what `force` is for.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.cache = Path(self._tmp.name)
        self._http_get = studio_module._http_get
        self.requested: List[str] = []

    def tearDown(self) -> None:
        studio_module._http_get = self._http_get
        self._tmp.cleanup()

    def _serve_file_list(self, payload: Optional[str]) -> None:
        """
        Answer every HTTP call with `payload`, recording the URLs asked for.

        :param payload: The body to return, or None for a 404.
        """
        self.requested = []
        studio_module._http_get = self._record(payload)

    def _record(self, payload: Optional[str]):
        """
        Build a replacement for `_http_get` that records its calls.

        :param payload: The body to return.
        :return: The replacement callable.
        """
        requested = self.requested

        def _get(url: str) -> Optional[str]:
            requested.append(url)
            return payload

        return _get

    @staticmethod
    def _payload(paths: List[str]) -> str:
        """
        Render a GitHub tree response.

        :param paths: The file paths it should list.
        :return: The JSON body.
        """
        entries = []
        # GitHub's own names: a "blob" entry per file, plus a "tree" entry for a
        # directory, which the loader must ignore.
        for path in paths:
            entries.append({"path": path, "type": "blob"})
        entries.append({"path": "coding", "type": "tree"})
        return json.dumps({"tree": entries})

    def test_warming_caches_the_listing_for_later_builds(self):
        """The point of warming: one call here, none in the builds that follow."""
        self._serve_file_list(self._payload(FILES))
        self.assertTrue(GithubStudio(cache_dir=self.cache).warm_files())
        self.assertEqual(len(self.requested), 1)
        self._serve_file_list(self._payload(FILES))
        # A build in its own process, as a deployment is.
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(self.requested, [])

    def test_warming_an_already_warm_source_costs_nothing(self):
        """Warming an already warm source costs nothing."""
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache).warm_files()
        self._serve_file_list(self._payload(FILES))
        self.assertTrue(GithubStudio(cache_dir=self.cache).warm_files())
        self.assertEqual(self.requested, [])

    def test_warming_reports_a_failure_without_raising(self):
        """Start-up must not fail because GitHub is unreachable; the next build that
        needs a listing fetches it itself."""
        self._serve_file_list(None)
        with self.assertLogs(studio_module.LOGGER, level="WARNING") as logged:
            self.assertFalse(GithubStudio(cache_dir=self.cache).warm_files())
        self.assertIn("cannot warm the file list", "\n".join(logged.output))

    def test_a_local_studio_needs_no_warming(self):
        """So a caller can warm whatever source it holds without asking what it is."""
        self.assertTrue(LocalStudio(self.cache).warm_files())

    def test_a_forced_refresh_replaces_a_list_that_is_still_fresh(self):
        """A child receives no GitHub credential, so one that found the list expired
        would fetch it anonymously. The service refreshes before expiry instead, which
        means ignoring a cached list that is merely still valid.
        """
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache).warm_files()
        self.assertEqual(len(self.requested), 1)
        self._serve_file_list(self._payload(FILES))
        # Not forced: the fresh cache answers and nothing is fetched.
        GithubStudio(cache_dir=self.cache).warm_files()
        self.assertEqual(self.requested, [])
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache).warm_files(force=True)
        self.assertEqual(len(self.requested), 1)

    def test_a_forced_refresh_renews_the_cache_on_disk(self):
        """What the child reads is the file, so refreshing in memory alone would leave
        it ageing out exactly as before."""
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache).warm_files()
        stale = time.time() - FILE_LIST_CACHE_TTL_SECONDS - 60
        os.utime(self.cache / FILE_LIST_CACHE_NAME, (stale, stale))
        self._serve_file_list(self._payload(FILES))
        GithubStudio(cache_dir=self.cache).warm_files(force=True)
        # Fresh again, so a child reading it now does not fetch.
        self._serve_file_list(self._payload(FILES))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._list_files(), FILES)
        self.assertEqual(self.requested, [])

    def test_a_forced_refresh_that_fails_is_reported_without_raising(self):
        """The refresh runs forever in a background task; one failed pass must not end
        it or the service."""
        self._serve_file_list(None)
        with self.assertLogs(studio_module.LOGGER, level="WARNING"):
            self.assertFalse(GithubStudio(cache_dir=self.cache).warm_files(force=True))

    def test_a_local_studio_ignores_a_forced_refresh(self):
        """A local studio ignores a forced refresh."""
        self.assertTrue(LocalStudio(self.cache).warm_files(force=True))


class TestStudioToken(unittest.TestCase):
    """Which environment variable authenticates a file-list request.

    A token raises the api.github.com allowance from 60 an hour per IP to 5000,
    which is what makes a busy deployment service able to resolve includes at all.
    """

    def setUp(self) -> None:
        # Saved and cleared, not merely cleared: a developer's own token would
        # otherwise decide what these tests assert, and tearDown would then take it
        # away from every test that runs after them.
        self._tokens: Dict[str, str] = {}
        for name in TOKEN_ENV_NAMES:
            if name in os.environ:
                self._tokens[name] = os.environ.pop(name)

    def tearDown(self) -> None:
        # Whatever this test set goes, whatever the developer had comes back.
        for name in TOKEN_ENV_NAMES:
            os.environ.pop(name, None)
        for name, value in self._tokens.items():
            os.environ[name] = value

    def test_no_token_configured_reports_none(self):
        """No token configured reports none."""
        self.assertEqual(studio_module._github_token(), "")

    def test_each_token_name_is_honoured(self):
        """Each token name is honoured."""
        # Checked one at a time, so a deployment setting any of them is covered.
        for name in TOKEN_ENV_NAMES:
            with self.subTest(name=name):
                os.environ[name] = f"token-for-{name}"
                self.assertEqual(studio_module._github_token(), f"token-for-{name}")
                os.environ.pop(name)

    def test_the_service_specific_name_wins(self):
        """So a deployment can point nsdeploy at its own token without unsetting the
        ambient CI one."""
        os.environ["GITHUB_TOKEN"] = "ambient"
        os.environ["NSDEPLOY_GITHUB_TOKEN"] = "ours"
        self.assertEqual(studio_module._github_token(), "ours")

    def test_a_blank_token_is_not_used(self):
        """A blank token is not used."""
        os.environ["GITHUB_TOKEN"] = "   "
        self.assertEqual(studio_module._github_token(), "")


if __name__ == "__main__":
    unittest.main()
