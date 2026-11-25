from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Optional

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.studio_content.github_content import GithubContent
from nsdeploy.studio_content.local_content import LocalContent
from nsdeploy.studio_content.mirror_workspace import MirrorWorkspace

DEFAULT_REPO: str = "cognizant-ai-lab/neuro-san-studio"
DEFAULT_REF: str = "main"


class ToolboxWorkspaceFactory:
    """Builds the `ToolboxWorkspace` through which a build reads dependency files.

    A build needs HOCON includes such as `aaosa.hocon`, the toolbox catalogue
    `toolbox/toolbox_info.hocon`, and coded-tool `.py` sources. The end user should not
    have to clone sources repository for them, so by default nsdeploy reads just those
    files from the public GitHub repository and mirrors them into a local directory: a
    pyhocon include base and a `coded_tools` import path. A checkout can still be used,
    for offline work and for development, and is mirrored the same way.

    This class only chooses the content source and the directories. Resolving logical
    paths, mirroring and coded-tool packaging belong to `ToolboxWorkspace` implementation.
    """

    @staticmethod
    def local(path: str | Path, cache_dir: Optional[Path] = None) -> ToolboxWorkspace:
        """
        Read a local repository checkout. Requested files are copied on every request, so
        edits to the checkout apply to the next build.

        :param path: The local repository checkout.
        :param cache_dir: The mirror directory; defaults to one per checkout under `~/.cache/nsdeploy`.
        :return: The workspace over the checkout.
        """
        checkout: Path = Path(path).resolve()
        digest: str = hashlib.sha256(str(checkout).encode("utf-8")).hexdigest()[:12]
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / f"local_{checkout.name}_{digest}"
        return ToolboxWorkspaceFactory._workspace(LocalContent(checkout), Path(cache_dir) if cache_dir else default_cache)

    @staticmethod
    def github(repo: str = DEFAULT_REPO, ref: str = DEFAULT_REF, cache_dir: Optional[Path] = None) -> ToolboxWorkspace:
        """
        Read a GitHub repository on demand.

        Each workspace asks the repository for its file list once, and reads each file
        it needs from the repository. Nothing but the mirror is kept between builds.

        :param repo: The GitHub repository, as `owner/name`.
        :param ref: The branch, tag or commit to read.
        :param cache_dir: The mirror directory; defaults to one per repository and ref under `~/.cache/nsdeploy`.
        :return: The workspace over the repository.
        """
        default_cache: Path = Path.home() / ".cache" / "nsdeploy" / ToolboxWorkspaceFactory._mirror_name(repo, ref)
        mirror: Path = (Path(cache_dir) if cache_dir else default_cache).resolve()
        # No token: a repository is read in processes that run uploaded code, and this
        # source has always read the public repository anonymously.
        return ToolboxWorkspaceFactory._workspace(GithubContent(repo, ref), mirror)

    @staticmethod
    def _mirror_name(repo: str, ref: str) -> str:
        """
        Name the default mirror of a repository at a ref, as one path component.

        A ref may contain `/`, and a name built from it as-is would put the mirror of
        `release/feature` inside the mirror of `release`, where that ref's includes
        could reach it. Every character outside a safe set becomes `_`, and a digest
        of the exact repository and ref keeps refs that now read alike apart.

        :param repo: The GitHub repository, as `owner/name`.
        :param ref: The branch, tag or commit.
        :return: The directory name.
        """
        exact: str = f"{repo}@{ref}"
        readable: str = re.sub(r"[^A-Za-z0-9._@-]", "_", exact)
        digest: str = hashlib.sha256(exact.encode("utf-8")).hexdigest()[:12]
        # Keep the ASCII directory component within the common 255-byte filesystem limit.
        return f"{readable[:255 - len(digest) - 1]}_{digest}"

    @staticmethod
    def _workspace(content: ToolboxContent, mirror: Path) -> ToolboxWorkspace:
        """
        Serve a build from `content`, mirroring what it needs into `mirror`.

        :param content: Where the repository files are read from.
        :param mirror: The directory the requested files are mirrored into.
        :return: The workspace.
        """
        # The directory has to exist before anything is materialized, because a build
        # puts it on sys.path and gives it to pyhocon whether or not it holds a file yet.
        mirror.mkdir(parents=True, exist_ok=True)
        return MirrorWorkspace(content, mirror)
