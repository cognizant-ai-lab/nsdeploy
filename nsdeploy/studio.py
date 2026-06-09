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
from pathlib import Path
from typing import List, Optional

RAW_URL = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
TREE_URL = "https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1"
DEFAULT_REPO = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF = "main"


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
    """Abstract source of studio files, materialized under a local `root`."""

    @property
    def root(self) -> Path:
        raise NotImplementedError

    def ensure(self, rel_path: str) -> Optional[Path]:
        """Make `rel_path` available under root; return its local path or None."""
        raise NotImplementedError

    def read(self, rel_path: str) -> Optional[str]:
        path = self.ensure(rel_path)
        return path.read_text(encoding="utf-8") if path else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        """Make `coded_tools/<module_file>` importable under root (with a package
        __init__). Returns True if available."""
        raise NotImplementedError


class LocalStudio(StudioSource):
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

    def _load_tree(self) -> List[str]:
        if self._tree is None:
            data = _http_get(TREE_URL.format(repo=self.repo, ref=self.ref))
            if data is None:
                raise RuntimeError(f"cannot read git tree for {self.repo}@{self.ref}")
            self._tree = [t["path"] for t in json.loads(data).get("tree", []) if t.get("type") == "blob"]
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
