import json
import urllib.error
import urllib.request
from typing import Dict
from typing import List
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent


class GithubContent(ToolboxContent):
    """A neuro-san-studio read from a GitHub repository at one ref.

    Two endpoints, each doing one job. The listing comes from the git trees API,
    which costs one request and is rate limited; a file comes from
    raw.githubusercontent.com, which is not part of that allowance. Keeping them
    distinct is why `list_paths` is the expensive call and `read` is not.

    **No caching here, on purpose.** A disk cache shared between processes, a
    refresh before it expires, and the warm-up that keeps a burst of builds from
    each paying for its own listing are all real requirements — and all of them are
    about coordinating several readers, which one adapter cannot see. They belong to
    a caching `ToolboxContent` wrapped around this one, or to the workspace. What is
    here is the memoized listing for this object's own lifetime, which costs nothing
    and surprises nobody.

    **No credential is read from the environment, on purpose.** The token is a
    constructor argument so that whoever holds it decides who gets one. A studio is
    also read inside processes that run uploaded code, and a source that helped
    itself to `GITHUB_TOKEN` would hand that credential to every one of them.
    """

    TREE_URL: str = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
    RAW_URL: str = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
    # Both are GitHub, and a private studio needs the token on each: the listing is
    # refused without it, and so is every file.
    AUTHENTICATED_HOSTS: tuple = ("https://api.github.com/", "https://raw.githubusercontent.com/")
    TIMEOUT_SECONDS: float = 30.0

    def __init__(self, repo: str, ref: str = "main", token: str = "") -> None:
        """
        Read the studio published by `repo` at `ref`.

        :param repo: The repository, as `owner/name`.
        :param ref: The branch, tag or commit to read.
        :param token: A GitHub token, or an empty string to read anonymously.
        """
        self._repo: str = repo
        self._ref: str = ref
        self._token: str = token
        self._paths: Optional[List[str]] = None
        self._revision: str = ""

    @override
    def identity(self) -> str:
        """
        Name this repository and ref for build output.

        The token is deliberately absent: this string reaches build logs and the
        warnings a reader sees.

        :return: The repository and ref.
        """
        return f"github:{self._repo}@{self._ref}"

    @override
    def revision(self) -> str:
        """
        Report the sha of the tree this listing came from.

        Reading it loads the listing if that has not happened yet, so the answer does
        not depend on the order a caller asks its questions. Both answers come from
        one request either way.

        :return: The tree sha, or an empty string when GitHub did not report one.
        :raises FileNotFoundError: If the repository or ref cannot be read.
        :raises OSError: If the listing cannot be fetched.
        """
        self._load()
        return self._revision

    @override
    def list_paths(self) -> List[str]:
        """
        Every file in the repository at this ref.

        :return: The file paths, relative to the repository root.
        :raises FileNotFoundError: If the repository or ref cannot be read.
        :raises OSError: If the listing cannot be fetched.
        """
        self._load()
        # _load leaves this set; the check is for the type checker, not for a case
        # that can happen.
        return self._paths if self._paths is not None else []

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        Download one file of the repository.

        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when the repository has no such file.
        :raises OSError: If the file exists but cannot be fetched.
        """
        url: str = GithubContent.RAW_URL.format(repo=self._repo, ref=self._ref, path=path)
        return self._get(url)

    def _load(self) -> None:
        """
        Fetch the listing and the tree sha, once per instance.

        :raises FileNotFoundError: If the repository or ref cannot be read.
        :raises OSError: If the listing cannot be fetched.
        """
        if self._paths is not None:
            return
        url: str = GithubContent.TREE_URL.format(repo=self._repo, ref=self._ref)
        body: Optional[bytes] = self._get(url)
        if body is None:
            # A 404 on the listing is a repository or ref that does not exist, which
            # is a different thing from a studio that lacks one file.
            raise FileNotFoundError(f"cannot read the file list for {self.identity()}")
        tree: Dict = json.loads(body.decode("utf-8"))
        found: List[str] = []
        # "tree" and "blob" are GitHub's own names for a directory entry and a file
        # entry; a studio's content is the files.
        for entry in tree.get("tree", []):
            if entry.get("type") == "blob":
                found.append(str(entry.get("path")))
        self._revision = str(tree.get("sha") or "")
        self._paths = found

    def _get(self, url: str) -> Optional[bytes]:
        """
        Fetch one URL, treating a missing resource as an answer rather than a fault.

        :param url: The URL to fetch.
        :return: The response body, or None when GitHub reports it is not there.
        :raises OSError: If the request fails for any other reason.
        """
        headers: Dict[str, str] = {"User-Agent": "nsdeploy", "Accept": "*/*"}
        if self._token and url.startswith(GithubContent.AUTHENTICATED_HOSTS):
            headers["Authorization"] = f"Bearer {self._token}"
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=GithubContent.TIMEOUT_SECONDS) as response:
                return response.read()
        except urllib.error.HTTPError as exception:
            if exception.code == 404:
                return None
            # Everything else — rate limited, unauthorized, server error — is a fault
            # the caller has to see, not an absent file.
            raise
