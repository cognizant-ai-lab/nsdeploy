import json
import unittest
import urllib.error
import urllib.request
from typing import Dict
from typing import List
from typing import Optional
from unittest import mock

import nsdeploy.studio_content.github_content as github_module
from nsdeploy.studio_content.github_content import GithubContent

REPO = "cognizant-ai-lab/neuro-san-studio"
TREE_SHA = "c0ffee" + "0" * 34
TOKEN = "ghp_not_a_real_token"


class _Response:
    """The slice of an HTTP response the source reads: a body, in a with-block."""

    def __init__(self, body: bytes) -> None:
        """
        :param body: The bytes to answer with.
        """
        self._body: bytes = body

    def __enter__(self) -> "_Response":
        """
        :return: This response.
        """
        return self

    def __exit__(self, *_unused) -> bool:
        """
        :return: False, so nothing is suppressed.
        """
        return False

    def read(self) -> bytes:
        """
        :return: The body.
        """
        return self._body


class TestGithubContent(unittest.TestCase):
    """A studio read from a GitHub repository.

    No test here reaches the network. `urlopen` is replaced, so what is pinned is the
    contract: which URL is asked for, which header goes with it, how a listing is
    turned into paths, and which failures are an absent file rather than a fault.
    """

    def setUp(self) -> None:
        """
        Answer from a prepared table of URLs, with the real request still built.

        `urlopen` is what is replaced, not the source's own `_get`: the headers these
        tests assert on are the ones the code actually put on the request, so a change
        to how a credential is attached is caught here rather than mirrored.
        """
        self.requests: List[urllib.request.Request] = []
        self.answers: Dict[str, bytes] = {}
        self.status: Dict[str, int] = {}
        patcher = mock.patch.object(github_module.urllib.request, "urlopen",
                                    side_effect=self._open)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.content: GithubContent = GithubContent(REPO, "main")

    # pylint: disable-next=unused-argument  # urlopen's signature, not this double's
    def _open(self, request: urllib.request.Request, timeout: float = 0.0) -> "_Response":
        """
        Stand in for one HTTP GET, recording the request the source built.

        :param request: The request the source assembled.
        :param timeout: Ignored; nothing here blocks.
        :return: A context manager over the prepared body.
        :raises urllib.error.HTTPError: For a URL the table gives a failing status.
        """
        self.requests.append(request)
        url: str = request.full_url
        code: int = self.status.get(url, 200)
        if code != 200:
            raise urllib.error.HTTPError(url, code, "prepared", None, None)
        return _Response(self.answers.get(url, b""))

    @property
    def requested(self) -> List[str]:
        """
        The URLs asked for, in order.

        :return: The URLs.
        """
        urls: List[str] = []
        # One entry per recorded request, so a test can assert on order.
        for request in self.requests:
            urls.append(request.full_url)
        return urls

    def header_for(self, url: str, name: str) -> Optional[str]:
        """
        The header the source put on its own request for a URL.

        :param url: The URL asked for.
        :param name: The header name.
        :return: The header value, or None when it was not sent.
        """
        # The last request for that URL is the one a test has just caused.
        for request in reversed(self.requests):
            if request.full_url == url:
                return request.get_header(name.capitalize())
        return None

    @staticmethod
    def _tree(paths: List[str], sha: str = TREE_SHA) -> bytes:
        """
        Render a git trees response.

        :param paths: The file paths it should list.
        :param sha: The tree sha to report.
        :return: The JSON body.
        """
        entries: List[Dict[str, str]] = []
        # GitHub's own names: a "blob" entry per file, a "tree" entry per directory.
        for path in paths:
            entries.append({"path": path, "type": "blob"})
        entries.append({"path": "registries", "type": "tree"})
        return json.dumps({"sha": sha, "tree": entries}).encode("utf-8")

    def _serve_tree(self, paths: List[str], sha: str = TREE_SHA) -> str:
        """
        Prepare the listing this source will ask for.

        :param paths: The file paths it should list.
        :param sha: The tree sha to report.
        :return: The listing URL.
        """
        url: str = GithubContent.TREE_URL.format(repo=REPO, ref="main")
        self.answers[url] = self._tree(paths, sha)
        return url

    def _raw_url(self, path: str) -> str:
        """
        The URL this source reads one file from.

        :param path: The file path.
        :return: The raw URL.
        """
        return GithubContent.RAW_URL.format(repo=REPO, ref="main", path=path)

    # --- identity ----------------------------------------------------------
    def test_the_identity_names_the_repository_and_ref(self):
        """The identity names the repository and the ref."""
        self.assertEqual(self.content.identity(), f"github:{REPO}@main")

    def test_the_identity_carries_no_token(self):
        """It reaches build logs and the warnings a reader sees."""
        secret: str = "ghp_not_a_real_token"
        named: GithubContent = GithubContent(REPO, "main", token=secret)
        self.assertNotIn(secret, named.identity())

    # --- listing -----------------------------------------------------------
    def test_the_listing_keeps_files_and_drops_directories(self):
        """The listing keeps files and drops directories."""
        self._serve_tree(["registries/aaosa.hocon", "coded_tools/web_fetch.py"])
        self.assertEqual(self.content.list_paths(),
                         ["registries/aaosa.hocon", "coded_tools/web_fetch.py"])

    def test_the_listing_is_fetched_once_per_source(self):
        """It is the rate-limited call, so asking twice must not cost twice."""
        self._serve_tree(["registries/aaosa.hocon"])
        self.content.list_paths()
        self.content.list_paths()
        self.assertEqual(len(self.requested), 1)

    def test_the_listing_is_asked_for_with_one_recursive_request(self):
        """Walking the tree a directory at a time would cost a request per directory,
        which is the allowance this source has least of."""
        url: str = self._serve_tree(["registries/aaosa.hocon"])
        self.content.list_paths()
        self.assertEqual(self.requested, [url])
        self.assertIn("recursive=1", url)

    def test_a_repository_or_ref_that_is_not_there_is_an_error(self):
        """A 404 on the listing is a repository or ref that does not exist, which is a
        different thing from a studio that lacks one file."""
        url: str = GithubContent.TREE_URL.format(repo=REPO, ref="main")
        self.status[url] = 404
        with self.assertRaises(FileNotFoundError) as caught:
            self.content.list_paths()
        self.assertIn(REPO, str(caught.exception))

    def test_being_rate_limited_is_raised_rather_than_read_as_an_empty_studio(self):
        """Reporting no files would make a build report every include as missing and
        say nothing about the cause."""
        url: str = GithubContent.TREE_URL.format(repo=REPO, ref="main")
        self.status[url] = 403
        with self.assertRaises(urllib.error.HTTPError):
            self.content.list_paths()

    # --- revision ----------------------------------------------------------
    def test_the_revision_is_the_sha_of_the_tree_that_was_listed(self):
        """The revision is the sha of the tree that was listed."""
        self._serve_tree(["registries/aaosa.hocon"])
        self.assertEqual(self.content.revision(), TREE_SHA)

    def test_the_revision_does_not_depend_on_what_was_asked_first(self):
        """Asking for the revision before the listing loads it, so a caller's order of
        questions cannot change the answer — and both still cost one request."""
        self._serve_tree(["registries/aaosa.hocon"])
        self.assertEqual(self.content.revision(), TREE_SHA)
        self.assertEqual(self.content.list_paths(), ["registries/aaosa.hocon"])
        self.assertEqual(len(self.requested), 1)

    def test_a_listing_without_a_sha_reports_no_revision(self):
        """An empty revision is the contract's answer for "cannot tell"."""
        self._serve_tree(["registries/aaosa.hocon"], sha="")
        self.assertEqual(self.content.revision(), "")

    # --- reading -----------------------------------------------------------
    def test_a_file_is_read_from_the_raw_host(self):
        """Not from the API: raw.githubusercontent.com is not part of the hourly
        allowance, which is why reading files is cheap and listing them is not."""
        url: str = self._raw_url("registries/aaosa.hocon")
        self.answers[url] = b"{}"
        self.assertEqual(self.content.read("registries/aaosa.hocon"), b"{}")
        self.assertEqual(self.requested, [url])

    def test_reading_a_file_does_not_need_the_listing(self):
        """A workspace that already knows the path should not pay for a listing."""
        url: str = self._raw_url("coded_tools/web_fetch.py")
        self.answers[url] = b"VALUE = 1\n"
        self.content.read("coded_tools/web_fetch.py")
        self.assertNotIn(GithubContent.TREE_URL.format(repo=REPO, ref="main"), self.requested)

    def test_a_file_the_repository_does_not_have_reads_as_none(self):
        """A file the repository does not have reads as None."""
        url: str = self._raw_url("registries/absent.hocon")
        self.status[url] = 404
        self.assertIsNone(self.content.read("registries/absent.hocon"))

    def test_a_failure_other_than_absence_is_raised(self):
        """A failure other than absence is raised."""
        url: str = self._raw_url("registries/aaosa.hocon")
        self.status[url] = 500
        with self.assertRaises(urllib.error.HTTPError):
            self.content.read("registries/aaosa.hocon")

    # --- credentials -------------------------------------------------------
    def test_no_token_is_sent_when_none_was_given(self):
        """A studio is read in processes that run uploaded code, so a source helps
        itself to no credential: the token is a constructor argument."""
        url: str = self._serve_tree(["registries/aaosa.hocon"])
        self.content.list_paths()
        self.assertIsNone(self.header_for(url, "Authorization"))

    def test_a_token_is_sent_to_both_github_hosts(self):
        """A private studio refuses the listing without it, and every file too."""
        named: GithubContent = GithubContent(REPO, "main", token=TOKEN)
        tree: str = self._serve_tree(["registries/aaosa.hocon"])
        raw: str = self._raw_url("registries/aaosa.hocon")
        self.answers[raw] = b"{}"
        named.list_paths()
        named.read("registries/aaosa.hocon")
        # Both hosts, so a private studio can be listed and then read.
        for url in (tree, raw):
            with self.subTest(url=url):
                self.assertEqual(self.header_for(url, "Authorization"), f"Bearer {TOKEN}")

    def test_no_token_is_sent_anywhere_else(self):
        """A ref or a path cannot be made to point the credential at another host."""
        named: GithubContent = GithubContent(REPO, "main", token=TOKEN)
        elsewhere: str = "https://evil.example.com/registries/aaosa.hocon"
        self.answers[elsewhere] = b"{}"
        # Through the source's own fetch, so the rule under test is the one the code
        # applies rather than one restated here.
        named._get(elsewhere)  # pylint: disable=protected-access
        self.assertIsNone(self.header_for(elsewhere, "Authorization"))


if __name__ == "__main__":
    unittest.main()
