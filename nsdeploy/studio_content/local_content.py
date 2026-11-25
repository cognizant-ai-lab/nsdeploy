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

        Both files are checked for containment first. The name of the second one comes
        from the contents of the first, so a checkout carrying `ref: ../../secret`
        would otherwise make the revision of a studio the contents of a file beside it.
        A symbolic link out of the checkout is refused the same way, because `_inside`
        resolves before it compares.

        :return: The commit id, or an empty string when it cannot be determined.
        """
        pointer: str = self._read_inside(self._checkout / ".git" / "HEAD")
        if not pointer.startswith("ref:"):
            # Detached HEAD holds the commit id itself, and an unreadable or absent
            # HEAD reads as empty, which is the same answer as a plain directory.
            return pointer
        reference: str = pointer.partition("ref:")[2].strip()
        if not reference:
            return ""
        # A ref with no file of its own is a packed one, which resolving properly
        # would mean parsing packed-refs. That reads as empty here.
        return self._read_inside(self._checkout / ".git" / reference)

    def _read_inside(self, target: Path) -> str:
        """
        Read one file of the checkout as stripped text, refusing one outside it.

        :param target: The file to read.
        :return: The contents, or an empty string when it is unreadable or outside.
        """
        if not self._inside(target):
            return ""
        try:
            return target.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    @staticmethod
    def _raise_walk_error(error: OSError) -> None:
        """
        Propagate a filesystem traversal failure.

        :param error: The error raised while listing the checkout.
        :raises OSError: Always; an incomplete listing is not usable.
        """
        raise error

    @override
    def list_paths(self) -> List[str]:
        """
        Every file in the checkout, as `/`-separated paths relative to its root.

        :return: The file paths.
        :raises FileNotFoundError: If the checkout is not a directory.
        :raises OSError: If a directory cannot be listed.
        """
        if self._paths is not None:
            return self._paths
        if not self._checkout.is_dir():
            raise FileNotFoundError(f"studio checkout not found: {self._checkout}")
        found: List[str] = []
        directory: str
        dir_names: List[str]
        file_names: List[str]
        # Walk the checkout, pruning the directories that hold no studio content.
        for directory, dir_names, file_names in os.walk(self._checkout, onerror=LocalContent._raise_walk_error):
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
