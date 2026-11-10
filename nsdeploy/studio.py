"""
Studio source: where nsdeploy gets the files it needs (HOCON includes like
`aaosa.hocon`, `toolbox_info.hocon`, and coded-tool `.py` sources).

The end user should NOT have to clone neuro-san-studio. By default nsdeploy pulls just
those files from the public GitHub repo on demand and mirrors them into a local cache
that the rest of the pipeline treats exactly like a local studio checkout (pyhocon
include base + `coded_tools` import path). A local checkout can still be used via
`LocalStudio` for offline/dev use.

Two things are fetched and cached, and they are not the same thing. The **listing**
is the repo's recursive index of paths — no contents — and the **files** are the
bytes of the paths that turn out to be needed. A logical path such as
`toolbox/toolbox_info.hocon` is resolved by suffix-matching it against the listing,
so this works regardless of the repo's internal layout (e.g. files under a
`neuro_san_studio/` package dir), and the file is then cached locally at the
logical path.

The two have different costs. The listing comes from api.github.com and spends one
of a limited hourly allowance; the files come from raw.githubusercontent.com and
spend none of it. A cached file is returned without consulting the listing at all,
so the listing is only needed for a path this cache has never fetched.
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
LISTING_URL = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
DEFAULT_REPO = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF = "main"

# A diagnostic channel, not the build report. nsdeploy prints its report to
# stdout, but this module also runs in process inside the deployment service,
# where a print would land in the middle of that service's own output.
LOGGER = logging.getLogger(__name__)
# The listing is one API call per process, and a deployment service runs one process
# per build. Unauthenticated api.github.com allows 60 calls an hour per IP, so a busy
# service stops being able to resolve includes at all — the failure is a hard
# RuntimeError, not a slow build. The listing is cached on disk beside the files it
# indexes, so every later build within the TTL reads it from there.
LISTING_CACHE_NAME = ".listing.json"
LISTING_CACHE_TTL_SECONDS = 900
# A token raises the limit from 60 to 5000 calls an hour. Read from the standard
# names so an existing CI or container secret is picked up without new config.
TOKEN_ENV_NAMES = ("NSDEPLOY_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN")


def _github_token() -> str:
    """The GitHub token to authenticate a listing request with, if one is set."""
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

    def warm_listing(self) -> bool:
        """Make any shared index this source needs available before it is used.

        Nothing to do for a source that reads the filesystem; GithubStudio
        overrides it. A caller can therefore warm a source without knowing which
        kind it holds.

        :return: True when the source is ready to resolve paths.
        """
        return True


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
        self._listing: Optional[List[str]] = None

    @property
    def root(self) -> Path:
        return self._root

    def _listing_cache_path(self) -> Path:
        """Where this repo+ref's path listing is cached between processes."""
        return self._root / LISTING_CACHE_NAME

    def _cached_listing(self) -> Optional[List[str]]:
        """The path listing from disk, or None when it is absent or stale."""
        path = self._listing_cache_path()
        try:
            age = time.time() - path.stat().st_mtime
            if age > LISTING_CACHE_TTL_SECONDS:
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

    def _store_listing(self, paths: List[str]) -> None:
        """Cache the path listing for the next process. A failure is not fatal.

        The temporary name comes from mkstemp rather than the pid: a deployment
        service builds several bundles at once in worker threads of ONE process,
        so a pid-based name is shared, and one writer could replace the file while
        another still held it open — which is exactly what the atomic replace is
        meant to prevent.
        """
        tmp: Optional[Path] = None
        try:
            handle, raw = tempfile.mkstemp(prefix=f"{LISTING_CACHE_NAME}.", dir=self._root)
            tmp = Path(raw)
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(paths))
            # Replaced atomically: several builds race here, and a half-written
            # listing would be read as a corrupt cache by all of them.
            tmp.replace(self._listing_cache_path())
        except OSError as exc:
            # Non-fatal: this build already has the listing it just fetched. It is
            # reported because the consequence is otherwise invisible — a cache
            # directory that has turned unwritable, or a full disk, makes every
            # later build spend another api.github.com call until the hourly
            # allowance is gone, with nothing anywhere saying why.
            LOGGER.warning("cannot cache the path listing for %s@%s at %s: %s",
                           self.repo, self.ref, self._listing_cache_path(), exc)
            if tmp is not None:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError as cleanup:
                    LOGGER.warning("cannot remove the temporary cache file %s: %s",
                                   tmp, cleanup)

    def _load_listing(self) -> List[str]:
        if self._listing is None:
            self._listing = self._cached_listing()
        if self._listing is None:
            data = _http_get(LISTING_URL.format(repo=self.repo, ref=self.ref))
            if data is None:
                raise RuntimeError(
                    f"cannot read the path listing for {self.repo}@{self.ref}")
            # "tree" and "blob" here are GitHub's own names for a directory entry
            # and a file entry; only the file paths are wanted.
            self._listing = [t["path"] for t in json.loads(data).get("tree", []) if t.get("type") == "blob"]
            self._store_listing(self._listing)
        return self._listing

    def warm_listing(self) -> bool:
        """Fetch the path listing now, so later builds do not each fetch it.

        A deployment is a separate process, so the only thing concurrent builds
        can share is the disk cache — and a burst that starts with a cold cache
        has every process miss it before any has written it, costing one
        api.github.com call each. Unauthenticated that allowance is 60 an hour
        per IP, so a large enough first burst exhausts it and later builds fail
        to resolve their includes at all. Warming once, before any build, makes
        that one call for all of them.

        Best effort. A source that cannot be warmed is not broken: the next build
        that needs a path it has no file for fetches the listing itself.

        :return: True when a listing is available, False when it could not be read.
        """
        try:
            self._load_listing()
        except (OSError, RuntimeError, ValueError) as exc:
            LOGGER.warning("cannot warm the path listing for %s@%s: %s",
                           self.repo, self.ref, exc)
            return False
        return True

    def _resolve_upstream(self, rel_path: str) -> Optional[str]:
        """Find the actual repo path for a logical rel_path via exact-or-suffix match."""
        listing = self._load_listing()
        if rel_path in listing:
            return rel_path
        cands = [p for p in listing if p.endswith("/" + rel_path)]
        if not cands:  # fall back to basename match (e.g. coded tool module file)
            base = rel_path.split("/")[-1]
            cands = [p for p in listing if p.endswith("/" + base) or p == base]
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
