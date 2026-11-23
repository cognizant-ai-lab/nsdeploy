from pathlib import Path

from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.studio import Studio
from nsdeploy.studio_content.empty_content import EmptyContent
from nsdeploy.studio_content.mirror_workspace import MirrorWorkspace


class StudioChoice:
    """Which toolbox a bundle reads, decided from the command line.

    The whole of nsbundle's dependency on where neuro-san-studio lives. A checkout and
    a GitHub repository come from nsdeploy's own `Studio` factory, so a bundle shares
    nsdeploy's mirrors and repository cache: a network nsdeploy has built is already
    warm for nsbundle, and the reverse.

    The third choice is no toolbox at all, for a network that includes nothing. nsdeploy
    has no such option, so it is built here from the same seam: an `EmptyContent`
    behind a `MirrorWorkspace`.
    """

    # The mirror an empty toolbox is parsed against, beside nsdeploy's own mirrors. No
    # `Studio` mirror can have this name: those carry an `@` or a `local_` prefix.
    NO_TOOLBOX_DIR: str = "no-toolbox"

    @staticmethod
    def workspace(studio: str = "", repo: str = "", ref: str = "", no_studio: bool = False) -> ToolboxWorkspace:
        """
        Build the workspace a bundle resolves its includes through.

        :param studio: A local neuro-san-studio checkout, or an empty string.
        :param repo: The GitHub repository to read, as `owner/name`.
        :param ref: The branch, tag or commit to read.
        :param no_studio: True when the network needs no external toolbox at all.
        :return: The workspace.
        """
        if no_studio:
            return StudioChoice.empty()
        if studio:
            return Studio.local(studio)
        return Studio.github(repo, ref)

    @staticmethod
    def empty() -> ToolboxWorkspace:
        """
        Build a workspace over a toolbox that holds nothing.

        :return: The workspace.
        """
        mirror: Path = Path.home() / ".cache" / "nsdeploy" / StudioChoice.NO_TOOLBOX_DIR
        # Still a real directory: pyhocon parses against it whether or not anything is
        # ever written there.
        mirror.mkdir(parents=True, exist_ok=True)
        return MirrorWorkspace(EmptyContent(), mirror)
