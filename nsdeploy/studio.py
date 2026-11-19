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


class Studio:
    """Builds the `ToolboxWorkspace` a build reads neuro-san-studio files through.

    A build needs HOCON includes such as `aaosa.hocon`, the toolbox catalogue
    `toolbox/toolbox_info.hocon`, and coded-tool `.py` sources. The end user should not
    have to clone neuro-san-studio for them, so by default nsdeploy reads just those
    files from the public GitHub repository and mirrors them into a local directory: a
    pyhocon include base and a `coded_tools` import path. A checkout can still be used,
    for offline work and for development, and is mirrored the same way.

    This class only chooses the content source and the directories. Resolving logical
    paths, mirroring and coded-tool packaging belong to `MirrorWorkspace`.
    """

    # The directory, beside the mirrors, that holds one repository cache per mirror
    # under the mirror's own name. No default mirror name can equal it: those carry an
    # `@` or a `local_` prefix.
    UPSTREAM_DIR: str = ".upstream"

    @staticmethod
    def local(path: str | Path, cache_dir: Optional[Path] = None) -> ToolboxWorkspace:
        """
        Read a local studio checkout. Requested files are copied on every request, so
        edits to the checkout apply to the next build.

        :param path: The local neuro-san-studio checkout.
        :param cache_dir: The mirror directory; defaults to one per checkout under `~/.cache/nsdeploy`.
        :return: The workspace over the checkout.
        """
        checkout: Path = Path(path).resolve()
        digest: str = hashlib.sha256(str(checkout).encode("utf-8")).hexdigest()[:12]
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"local_{checkout.name}_{digest}"
        return Studio._workspace(LocalContent(checkout), Path(cache_dir) if cache_dir else default_cache)

    @staticmethod
    def github(repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None) -> ToolboxWorkspace:
        """
        Read a GitHub repository on demand, through a cache shared by every build.

        :param repo: The GitHub repository, as `owner/name`.
        :param ref: The branch, tag or commit to read.
        :param cache_dir: The mirror directory; defaults to one per repository and ref under `~/.cache/nsdeploy`.
        :return: The workspace over the repository.
        """
        safe: str = repo.replace("/", "_")
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"{safe}@{ref}"
        mirror: Path = (Path(cache_dir) if cache_dir else default_cache).resolve()
        # The repository cache sits beside the mirror, never inside it. The mirror is
        # the include base, so anything under it can be named by a network's include,
        # and a cached file or the file list could then be overwritten for every later
        # build. Beside it, reaching the cache takes a `..`, which the workspace refuses.
        # It is in a namespace of its own rather than a sibling with a suffix, so no
        # other mirror -- such as the one for a ref named `main.upstream` -- is the cache.
        #
        # A downloaded file therefore exists twice: in the cache, keyed by the
        # repository's own path, and in the mirror at the logical path a network asks
        # for. That is accepted. Studio files are small, and collapsing the two would
        # mean teaching the mirror which sources are safe to answer from disk -- a
        # decision that belongs to a content source, not to the workspace.
        #
        # No token: a studio is read in processes that run uploaded code, and this
        # source has always read the public repository anonymously.
        kept: Path = mirror.parent / Studio.UPSTREAM_DIR / mirror.name
        return Studio._workspace(CachedContent(GithubContent(repo, ref), kept), mirror)

    @staticmethod
    def _workspace(content: ToolboxContent, mirror: Path) -> ToolboxWorkspace:
        """
        Serve a build from `content`, mirroring what it needs into `mirror`.

        :param content: Where the studio files are read from.
        :param mirror: The directory the requested files are mirrored into.
        :return: The workspace.
        """
        # The directory has to exist before anything is materialized, because a build
        # puts it on sys.path and gives it to pyhocon whether or not it holds a file yet.
        mirror.mkdir(parents=True, exist_ok=True)
        return MirrorWorkspace(content, mirror)
