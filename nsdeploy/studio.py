from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Optional

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.studio_content.cached_content import CachedContent
from nsdeploy.studio_content.github_content import GithubContent
from nsdeploy.studio_content.local_content import LocalContent
from nsdeploy.studio_content.mirror_workspace import MirrorWorkspace

DEFAULT_REPO: str = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF: str = "main"


class StudioSource:
    """Where nsdeploy gets the studio files a build needs, over a `ToolboxWorkspace`.

    A build needs HOCON includes such as `aaosa.hocon`, the toolbox catalogue
    `toolbox/toolbox_info.hocon`, and coded-tool `.py` sources. The end user should not
    have to clone neuro-san-studio for them, so by default nsdeploy reads just those
    files from the public GitHub repository and mirrors them into a local cache that
    the rest of the pipeline treats exactly like a checkout: a pyhocon include base and
    a `coded_tools` import path. A checkout can still be used, for offline work and for
    development, and is mirrored the same way.

    Files are located by matching the source's file list, so this works whatever the
    repository's internal layout is. A logical path such as `toolbox/toolbox_info.hocon`
    resolves to whatever entry ends with it — a file nested under a `neuro_san_studio/`
    package directory included — and is mirrored at the logical path, which is the name
    the including file uses.

    None of that is implemented here any more. This class and its two subclasses are
    the names the rest of nsdeploy and nsdeploy_service already import; what they do now
    is choose a `ToolboxContent` and hand the work to a `ToolboxWorkspace`. The methods
    below are what their callers ask for today, expressed in terms of the workspace.
    """

    def __init__(self, content: ToolboxContent, cache_dir: Path) -> None:
        """
        Serve a build from `content`, mirroring what it needs into `cache_dir`.

        :param content: Where the studio files are read from.
        :param cache_dir: The local directory that the requested files are mirrored into.
        """
        self._root: Path = Path(cache_dir)
        # The directory has to exist before anything is materialized, because a build
        # puts it on sys.path and gives it to pyhocon whether or not it holds a file yet.
        self._root.mkdir(parents=True, exist_ok=True)
        self._workspace: ToolboxWorkspace = MirrorWorkspace(content, self._root)

    @property
    def root(self) -> Path:
        """
        Return the local directory that holds the materialized studio files.

        :return: The local root directory.
        """
        return self._root

    def ensure(self, rel_path: str) -> Optional[Path]:
        """
        Make `rel_path` available under root.

        :param rel_path: The logical path relative to root.
        :return: The local path, or None when the studio has no such file.
        :raises OSError: If the file cannot be read or written.
        """
        return self._workspace.materialize(rel_path)

    def read(self, rel_path: str) -> Optional[str]:
        """
        Read a studio file as UTF-8 text.

        Through `ensure` rather than the workspace's own text read, so that a subclass
        which answers a cached file without going upstream is not bypassed here.

        :param rel_path: The file path relative to the studio root.
        :return: The file contents, or None when the file is unavailable.
        :raises OSError: If the file cannot be read.
        """
        path: Optional[Path] = self.ensure(rel_path)
        return path.read_text(encoding="utf-8") if path else None

    def ensure_coded_tool(self, module_file: str) -> bool:
        """
        Make `coded_tools/<module_file>` importable under root, with a package `__init__.py`.

        :param module_file: The file name of the coded-tool module, such as `web_fetch.py`.
        :return: True when the module is available under root.
        :raises OSError: If the module cannot be written.
        """
        return self._workspace.ensure_coded_tool(module_file)


class LocalStudio(StudioSource):
    """
    Studio source backed by an existing local studio checkout. Requested files are
    copied into a cache on every request, so edits to the checkout apply to the next build.
    """

    def __init__(self, path: str | Path, cache_dir: Optional[Path] = None) -> None:
        """
        Use the checkout at `path`.

        :param path: The local neuro-san-studio checkout.
        :param cache_dir: The mirror directory; defaults to one per checkout under `~/.cache/nsdeploy`.
        """
        checkout: Path = Path(path).resolve()
        digest: str = hashlib.sha256(str(checkout).encode("utf-8")).hexdigest()[:12]
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"local_{checkout.name}_{digest}"
        super().__init__(LocalContent(checkout), Path(cache_dir) if cache_dir else default_cache)


class GithubStudio(StudioSource):
    """
    Studio source that downloads files on demand from a GitHub repository into a local cache.
    """

    # Where the repository's own files and file list are kept, inside the cache
    # directory and beside the mirror.
    UPSTREAM_DIR: str = ".upstream"

    def __init__(self, repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None) -> None:
        """
        Use the GitHub repository `repo` at `ref`.

        :param repo: The GitHub repository, as `owner/name`.
        :param ref: The branch, tag or commit to read.
        :param cache_dir: The mirror directory; defaults to one per repository and ref under `~/.cache/nsdeploy`.
        """
        self.repo: str = repo
        self.ref: str = ref
        safe: str = repo.replace("/", "_")
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"{safe}@{ref}"
        root: Path = Path(cache_dir) if cache_dir else default_cache
        # What came from the repository is kept apart from the mirror, under a name no
        # logical path uses, so the two never answer for each other. The cache is what
        # keeps a repeat build -- in this process or the next one -- off the network.
        # No token: a studio is read in processes that run uploaded code, and this
        # source has always read the public repository anonymously.
        upstream: ToolboxContent = CachedContent(GithubContent(repo, ref), root / GithubStudio.UPSTREAM_DIR)
        super().__init__(upstream, root)
