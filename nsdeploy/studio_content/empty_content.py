from typing import List
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent


class EmptyContent(ToolboxContent):
    """A toolbox that holds nothing, for a network that needs nothing.

    A self-contained `.hocon` names no registry, includes no other file and imports no
    coded tool. Such a build has no external toolbox, and this is what it is given.

    It exists so that "no toolbox" is a value rather than an absent one. The
    alternative is an optional source, which puts a `None` check in front of every
    call that reads content, and then puts the same check in the next caller. A build
    over this source takes exactly the same path as a build over a checkout; it just
    resolves nothing.

    It is also the only source that cannot fail. No network, no filesystem, no
    credential — so a deployment that needs no toolbox cannot be stopped by a studio
    being unreachable, and does not wait on one being read.
    """

    # Not an empty string, which the contract reserves for a source that cannot tell:
    # this source can. It holds nothing now and will hold nothing later, so a build
    # recorded against it compares equal to a rebuild.
    REVISION: str = "empty"

    @override
    def identity(self) -> str:
        """
        Name this source for build output.

        Phrased as a statement rather than a name, because it is read in a failure: a
        reader who asked for an include needs to see that there was nowhere to look
        for it, not a source that sounds like it should have had the file.

        :return: A fixed description.
        """
        return "no external toolbox"

    @override
    def revision(self) -> str:
        """
        Identify this source's version, which never changes.

        :return: A fixed revision.
        """
        return EmptyContent.REVISION

    @override
    def list_paths(self) -> List[str]:
        """
        Every file this source holds, of which there are none.

        :return: An empty list.
        """
        return []

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        Read one file, which this source never has.

        :param path: A path a caller asks for.
        :return: None, always.
        """
        return None
