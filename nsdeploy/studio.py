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
import urllib.error
import urllib.request
from http.client import HTTPResponse
from pathlib import Path
from typing import List
from typing import Optional

RAW_URL: str = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
TREE_URL: str = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
DEFAULT_REPO: str = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF: str = "main"


def _http_get(url: str) -> Optional[str]:
    req: urllib.request.Request = urllib.request.Request(url, headers={"User-Agent": "nsdeploy", "Accept": "*/*"})
    resp: HTTPResponse
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
        path: Optional[Path] = self.ensure(rel_path)
        return path.read_text(encoding="utf-8") if path else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        """Make `coded_tools/<module_file>` importable under root (with a package
        __init__). Returns True if available."""
        raise NotImplementedError


class LocalStudio(StudioSource):
    """
    Studio source backed by an existing local studio checkout.
    """

    def __init__(self, path: str | Path) -> None:
        self._root: Path = Path(path).resolve()

    @property
    def root(self) -> Path:
        return self._root

    def ensure(self, rel_path: str) -> Optional[Path]:
        p: Path = self._root / rel_path
        return p if p.is_file() else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        return (self._root / "coded_tools" / module_file).is_file()


class GithubStudio(StudioSource):
    """
    Studio source that downloads files on demand from a GitHub repository into a local cache.
    """

    def __init__(self, repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None) -> None:
        self.repo: str = repo
        self.ref: str = ref
        safe: str = repo.replace("/", "_")
        self._root: Path = Path(cache_dir) if cache_dir else (Path.home() / ".cache" / "nsdeploy" / f"{safe}@{ref}")
        self._root.mkdir(parents=True, exist_ok=True)
        self._tree: Optional[List[str]] = None

    @property
    def root(self) -> Path:
        return self._root

    def _load_tree(self) -> List[str]:
        if self._tree is None:
            data: Optional[str] = _http_get(TREE_URL.format(repo=self.repo, ref=self.ref))
            if data is None:
                raise RuntimeError(f"cannot read git tree for {self.repo}@{self.ref}")
            self._tree = [t["path"] for t in json.loads(data).get("tree", []) if t.get("type") == "blob"]
        return self._tree

    def _resolve_upstream(self, rel_path: str) -> Optional[str]:
        """Find the actual repo path for a logical rel_path via exact-or-suffix match."""
        tree: List[str] = self._load_tree()
        if rel_path in tree:
            return rel_path
        cands: List[str] = [p for p in tree if p.endswith("/" + rel_path)]
        if not cands:  # fall back to basename match (e.g. coded tool module file)
            base: str = rel_path.split("/")[-1]
            cands = [p for p in tree if p.endswith("/" + base) or p == base]
        if not cands:
            return None
        return min(cands, key=len)  # shortest path = least-nested / most canonical

    def ensure(self, rel_path: str) -> Optional[Path]:
        dest: Path = self._root / rel_path
        if dest.is_file():
            return dest
        upstream: Optional[str] = self._resolve_upstream(rel_path)
        if not upstream:
            return None
        raw: Optional[str] = _http_get(RAW_URL.format(repo=self.repo, ref=self.ref, path=upstream))
        if raw is None:
            return None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(raw, encoding="utf-8")
        return dest

    def ensure_coded_tool(self, module_file: str) -> bool:
        # Make `coded_tools` a package in the cache, then fetch the module file.
        pkg_init: Path = self._root / "coded_tools" / "__init__.py"
        if not pkg_init.exists():
            pkg_init.parent.mkdir(parents=True, exist_ok=True)
            pkg_init.write_text("", encoding="utf-8")
        return self.ensure(f"coded_tools/{module_file}") is not None
