from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.interfaces.toolbox_layout import ToolboxLayout
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.studio_content.cached_content import CachedContent
from nsdeploy.studio_content.github_content import GithubContent
from nsdeploy.studio_content.local_content import LocalContent
from nsdeploy.studio_content.mirror_workspace import MirrorWorkspace

DEFAULT_REPO: str = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF: str = "main"

logger: logging.Logger = logging.getLogger(__name__)


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

    # Appended to the mirror directory's name to name the directory, beside it, where
    # the repository's own files and file list are kept.
    UPSTREAM_SUFFIX: str = ".upstream"

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
        # What came from the repository is kept beside the mirror, never inside it. The
        # mirror is the include base, and an include is a network's input: anything
        # under the mirror can be named by one, and a name that resolves by suffix to a
        # cached file would overwrite it, or delete the file list, for every later
        # build. Beside it, reaching the cache takes a `..`, which the workspace
        # refuses. The cache is what keeps a repeat build -- in this process or the
        # next one -- off the network.
        #
        # A downloaded file therefore exists twice: in the cache, keyed by the
        # repository's own path, and in the mirror at the logical path a network asks for. That is accepted.
        # Studio files are small, the two are keyed differently and neither can serve
        # the other's purpose, and collapsing them would mean teaching the mirror which
        # sources are safe to answer from disk -- a decision that belongs to a content
        # source, not to the workspace.
        #
        # No token: a studio is read in processes that run uploaded code, and this
        # source has always read the public repository anonymously.
        mirror: Path = root.resolve()
        kept: Path = mirror.with_name(mirror.name + GithubStudio.UPSTREAM_SUFFIX)
        upstream: ToolboxContent = CachedContent(GithubContent(repo, ref), kept)
        super().__init__(upstream, root)

    @override
    def ensure(self, rel_path: str) -> Optional[Path]:
        """
        Make `rel_path` available under root, or serve the mirrored copy when the
        repository cannot be reached.

        A mirror filled before the repository cache existed holds files but no file
        list, and a list can only come from the repository. Without this fallback such
        a mirror stops serving offline and rate-limited builds.

        :param rel_path: The logical path relative to root.
        :return: The local path, or None when the studio has no such file.
        :raises OSError: If the repository cannot be read and the mirror has no copy.
        """
        try:
            return super().ensure(rel_path)
        except OSError as exception:
            kept: Optional[Path] = self._mirrored(rel_path)
            if kept is None:
                raise
            logger.warning("cannot read %s@%s (%s); using the mirrored %s", self.repo, self.ref, exception, rel_path)
            return kept

    @override
    def ensure_coded_tool(self, module_file: str) -> bool:
        """
        Make `coded_tools/<module_file>` importable under root, or accept the mirrored
        module when the repository cannot be reached.

        :param module_file: The file name of the coded-tool module, such as `web_fetch.py`.
        :return: True when the module is available under root.
        :raises OSError: If the repository cannot be read and the mirror has no copy.
        """
        try:
            return super().ensure_coded_tool(module_file)
        except OSError as exception:
            module: Optional[Path] = self._mirrored(ToolboxLayout.coded_tool_path(module_file))
            marker: Optional[Path] = self._mirrored(ToolboxLayout.coded_tool_path("__init__.py"))
            if module is None or marker is None:
                raise
            logger.warning("cannot read %s@%s (%s); using the mirrored %s", self.repo, self.ref, exception, module_file)
            return True

    def _mirrored(self, rel_path: str) -> Optional[Path]:
        """
        Find a file a previous build left in the mirror.

        :param rel_path: The logical path relative to root.
        :return: The mirrored file, or None when there is none or the path leaves root.
        """
        target: Path = self.root / rel_path
        try:
            if not target.resolve().is_relative_to(self.root.resolve()):
                return None
        except OSError:
            return None
        return target if target.is_file() else None
