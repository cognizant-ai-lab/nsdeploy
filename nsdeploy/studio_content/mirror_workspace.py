import os
import tempfile
from pathlib import Path
from typing import List
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.interfaces.toolbox_layout import ToolboxLayout
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace


class MirrorWorkspace(ToolboxWorkspace):
    """A workspace that answers from one `ToolboxContent`, copying to disk on demand.

    *Mirror* is this repo's word for the local directory a build reads its toolbox
    files from: a copy of each file the build asked for, written at the path the build
    asked for it by. It is not a copy of the toolbox — only what was requested is
    there, so it fills up as a build follows its includes. `studio.py` and the
    `ToolboxWorkspace` contract use the word the same way.

    Written once over any content source: a checkout, a repository, an archive, a
    dictionary. The source is the only place content comes from, and this class never
    reads a file by any other route — which is what makes "where the toolbox lives" a
    constructor argument rather than a branch in the build.

    The mirror holds a file at the *logical* path a network asked for, not at the
    source's own. That is deliberate: an included file names its siblings the way the
    network does, so pyhocon has to find them under the names the network uses, not
    under wherever the toolbox happens to keep them.

    The mirror directory is required rather than defaulted. A default under the
    invoking user's home is convenient exactly until two things share it — a test
    suite and a developer's real builds, or two services with different content —
    and then it is a bug that only shows up as a stale file.
    """

    def __init__(self, content: ToolboxContent, mirror: Path) -> None:
        """
        Serve a build from `content`, materializing what it needs into `mirror`.

        :param content: The only source of file content for this workspace.
        :param mirror: The directory that materialized files are written into.
        """
        self._content: ToolboxContent = content
        self._mirror: Path = Path(mirror)
        self._paths: Optional[List[str]] = None

    @override
    def identity(self) -> str:
        """
        Name the toolbox behind this workspace.

        :return: The content source's identity.
        """
        return self._content.identity()

    @override
    def include_base(self) -> Path:
        """
        The directory pyhocon parses a network against.

        :return: The mirror directory.
        """
        return self._mirror

    @override
    def import_root(self) -> Path:
        """
        The directory to put on `sys.path` so coded tools can be imported.

        The same directory as the include base today, because a coded tool is found
        under `coded_tools/` inside the mirror. They are separate methods because the
        two requirements are separate: one is pyhocon's, one is Python's.

        :return: The mirror directory.
        """
        return self._mirror

    @override
    def fetch(self, force: bool = False) -> bool:
        """
        Load the file listing, which is what resolution needs and the only thing a
        workspace prepares ahead of time.

        Whether this reaches a network is the content source's business. A source
        that memoizes answers from its memo; one wrapped in a cache answers from the
        cache. `force` discards what *this* object learned, so the next question goes
        back to the source — it cannot make a source forget.

        :param force: Discard the listing held here and ask the source again.
        :return: True when the workspace is ready to resolve paths.
        """
        if force:
            self._paths = None
        try:
            self._load()
        except OSError:
            # Best effort by contract: a caller carries on, and the next build that
            # needs a path asks again.
            return False
        return True

    @override
    def resolve(self, logical_path: str) -> Optional[str]:
        """
        Find where this toolbox actually keeps a logical path.

        An exact match wins. Otherwise the shortest path ending with the logical
        path, then the shortest with the same file name — shortest because the least
        nested copy is the canonical one, and a toolbox that vendors a second copy
        deeper in its tree should not shadow it.

        :param logical_path: The path an agent network asks for.
        :return: The source's own path for it, or None when it holds no such file.
        :raises OSError: If the listing cannot be read.
        """
        paths: List[str] = self._load()
        if logical_path in paths:
            return logical_path
        base: str = logical_path.rsplit("/", 1)[-1]
        under: List[str] = []
        named: List[str] = []
        # One pass, collecting both kinds of near match.
        for path in paths:
            if path.endswith("/" + logical_path):
                under.append(path)
            if path == base or path.endswith("/" + base):
                named.append(path)
        candidates: List[str] = under or named
        if not candidates:
            return None
        return min(candidates, key=len)

    @override
    def read_text(self, logical_path: str) -> Optional[str]:
        """
        Read one file as text, without putting it on disk.

        :param logical_path: The path an agent network asks for.
        :return: The file as UTF-8 text, or None when there is no such file.
        :raises OSError: If the listing or the file cannot be read.
        :raises UnicodeDecodeError: If the file is not valid UTF-8.
        """
        raw: Optional[bytes] = self._read_bytes(logical_path)
        if raw is None:
            return None
        return raw.decode("utf-8")

    @override
    def materialize(self, logical_path: str) -> Optional[Path]:
        """
        Put one file under the mirror at its logical path.

        A file the toolbox no longer holds is removed from the mirror rather than
        left behind, so a copy from an earlier build cannot satisfy an include the
        toolbox has dropped.

        :param logical_path: The path an agent network asks for.
        :return: The local path, or None when the toolbox holds no such file.
        :raises OSError: If the file cannot be written.
        """
        target: Path = self._mirror / logical_path
        if not self._inside(target):
            return None
        raw: Optional[bytes] = self._read_bytes(logical_path)
        if raw is None:
            target.unlink(missing_ok=True)
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        self._write(target, raw)
        return target

    @override
    def ensure_coded_tool(self, module_file: str) -> bool:
        """
        Make one coded-tool module importable under the import root.

        More than materializing it: Python imports a module through its package, so
        the package marker is written whether or not the tool itself is found. An
        empty `coded_tools` package is harmless; a module without one is unreachable.

        :param module_file: The module's file name, such as `web_fetch.py`.
        :return: True when the module is importable, False when there is no such tool.
        :raises OSError: If the module cannot be written.
        """
        marker: Path = self._mirror / ToolboxLayout.CODED_TOOLS / "__init__.py"
        if not marker.exists():
            marker.parent.mkdir(parents=True, exist_ok=True)
            self._write(marker, b"")
        return self.materialize(ToolboxLayout.coded_tool_path(module_file)) is not None

    def _load(self) -> List[str]:
        """
        The file listing, asked of the source once per workspace.

        :return: The paths the source holds.
        :raises OSError: If the listing cannot be read.
        """
        if self._paths is None:
            self._paths = self._content.list_paths()
        return self._paths

    def _read_bytes(self, logical_path: str) -> Optional[bytes]:
        """
        Resolve a logical path and read it from the source.

        :param logical_path: The path an agent network asks for.
        :return: The file's bytes, or None when the toolbox holds no such file.
        :raises OSError: If the listing or the file cannot be read.
        """
        upstream: Optional[str] = self.resolve(logical_path)
        if upstream is None:
            return None
        return self._content.read(upstream)

    def _inside(self, target: Path) -> bool:
        """
        Report whether a path stays within the mirror.

        A logical path comes from a network's own `include` lines, so it is input: a
        `..` in one must not let a build write outside the directory it was given.

        :param target: The path to test.
        :return: True when the path is inside the mirror.
        """
        try:
            return target.resolve().is_relative_to(self._mirror.resolve())
        except OSError:
            return False

    @staticmethod
    def _write(target: Path, raw: bytes) -> None:
        """
        Write a file so that no reader ever sees it half-written.

        Builds share a mirror and run at the same time, so a plain write could be
        read by pyhocon mid-way through. The replace is atomic, and the temporary
        name is unique per writer, so two builds materializing one file cannot
        replace each other's partial copy.

        :param target: Where the file belongs.
        :param raw: The bytes to write.
        :raises OSError: If the file cannot be written.
        """
        handle, partial = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(raw)
            os.replace(partial, target)
        except OSError:
            Path(partial).unlink(missing_ok=True)
            raise
