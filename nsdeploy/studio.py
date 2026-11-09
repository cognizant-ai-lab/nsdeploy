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
import os
import tempfile
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


def _http_get(url: str) -> Optional[str]:
    req = urllib.request.Request(url, headers={"User-Agent": "nsdeploy", "Accept": "*/*"})
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
        data: Optional[str] = _http_get(TREE_URL.format(repo=self.repo, ref=self.ref))
        if data is None:
            raise RuntimeError(f"cannot read git tree for {self.repo}@{self.ref}")
        files: List[str] = []
        # Keep the files; the tree also lists directories.
        for entry in json.loads(data).get("tree", []):  # type: dict
            if entry.get("type") == "blob":
                files.append(entry.get("path"))
        return files

    @override
    def _read_upstream(self, upstream: str) -> Optional[str]:
        """
        Download one file of the repository.

        :param upstream: The file path relative to the repository root
        :return: The file contents, or None when the file does not exist
        """
        return _http_get(RAW_URL.format(repo=self.repo, ref=self.ref, path=upstream))
