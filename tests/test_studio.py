import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from typing import List, Optional

import nsdeploy.studio as studio_module
from nsdeploy.studio import TREE_CACHE_NAME, TREE_CACHE_TTL_SECONDS, GithubStudio

TREE = ["coding/aaosa.hocon", "toolbox/toolbox_info.hocon"]

# The cache and the token are internals on purpose: nothing public exposes the
# tree listing, and these tests exist to pin exactly that behaviour.
# pylint: disable=protected-access


class TestGithubStudio(unittest.TestCase):
    """The git tree listing: cached between processes, and authenticated when a
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

    def tearDown(self) -> None:
        studio_module._http_get = self._http_get
        for name in ("NSDEPLOY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
            os.environ.pop(name, None)
        self._tmp.cleanup()

    def _serve_tree(self, payload: Optional[str]) -> None:
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
        Render a git tree response.

        :param paths: The blob paths it should list.
        :return: The JSON body.
        """
        entries = []
        # One blob entry per path, plus a tree entry the loader must ignore.
        for path in paths:
            entries.append({"path": path, "type": "blob"})
        entries.append({"path": "coding", "type": "tree"})
        return json.dumps({"tree": entries})

    def test_the_first_build_fetches_the_tree(self):
        """The first build fetches the tree."""
        self._serve_tree(self._payload(TREE))
        studio = GithubStudio(cache_dir=self.cache)
        self.assertEqual(studio._load_tree(), TREE)
        self.assertEqual(len(self.requested), 1)

    def test_a_later_process_reads_the_cache_instead_of_the_api(self):
        """This is the whole point: a second deployment must not spend a second API
        call, because the hourly allowance is what runs out first."""
        self._serve_tree(self._payload(TREE))
        GithubStudio(cache_dir=self.cache)._load_tree()
        self._serve_tree(self._payload(TREE))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._load_tree(), TREE)
        self.assertEqual(self.requested, [])

    def test_an_expired_cache_is_refetched(self):
        """The ref moves, so a cache that never expired would pin every later build
        to the tree as it was the first time anything deployed."""
        self._serve_tree(self._payload(TREE))
        GithubStudio(cache_dir=self.cache)._load_tree()
        stale = time.time() - TREE_CACHE_TTL_SECONDS - 60
        os.utime(self.cache / TREE_CACHE_NAME, (stale, stale))
        self._serve_tree(self._payload(TREE))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._load_tree(), TREE)
        self.assertEqual(len(self.requested), 1)

    def test_a_corrupt_cache_is_ignored_rather_than_raised(self):
        """Several builds write this file concurrently. A half-written one must cost
        an API call, not a failed deployment."""
        (self.cache / TREE_CACHE_NAME).write_text("{not json", encoding="utf-8")
        self._serve_tree(self._payload(TREE))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._load_tree(), TREE)
        self.assertEqual(len(self.requested), 1)

    def test_a_cache_holding_the_wrong_shape_is_ignored(self):
        """A cache holding the wrong shape is ignored."""
        (self.cache / TREE_CACHE_NAME).write_text('{"tree": []}', encoding="utf-8")
        self._serve_tree(self._payload(TREE))
        self.assertEqual(GithubStudio(cache_dir=self.cache)._load_tree(), TREE)
        self.assertEqual(len(self.requested), 1)

    def test_an_unreadable_tree_is_still_an_error(self):
        """An unreadable tree is still an error."""
        self._serve_tree(None)
        with self.assertRaises(RuntimeError) as caught:
            GithubStudio(cache_dir=self.cache)._load_tree()
        self.assertIn("cannot read git tree", str(caught.exception))

    def test_no_token_configured_reports_none(self):
        """No token configured reports none."""
        self.assertEqual(studio_module._github_token(), "")

    def test_each_token_name_is_honoured(self):
        """Each token name is honoured."""
        # Checked one at a time, so a deployment setting any of them is covered.
        for name in ("NSDEPLOY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"):
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
