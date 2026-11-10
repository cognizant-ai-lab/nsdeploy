"""
Studio source: where nsdeploy gets the files it needs (HOCON includes like
`aaosa.hocon`, `toolbox_info.hocon`, and coded-tool `.py` sources).

The end user should NOT have to clone neuro-san-studio. By default nsdeploy pulls just
those files from the public GitHub repo on demand and mirrors them into a local cache
that the rest of the pipeline treats exactly like a local studio checkout (pyhocon
include base + `coded_tools` import path). A local checkout can still be used via
`LocalStudio` for offline/dev use.

Files are located by **suffix-matching the repo's git tree**, so it works regardless
of the repo's internal layout (e.g. files under a `neuro_san_studio/` package dir):
a logical path like `toolbox/toolbox_info.hocon` resolves to whatever tree entry ends
with it, and is cached at the logical path locally.
"""
from __future__ import annotations

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

RAW_URL = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
TREE_URL = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
DEFAULT_REPO = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF = "main"

# A diagnostic channel, not the build report. nsdeploy prints its report to
# stdout, but this module also runs in process inside the deployment service,
# where a print would land in the middle of that service's own output.
LOGGER = logging.getLogger(__name__)
# The recursive tree listing is one API call per process, and a deployment service
# runs one process per build. Unauthenticated api.github.com allows 60 calls an
# hour per IP, so a busy service stops being able to resolve includes at all —
# the failure is a hard RuntimeError, not a slow build. The listing is cached on
# disk beside the blobs it indexes, so every later build in the TTL reads a file.
TREE_CACHE_NAME = ".git-tree.json"
TREE_CACHE_TTL_SECONDS = 900
# A token raises the limit from 60 to 5000 calls an hour. Read from the standard
# names so an existing CI or container secret is picked up without new config.
TOKEN_ENV_NAMES = ("NSDEPLOY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")


def _github_token() -> str:
    """The GitHub token to authenticate tree listings with, if one is set."""
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
    """Abstract source of studio files, materialized under a local `root`."""

    @property
    def root(self) -> Path:
        """
        Return the local directory that holds the materialized studio files.

        :return: The local root directory.
        :raises NotImplementedError: Always; subclasses provide the root.
        """
        raise NotImplementedError

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
        """Make `coded_tools/<module_file>` importable under root (with a package
        __init__). Returns True if available."""
        raise NotImplementedError


class LocalStudio(StudioSource):
    """
    Studio source backed by an existing local studio checkout.
    """

    def __init__(self, path: str | Path):
        self._root = Path(path).resolve()

    @property
    def root(self) -> Path:
        return self._root

    def ensure(self, rel_path: str) -> Optional[Path]:
        p = self._root / rel_path
        return p if p.is_file() else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        return (self._root / "coded_tools" / module_file).is_file()


class GithubStudio(StudioSource):
    """
    Studio source that downloads files on demand from a GitHub repository into a local cache.
    """

    def __init__(self, repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None):
        self.repo = repo
        self.ref = ref
        safe = repo.replace("/", "_")
        self._root = Path(cache_dir) if cache_dir else (Path.home() / ".cache" / "nsdeploy" / f"{safe}@{ref}")
        self._root.mkdir(parents=True, exist_ok=True)
        self._tree: Optional[List[str]] = None

    @property
    def root(self) -> Path:
        return self._root

    def _tree_cache_path(self) -> Path:
        """Where this repo+ref's tree listing is cached between processes."""
        return self._root / TREE_CACHE_NAME

    def _cached_tree(self) -> Optional[List[str]]:
        """The tree listing from disk, or None when it is absent or stale."""
        path = self._tree_cache_path()
        try:
            age = time.time() - path.stat().st_mtime
            if age > TREE_CACHE_TTL_SECONDS:
                return None
            paths = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(paths, list):
            return None
        # Every entry, not just the outer list: _resolve_upstream calls endswith()
        # on each one, so a cache holding [null] or [{}] would raise AttributeError
        # instead of falling back to a fetch.
        for item in paths:
            if not isinstance(item, str):
                return None
        return paths

    def _store_tree(self, paths: List[str]) -> None:
        """Cache a tree listing for the next process. A failure is not fatal.

        The temporary name comes from mkstemp rather than the pid: a deployment
        service builds several bundles at once in worker threads of ONE process,
        so a pid-based name is shared, and one writer could replace the file while
        another still held it open — which is exactly what the atomic replace is
        meant to prevent.
        """
        tmp: Optional[Path] = None
        try:
            handle, raw = tempfile.mkstemp(prefix=f"{TREE_CACHE_NAME}.", dir=self._root)
            tmp = Path(raw)
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(paths))
            # Replaced atomically: several builds race here, and a half-written
            # listing would be read as a corrupt cache by all of them.
            tmp.replace(self._tree_cache_path())
        except OSError as exc:
            # Non-fatal: this build already has the listing it just fetched. It is
            # reported because the consequence is otherwise invisible — a cache
            # directory that has turned unwritable, or a full disk, makes every
            # later build spend another api.github.com call until the hourly
            # allowance is gone, with nothing anywhere saying why.
            LOGGER.warning("cannot cache the git tree for %s@%s at %s: %s",
                           self.repo, self.ref, self._tree_cache_path(), exc)
            if tmp is not None:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError as cleanup:
                    LOGGER.warning("cannot remove the temporary cache file %s: %s",
                                   tmp, cleanup)

    def _load_tree(self) -> List[str]:
        if self._tree is None:
            self._tree = self._cached_tree()
        if self._tree is None:
            data = _http_get(TREE_URL.format(repo=self.repo, ref=self.ref))
            if data is None:
                raise RuntimeError(f"cannot read git tree for {self.repo}@{self.ref}")
            self._tree = [t["path"] for t in json.loads(data).get("tree", []) if t.get("type") == "blob"]
            self._store_tree(self._tree)
        return self._tree

    def _resolve_upstream(self, rel_path: str) -> Optional[str]:
        """Find the actual repo path for a logical rel_path via exact-or-suffix match."""
        tree = self._load_tree()
        if rel_path in tree:
            return rel_path
        cands = [p for p in tree if p.endswith("/" + rel_path)]
        if not cands:  # fall back to basename match (e.g. coded tool module file)
            base = rel_path.split("/")[-1]
            cands = [p for p in tree if p.endswith("/" + base) or p == base]
        if not cands:
            return None
        return min(cands, key=len)  # shortest path = least-nested / most canonical

    def ensure(self, rel_path: str) -> Optional[Path]:
        dest = self._root / rel_path
        if dest.is_file():
            return dest
        upstream = self._resolve_upstream(rel_path)
        if not upstream:
            return None
        raw = _http_get(RAW_URL.format(repo=self.repo, ref=self.ref, path=upstream))
        if raw is None:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(raw, encoding="utf-8")
        return dest

    def ensure_coded_tool(self, module_file: str) -> bool:
        # Make `coded_tools` a package in the cache, then fetch the module file.
        pkg_init = self._root / "coded_tools" / "__init__.py"
        if not pkg_init.exists():
            pkg_init.parent.mkdir(parents=True, exist_ok=True)
            pkg_init.write_text("", encoding="utf-8")
        return self.ensure(f"coded_tools/{module_file}") is not None
