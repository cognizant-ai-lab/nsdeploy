import os
from pathlib import Path
from typing import List
from typing import Optional
from typing import Tuple

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent


class LocalContent(ToolboxContent):
    """A neuro-san-studio that is already a directory on this machine.

    Reads the checkout in place and copies nothing: a workspace materializes what a
    build needs, and until then an edit in the checkout is visible to the next
    `read`. That is the property a developer wants from a local studio — change a
    HOCON, build again, see the change — and it is why this class holds no state
    beyond the memoized file list.

    Nothing here knows about mirrors, include bases or `sys.path`. Those belong to
    the workspace, which is written once over any `ToolboxContent`.
    """

    # Directories of a checkout that hold no studio content: a virtualenv, installed
    # packages and compiled caches. Listing them would be slow and would offer a build
    # files it must never resolve an include to. Hidden directories are skipped too,
    # which is what keeps `.git` out of the listing.
    SKIPPED_DIRS: Tuple[str, ...] = ("venv", ".venv", "node_modules", "__pycache__")

    def __init__(self, checkout: str | Path) -> None:
        """
        Read the studio at `checkout`.

        :param checkout: The local neuro-san-studio directory.
        """
        self._checkout: Path = Path(checkout).resolve()
        self._paths: Optional[List[str]] = None

    @override
    def identity(self) -> str:
        """
        Name this checkout for build output.

        :return: The checkout's absolute path.
        """
        return str(self._checkout)

    @override
    def revision(self) -> str:
        """
        Report the checked-out commit, when the directory is a git working tree.

        Best effort and deliberately shallow: `.git/HEAD` is read directly rather
        than shelling out to git, because this runs inside a build and must not
        depend on a git binary being installed. A directory that is not a working
        tree is still a valid studio, so that case is an empty revision rather than
        an error.

        A working tree also has uncommitted edits, which this cannot see. The value
        therefore identifies what was committed, not exactly what was read.

        :return: The commit id, or an empty string when it cannot be determined.
        """
        head: Path = self._checkout / ".git" / "HEAD"
        pointer: str = ""
        try:
            pointer = head.read_text(encoding="utf-8").strip()
        except OSError:
            return ""
        if not pointer.startswith("ref:"):
            # Detached HEAD: the file holds the commit id itself.
            return pointer
        reference: str = pointer.partition("ref:")[2].strip()
        if not reference:
            return ""
        try:
            return (self._checkout / ".git" / reference).read_text(encoding="utf-8").strip()
        except OSError:
            # A packed ref, which resolving properly would mean parsing packed-refs.
            return ""

    @override
    def list_paths(self) -> List[str]:
        """
        Every file in the checkout, as `/`-separated paths relative to its root.

        :return: The file paths.
        :raises FileNotFoundError: If the checkout is not a directory.
        """
        if self._paths is not None:
            return self._paths
        if not self._checkout.is_dir():
            raise FileNotFoundError(f"studio checkout not found: {self._checkout}")
        found: List[str] = []
        # Walk the checkout, pruning the directories that hold no studio content.
        for directory, dir_names, file_names in os.walk(self._checkout):
            kept: List[str] = []
            # Keep only the subdirectories a build could resolve a path into.
            for dir_name in dir_names:
                if not dir_name.startswith(".") and dir_name not in LocalContent.SKIPPED_DIRS:
                    kept.append(dir_name)
            # Assigned in place, which is how os.walk is told not to descend.
            dir_names[:] = kept
            relative: Path = Path(directory).relative_to(self._checkout)
            # Record each file by its path relative to the checkout.
            for file_name in file_names:
                found.append((relative / file_name).as_posix())
        self._paths = found
        return self._paths

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        Read one file of the checkout.

        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when the checkout has no such file.
        :raises OSError: If the file exists but cannot be read.
        """
        target: Path = self._checkout / path
        if not self._inside(target):
            return None
        if not target.is_file():
            return None
        return target.read_bytes()

    def _inside(self, target: Path) -> bool:
        """
        Report whether a path stays within the checkout.

        `list_paths` only ever reports paths inside it, but `read` takes a string
        from a caller, and a studio must not become a way to read the rest of the
        filesystem. A symbolic link out of the checkout is refused for the same
        reason, which `resolve()` is what detects.

        :param target: The path to test.
        :return: True when the path is inside the checkout.
        """
        try:
            return target.resolve().is_relative_to(self._checkout)
        except OSError:
            return False
