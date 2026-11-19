import functools
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from typing import Dict
from typing import List
from typing import Optional
from unittest import mock

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.studio_content import cached_content as cached_content_module
from nsdeploy.studio_content.cached_content import CachedContent


class _Source(ToolboxContent):
    """A toolbox that counts what it was asked, which is what the cache is about."""

    def __init__(self, files: Dict[str, bytes], name: str = "fake:studio") -> None:
        """
        Hold a toolbox made of `files`.

        :param files: The file content, by path.
        :param name: The identity to report.
        """
        self.files: Dict[str, bytes] = files
        self.name: str = name
        self.rev: str = "r1"
        self.listings: int = 0
        self.reads: List[str] = []
        self.refreshes: int = 0
        self.broken: bool = False

    @override
    def identity(self) -> str:
        """
        :return: The name this source was made with.
        """
        return self.name

    @override
    def revision(self) -> str:
        """
        :return: The revision this source reports.
        """
        return self.rev

    @override
    def list_paths(self) -> List[str]:
        """
        :return: The paths held, counting the call.
        :raises OSError: When this source is set to fail.
        """
        self.listings += 1
        if self.broken:
            raise OSError("cannot list")
        return list(self.files.keys())

    @override
    def refresh(self) -> None:
        """
        Count the call, so a test can prove it reached this far.
        """
        self.refreshes += 1

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        :param path: The path to read.
        :return: The file's bytes, or None when there is no such file.
        """
        self.reads.append(path)
        return self.files.get(path)


# pylint: disable-next=too-many-public-methods  # one test per behaviour of the cache
class TestCachedContent(unittest.TestCase):
    """A source answered from disk where it can be.

    What these tests pin is the second reader: a build in another process must find
    the file list and the files already there, and ask the source for nothing. The
    rest is what makes that safe — whose content is in the cache, when the list is
    asked for again, and what happens when the source cannot be reached at all.
    """

    def setUp(self) -> None:
        """
        Give each test an empty cache and a source that counts its callers.
        """
        # The cache sits inside a directory of its own, so a test that checks nothing was
        # written beside it looks at a directory this test owns rather than at the system
        # temporary directory, which everything else shares.
        self.base: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.base)
        self.cache: Path = self.base / "cache"
        self.cache.mkdir()
        self.source: _Source = _Source({"registries/aaosa.hocon": b"{}",
                                        "coded_tools/web_fetch.py": b"VALUE = 1\n"})
        self.cached: CachedContent = CachedContent(self.source, self.cache)

    def second_reader(self, ttl_seconds: float = CachedContent.DEFAULT_TTL_SECONDS) -> CachedContent:
        """
        A reader with the same cache and no memory, as the next process has.

        :param ttl_seconds: How long that reader uses a cached file list.
        :return: The second reader.
        """
        return CachedContent(self.source, self.cache, ttl_seconds=ttl_seconds)

    @staticmethod
    def refreshed_meanwhile(listing: Path, fileno: int, operation: int) -> None:
        """
        Stand in for taking the lock, during which another reader refreshes the listing.

        :param listing: The cached listing file.
        :param fileno: The lock file's descriptor, unused.
        :param operation: The lock operation, unused.
        """
        del fileno, operation
        TestCachedContent.date_listing(listing, time.time())

    @staticmethod
    def date_listing(listing: Path, written: float) -> None:
        """
        Set when a cached listing records it was written, leaving the file's own time.

        :param listing: The cached listing file.
        :param written: The time to record.
        """
        body: Dict = json.loads(listing.read_text(encoding="utf-8"))
        body["written"] = written
        listing.write_text(json.dumps(body), encoding="utf-8")

    # --- identity ----------------------------------------------------------
    def test_the_identity_is_the_wrapped_sources(self):
        """A reader needs where a missing file was looked for, not where it was not
        kept."""
        self.assertEqual(self.cached.identity(), "fake:studio")

    # --- the file list -----------------------------------------------------
    def test_the_listing_is_asked_for_once_across_readers(self):
        """The point of the cache: a build in the next process pays nothing."""
        self.cached.list_paths()
        self.assertEqual(self.second_reader().list_paths(), self.cached.list_paths())
        self.assertEqual(self.source.listings, 1)

    def test_the_revision_comes_back_without_asking_the_source(self):
        """It is recorded with the list it was taken at, so a later reader can say what
        it resolved against."""
        self.cached.list_paths()
        self.assertEqual(self.second_reader().revision(), "r1")
        self.assertEqual(self.source.listings, 1)

    def test_the_listing_is_a_copy(self):
        """A caller that keeps the list must not be able to change what is cached."""
        first: List[str] = self.cached.list_paths()
        first.append("invented.hocon")
        self.assertNotIn("invented.hocon", self.cached.list_paths())

    def test_a_listing_from_another_source_is_ignored(self):
        """Two sources sharing a directory would answer each other's reads, so the
        mistake shows up as a slow build rather than as the wrong files."""
        self.cached.list_paths()
        other: CachedContent = CachedContent(_Source({}, name="other:studio"), self.cache)
        self.assertEqual(other.list_paths(), [])

    def test_a_listing_past_its_age_is_asked_for_again(self):
        """A branch moves, and a build has to see a file that was added upstream."""
        self.cached.list_paths()
        self.source.files["registries/added.hocon"] = b"{}"
        self.assertIn("registries/added.hocon", self.second_reader(ttl_seconds=0).list_paths())
        self.assertEqual(self.source.listings, 2)

    def test_a_listing_past_its_age_is_used_when_the_source_cannot_be_reached(self):
        """Otherwise expiry would turn a cache that works offline into a failed build."""
        self.cached.list_paths()
        self.source.broken = True
        self.assertIn("registries/aaosa.hocon", self.second_reader(ttl_seconds=0).list_paths())

    def test_an_expired_listing_asks_the_wrapped_source_to_forget_its_own(self):
        """The source's memo may be as old as the listing; rewriting it with a fresh
        time would hide an upstream addition for another time to live."""
        self.cached.list_paths()
        self.second_reader(ttl_seconds=0).list_paths()
        self.assertEqual(self.source.refreshes, 1)

    @unittest.skipIf(cached_content_module.fcntl is None, "no fcntl on this platform")
    def test_a_listing_refreshed_while_waiting_for_the_lock_is_used(self):
        """Concurrent builds would otherwise each make the rate-limited listing call."""
        self.cached.list_paths()
        listing: Path = self.cache / CachedContent.LISTING_NAME
        TestCachedContent.date_listing(listing, 0.0)
        meanwhile: functools.partial = functools.partial(TestCachedContent.refreshed_meanwhile, listing)
        with mock.patch.object(cached_content_module.fcntl, "flock", side_effect=meanwhile):
            self.assertIn("registries/aaosa.hocon", self.second_reader().list_paths())
        self.assertEqual(self.source.listings, 1)

    def test_the_age_is_read_from_the_listing_not_the_file(self):
        """Another process can replace the file between two reads; the age has to
        belong to the paths it is judged with."""
        self.cached.list_paths()
        TestCachedContent.date_listing(self.cache / CachedContent.LISTING_NAME, 0.0)
        self.second_reader().list_paths()
        self.assertEqual(self.source.listings, 2)

    def test_a_failed_refresh_lets_later_readers_wait_before_asking_again(self):
        """Otherwise every build waiting on the lock repeats the failed request, each
        one waiting out the source's timeout."""
        self.cached.list_paths()
        self.source.broken = True
        self.assertIn("registries/aaosa.hocon", self.second_reader(ttl_seconds=0).list_paths())
        self.assertIn("registries/aaosa.hocon", self.second_reader(ttl_seconds=0).list_paths())
        self.assertEqual(self.source.listings, 2)

    def test_a_forced_refresh_does_not_wait_for_a_retry(self):
        """A refresh is asked for explicitly, so the retry delay does not apply to it."""
        self.cached.list_paths()
        self.source.broken = True
        self.second_reader(ttl_seconds=0).list_paths()
        self.source.broken = False
        forced: CachedContent = self.second_reader(ttl_seconds=0)
        forced.refresh()
        forced.list_paths()
        self.assertEqual(self.source.listings, 3)

    def test_a_source_that_cannot_be_listed_with_no_cache_still_fails(self):
        """Reporting no files would make a build report every include as missing and
        say nothing about the cause."""
        self.source.broken = True
        with self.assertRaises(OSError):
            self.cached.list_paths()

    def test_an_unreadable_listing_file_is_a_cold_cache(self):
        """A half-written file from an interrupted build must not stop the next one."""
        (self.cache / CachedContent.LISTING_NAME).write_text("{not json", encoding="utf-8")
        self.assertEqual(sorted(self.cached.list_paths()), sorted(self.source.files.keys()))

    # --- refreshing --------------------------------------------------------
    def test_a_refresh_reaches_past_the_cached_listing(self):
        """A forced fetch has to reach every layer; stopping at the disk cache would
        keep a file added upstream invisible until the time to live expired."""
        self.cached.list_paths()
        self.source.files["registries/added.hocon"] = b"{}"
        later: CachedContent = self.second_reader()
        later.refresh()
        self.assertIn("registries/added.hocon", later.list_paths())

    def test_a_refresh_asks_the_wrapped_source_to_forget_too(self):
        """The source memoizes its own listing, so a refresh that stopped here would
        be answered from that instead."""
        self.cached.list_paths()
        self.cached.refresh()
        self.assertEqual(self.source.refreshes, 1)

    def test_a_refresh_still_falls_back_when_the_source_cannot_be_reached(self):
        """Otherwise asking for fresh content would turn a cache that works offline
        into a failed build."""
        self.cached.list_paths()
        later: CachedContent = self.second_reader()
        later.refresh()
        self.source.broken = True
        self.assertIn("registries/aaosa.hocon", later.list_paths())

    # --- the files ---------------------------------------------------------
    def test_a_file_is_read_from_the_source_once_across_readers(self):
        """The second reader finds it on disk, which is what keeps a repeat build off
        the network."""
        self.assertEqual(self.cached.read("registries/aaosa.hocon"), b"{}")
        self.assertEqual(self.second_reader().read("registries/aaosa.hocon"), b"{}")
        self.assertEqual(self.source.reads, ["registries/aaosa.hocon"])

    def test_a_cached_file_keeps_its_bytes_exactly(self):
        """Content is bytes, and a studio that grows an image must round-trip."""
        raw: bytes = bytes(range(256))
        self.source.files["assets/logo.png"] = raw
        self.cached.read("assets/logo.png")
        self.assertEqual(self.second_reader().read("assets/logo.png"), raw)

    def test_a_file_the_source_does_not_have_is_not_remembered(self):
        """Remembering an absence would keep a file added upstream missing for every
        build that has the cache."""
        self.assertIsNone(self.cached.read("registries/absent.hocon"))
        self.source.files["registries/absent.hocon"] = b"{}"
        self.assertEqual(self.second_reader().read("registries/absent.hocon"), b"{}")

    def test_a_file_that_cannot_be_cached_is_still_returned(self):
        """The cache is an optimization; a source that answered must not fail a build."""
        (self.cache / CachedContent.FILES_DIR).write_text("not a directory", encoding="utf-8")
        self.assertEqual(self.cached.read("registries/aaosa.hocon"), b"{}")

    def test_a_cached_file_that_cannot_be_read_is_a_miss(self):
        """An unreadable cache entry must not fail a read the source can answer."""
        self.cached.read("registries/aaosa.hocon")
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError("unreadable")):
            self.assertEqual(self.second_reader().read("registries/aaosa.hocon"), b"{}")
        self.assertEqual(self.source.reads, ["registries/aaosa.hocon", "registries/aaosa.hocon"])

    def test_a_file_replaced_by_a_directory_upstream_is_still_cached(self):
        """Files are kept indefinitely, so a path that changes shape between revisions
        must not break every later build."""
        self.source.files["assets"] = b"file"
        self.cached.read("assets")
        self.source.files = {"assets/logo.png": b"png"}
        self.assertEqual(self.second_reader().read("assets/logo.png"), b"png")
        self.assertEqual(self.second_reader().read("assets/logo.png"), b"png")
        self.assertEqual(self.source.reads, ["assets", "assets/logo.png"])

    def test_a_path_leaving_the_cache_is_answered_but_not_written(self):
        """A path reaches this source from a network's own include lines, so it is
        input: it must not be able to write outside the directory it was given."""
        outside: Path = self.base / "escaped.bin"
        self.source.files["../../escaped.bin"] = b"{}"
        self.assertEqual(self.cached.read("../../escaped.bin"), b"{}")
        self.assertFalse(outside.exists())

    def test_the_cached_files_are_kept_apart_from_the_bookkeeping(self):
        """An upstream file named like the cache's own listing would otherwise answer
        as the file list, or be answered by it."""
        self.source.files[CachedContent.LISTING_NAME] = b"upstream"
        self.cached.list_paths()
        self.assertEqual(self.second_reader().read(CachedContent.LISTING_NAME), b"upstream")
        listing: Dict = json.loads((self.cache / CachedContent.LISTING_NAME).read_text(encoding="utf-8"))
        self.assertEqual(listing.get("identity"), "fake:studio")


if __name__ == "__main__":
    unittest.main()
