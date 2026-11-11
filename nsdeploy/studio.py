"""
Studio source: where nsdeploy gets the files it needs (HOCON includes like
`aaosa.hocon`, `toolbox_info.hocon`, and coded-tool `.py` sources).

The end user should NOT have to clone neuro-san-studio. By default nsdeploy pulls just
those files from the public GitHub repo on demand and mirrors them into a local cache
that the rest of the pipeline treats exactly like a local studio checkout (pyhocon
include base + `coded_tools` import path). A local checkout can still be used via
`LocalStudio` for offline/dev use; it is mirrored the same way.

Files are located by **suffix-matching the repo's file list**, so it works regardless
of the repo's internal layout (e.g. files under a `neuro_san_studio/` package dir):
a logical path like `toolbox/toolbox_info.hocon` resolves to whatever entry ends
with it, and is cached at the logical path locally.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import List
from typing import Optional

from typing_extensions import override

RAW_URL = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
TREE_URL = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
DEFAULT_REPO = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF = "main"
# Directories of a local checkout that hold no studio sources.
SKIPPED_CHECKOUT_DIRS = ("venv", "node_modules", "__pycache__")

# A diagnostic channel, not the build report. nsdeploy prints its report to
# stdout, but this module also runs in process inside the deployment service,
# where a print would land in the middle of that service's own output.
LOGGER = logging.getLogger(__name__)
# `_list_files` is one GitHub API call, and a deployment service runs one process
# per build. Unauthenticated api.github.com allows 60 calls an hour per IP, so a
# busy service stops being able to resolve includes at all — the failure is a hard
# RuntimeError, not a slow build. The file list is cached beside the files it
# indexes, so every later build within the TTL reads it from there.
FILE_LIST_CACHE_NAME = ".file-list.json"
FILE_LIST_CACHE_TTL_SECONDS = 900
# A token raises the limit from 60 to 5000 calls an hour. Read from the standard
# names so an existing CI or container secret is picked up without new config.
TOKEN_ENV_NAMES = ("NSDEPLOY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")


def _github_token() -> str:
    """The GitHub token to authenticate a file-list request with, if one is set."""
    # First name that holds a value wins, so a deployment can override the
    # ambient CI token without unsetting it.
    for name in TOKEN_ENV_NAMES:
        value: str = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _http_get(url: str) -> Optional[str]:
    headers = {"User-Agent": "nsdeploy", "Accept": "*/*"}
    token = _github_token()
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


class StudioSource:
    """
    Abstract source of studio files. Subclasses list and read the upstream files; this
    class mirrors the ones a build asks for into a local `root` at their logical paths.
    """

    def __init__(self, cache_dir: Path):
        """
        Create the mirror directory.

        :param cache_dir: The local directory that the requested files are mirrored into
        """
        self._root: Path = Path(cache_dir)
        self._root.mkdir(parents=True, exist_ok=True)
        self._files: Optional[List[str]] = None

    @property
    def root(self) -> Path:
        """
        Return the local directory that holds the materialized studio files.

        :return: The local root directory.
        """
        return self._root

    def ensure(self, rel_path: str) -> Optional[Path]:
        """Make `rel_path` available under root; return its local path or None."""
        raise NotImplementedError

    def read(self, rel_path: str) -> Optional[str]:
        """
        Read a studio file as UTF-8 text.

        :param rel_path: The file path relative to the studio root.
        :return: The file contents, or None when the file is unavailable.
        """
        path = self.ensure(rel_path)
        return path.read_text(encoding="utf-8") if path else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        """
        Make `coded_tools/<module_file>` importable under root, with a package `__init__.py`.

        :param module_file: The file name of the coded-tool module, such as `web_fetch.py`
        :return: True when the module is available under root
        """
        pkg_init: Path = self._root / "coded_tools" / "__init__.py"
        if not pkg_init.exists():
            pkg_init.parent.mkdir(parents=True, exist_ok=True)
            pkg_init.write_text("", encoding="utf-8")
        return self.ensure(f"coded_tools/{module_file}") is not None

    def _list_files(self) -> List[str]:
        """
        List the upstream files, as `/`-separated paths relative to the upstream root.

        :return: The file paths
        :raises NotImplementedError: Always; subclasses list their own files.
        """
        raise NotImplementedError

    # pylint: disable-next=unused-argument  # the no-op ignores it; GithubStudio does not
    def warm_files(self, force: bool = False) -> bool:
        """
        Make the file list available before any build asks for a path.

        Nothing to do for a source that walks a local checkout; GithubStudio
        overrides it. A caller can therefore warm a source without knowing which
        kind it holds.

        :param force: Refresh even when a cached list is still within its TTL.
        :return: True when the source is ready to resolve paths.
        """
        return True

    def _read_upstream(self, upstream: str) -> Optional[str]:
        """
        Read one upstream file as UTF-8 text.

        :param upstream: The file path, as returned by `_list_files()`
        :return: The file contents, or None when the file does not exist
        :raises NotImplementedError: Always; subclasses read their own files.
        """
        raise NotImplementedError

    def _resolve_upstream(self, rel_path: str) -> Optional[str]:
        """
        Find the upstream path for a logical path: an exact match, else the shortest
        path that ends with it, else the shortest path with the same file name.

        :param rel_path: The logical path, such as `toolbox/toolbox_info.hocon`
        :return: The upstream path, or None when nothing matches
        """
        if self._files is None:
            self._files = self._list_files()
        if rel_path in self._files:
            return rel_path
        base: str = rel_path.split("/")[-1]
        suffix_matches: List[str] = []
        name_matches: List[str] = []
        # Collect the paths that end with the logical path or with its file name.
        for path in self._files:  # type: str
            if path.endswith("/" + rel_path):
                suffix_matches.append(path)
            if path.endswith("/" + base) or path == base:
                name_matches.append(path)
        candidates: List[str] = suffix_matches or name_matches
        if not candidates:
            return None
        # The shortest path is the least nested, and so the most canonical.
        return min(candidates, key=len)

    def _mirror(self, rel_path: str) -> Optional[Path]:
        """
        Copy the upstream file for `rel_path` to `root/rel_path`.

        :param rel_path: The logical path relative to root
        :return: The local path, or None when there is no such upstream file or the
            path leaves root
        """
        dest: Path = self._root / rel_path
        if not dest.resolve().is_relative_to(self._root.resolve()):
            return None
        upstream: Optional[str] = self._resolve_upstream(rel_path)
        if not upstream:
            return None
        text: Optional[str] = self._read_upstream(upstream)
        if text is None:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Concurrent builds share the mirror, so a reader must never see a partly written file,
        # and each writer needs its own temporary file.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=dest.parent, prefix=f".{dest.name}.",
                                         suffix=".tmp", delete=False) as partial:
            partial_path: Path = Path(partial.name)
            try:
                partial.write(text)
            except OSError:
                partial.close()
                partial_path.unlink(missing_ok=True)
                raise
        try:
            os.replace(partial_path, dest)
        except OSError:
            partial_path.unlink(missing_ok=True)
            raise
        return dest

    def _drop_mirror(self, rel_path: str) -> None:
        """
        Remove the mirrored copy of `rel_path`, so that pyhocon cannot read a file the upstream no longer has.

        :param rel_path: The logical path relative to root
        """
        dest: Path = self._root / rel_path
        if dest.resolve().is_relative_to(self._root.resolve()):
            dest.unlink(missing_ok=True)


class LocalStudio(StudioSource):
    """
    Studio source backed by an existing local studio checkout. Requested files are
    copied into a cache on every request, so edits to the checkout apply to the next build.
    """

    def __init__(self, path: str | Path, cache_dir: Optional[Path] = None):
        """
        Use the checkout at `path`.

        :param path: The local neuro-san-studio checkout
        :param cache_dir: The mirror directory; defaults to one per checkout under `~/.cache/nsdeploy`
        """
        self._checkout: Path = Path(path).resolve()
        digest: str = hashlib.sha256(str(self._checkout).encode("utf-8")).hexdigest()[:12]
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"local_{self._checkout.name}_{digest}"
        super().__init__(Path(cache_dir) if cache_dir else default_cache)

    @override
    def ensure(self, rel_path: str) -> Optional[Path]:
        """
        Copy the checkout's file for `rel_path` into root.

        :param rel_path: The logical path relative to root
        :return: The local path, or None when the checkout has no such file
        """
        path: Optional[Path] = self._mirror(rel_path)
        if path is None:
            self._drop_mirror(rel_path)
        return path

    @override
    def _list_files(self) -> List[str]:
        """
        List the checkout's files, without hidden directories or `SKIPPED_CHECKOUT_DIRS`.

        :return: The file paths relative to the checkout
        """
        files: List[str] = []
        # Walk the checkout, pruning directories that hold no studio sources.
        for directory, dir_names, file_names in os.walk(self._checkout):  # type: str, List[str], List[str]
            kept: List[str] = []
            # Keep only the subdirectories that can hold studio sources.
            for dir_name in dir_names:  # type: str
                if not dir_name.startswith(".") and dir_name not in SKIPPED_CHECKOUT_DIRS:
                    kept.append(dir_name)
            dir_names[:] = kept
            relative: Path = Path(directory).relative_to(self._checkout)
            # Record each file by its path relative to the checkout.
            for file_name in file_names:  # type: str
                files.append((relative / file_name).as_posix())
        return files

    @override
    def _read_upstream(self, upstream: str) -> Optional[str]:
        """
        Read one file of the checkout.

        :param upstream: The file path relative to the checkout
        :return: The file contents, or None when the file does not exist
        """
        path: Path = self._checkout / upstream
        return path.read_text(encoding="utf-8") if path.is_file() else None


class GithubStudio(StudioSource):
    """
    Studio source that downloads files on demand from a GitHub repository into a local cache.
    """

    def __init__(self, repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None):
        self.repo = repo
        self.ref = ref
        safe = repo.replace("/", "_")
        super().__init__(Path(cache_dir) if cache_dir else (Path.home() / ".cache" / "nsdeploy" / f"{safe}@{ref}"))

    def _file_list_cache_path(self) -> Path:
        """
        Where this repo+ref's file list is cached between processes.

        :return: The cache file's path.
        """
        return self._root / FILE_LIST_CACHE_NAME

    def _cached_file_list(self) -> Optional[List[str]]:
        """
        The file list from disk, when one is there and still fresh.

        :return: The file paths, or None when the cache is absent, stale or unusable.
        """
        path: Path = self._file_list_cache_path()
        paths: object = None
        try:
            age: float = time.time() - path.stat().st_mtime
            if age > FILE_LIST_CACHE_TTL_SECONDS:
                return None
            paths = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(paths, list):
            return None
        # Every entry, not just the outer list: _resolve_upstream calls endswith() on
        # each one, so a cache holding [null] or [{}] would raise AttributeError
        # instead of falling back to a fetch.
        for item in paths:
            if not isinstance(item, str):
                return None
        return paths

    def _store_file_list(self, paths: List[str]) -> None:
        """
        Cache the file list for the next process. A failure is not fatal.

        Each write takes its own temporary name: a deployment service builds several
        bundles at once in worker threads of ONE process, so a shared name would let
        one writer replace the file while another still held it open — which is what
        the atomic replace exists to prevent.

        :param paths: The file paths to cache.
        """
        tmp: Optional[Path] = None
        try:
            handle, raw = tempfile.mkstemp(prefix=f"{FILE_LIST_CACHE_NAME}.", dir=self._root)
            tmp = Path(raw)
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(paths))
            os.replace(tmp, self._file_list_cache_path())
        except OSError as exc:
            # Non-fatal: this build already has the list it just fetched. It is
            # reported because the consequence is otherwise invisible — a cache
            # directory that has turned unwritable, or a full disk, makes every later
            # build spend another api.github.com call until the hourly allowance is
            # gone, with nothing anywhere saying why.
            LOGGER.warning("cannot cache the file list for %s@%s at %s: %s",
                           self.repo, self.ref, self._file_list_cache_path(), exc)
            if tmp is not None:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError as cleanup:
                    LOGGER.warning("cannot remove the temporary cache file %s: %s",
                                   tmp, cleanup)

    @override
    def warm_files(self, force: bool = False) -> bool:
        """
        Fetch the file list now, so later builds do not each fetch it.

        A deployment is a separate process, so the only thing concurrent builds can
        share is the cached list — and a burst that starts cold has every process
        miss it before any has written it, costing one api.github.com call each.
        Unauthenticated that allowance is 60 an hour per IP, so a large enough first
        burst exhausts it and later builds fail to resolve their includes at all.
        Warming once, before any build, makes that one call for all of them.

        A `force` refresh ignores the TTL. A site process receives no GitHub
        credential (see nsdeploy_service/site_env.py), so a child that finds the
        cached list expired fetches it anonymously and can meet the 60-an-hour
        limit even where the service holds a token. Refreshing on a schedule
        shorter than the TTL keeps the list a child reads from ever being expired,
        and keeps every authenticated fetch in the service.

        Best effort. A source that cannot be warmed is not broken: the next build
        that needs a path it has not mirrored fetches the list itself.

        :param force: Refresh even when a cached list is still within its TTL.
        :return: True when a file list is available, False when it could not be read.
        """
        try:
            if force:
                self._files = self._fetch_file_list()
            elif self._files is None:
                self._files = self._list_files()
        except (OSError, RuntimeError, ValueError) as exc:
            LOGGER.warning("cannot warm the file list for %s@%s: %s",
                           self.repo, self.ref, exc)
            return False
        return True

    @override
    def ensure(self, rel_path: str) -> Optional[Path]:
        """
        Return the cached file for `rel_path`, downloading it first if it is not cached.

        :param rel_path: The logical path relative to root
        :return: The local path, or None when the repository has no such file
        """
        dest: Path = self._root / rel_path
        if dest.is_file():
            return dest
        return self._mirror(rel_path)

    @override
    def _list_files(self) -> List[str]:
        """
        List the repository's files with one GitHub API call.

        :return: The file paths relative to the repository root
        :raises RuntimeError: When the repository tree cannot be read
        """
        cached: Optional[List[str]] = self._cached_file_list()
        if cached is not None:
            return cached
        return self._fetch_file_list()

    def _fetch_file_list(self) -> List[str]:
        """
        Read the file list from the API and cache it, ignoring any cached copy.

        :return: The file paths relative to the repository root
        :raises RuntimeError: When the repository tree cannot be read
        """
        data: Optional[str] = _http_get(TREE_URL.format(repo=self.repo, ref=self.ref))
        if data is None:
            raise RuntimeError(f"cannot read git tree for {self.repo}@{self.ref}")
        files: List[str] = []
        # Keep the files; the tree also lists directories. "tree" and "blob" are
        # GitHub's own names for a directory entry and a file entry.
        for entry in json.loads(data).get("tree", []):  # type: dict
            if entry.get("type") == "blob":
                files.append(entry.get("path"))
        self._store_file_list(files)
        return files

    @override
    def _read_upstream(self, upstream: str) -> Optional[str]:
        """
        Download one file of the repository.

        :param upstream: The file path relative to the repository root
        :return: The file contents, or None when the file does not exist
        """
        return _http_get(RAW_URL.format(repo=self.repo, ref=self.ref, path=upstream))
