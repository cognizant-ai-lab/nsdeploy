from pathlib import Path
from typing import Optional


class ToolboxWorkspace:
    """What a build asks of a neuro-san-studio, over whatever `ToolboxContent` supplies.

    This is the consumer-facing half of the studio seam. `resolve.py` and the MCP
    hosts depend on these methods; they never see a `ToolboxContent`, so a build does not
    know or care whether its external toolbox is a checkout, a repository or an archive.

    Two of these methods hand back a real directory, which looks like a leak and is
    not. Neither requirement is nsdeploy's:

    * `include_base` exists because **pyhocon resolves `include` lines itself**, by
      reading the filesystem. It cannot be given content, so the files a network
      includes have to be on disk before it parses — which is why `materialize`
      exists and why it must follow an included file's own includes.
    * `import_root` exists because **Python's import system reads paths**. A coded
      tool is arbitrary Python that must be importable in the site process and again
      in every MCP host process, so it has to be a file in a directory on `sys.path`.

    Naming them separately, rather than exposing one `root`, keeps the reason for each
    visible and lets an implementation answer them differently. An implementation that
    serves content from memory still has to write these two directories; that is the
    cost of the libraries involved, not of the design.

    Materializing is also what crosses a process boundary. The service resolves in
    process, each deployment child resolves again, and each MCP host imports from a
    directory it is given on its command line — so a path, not an object, is what a
    subprocess can be handed.
    """

    def identity(self) -> str:
        """
        Name the external toolbox behind this workspace, for build output and failures.

        :return: A short human-readable identity, carrying no credential.
        :raises NotImplementedError: Always; an implementation names its source.
        """
        raise NotImplementedError

    def resolve(self, logical_path: str) -> Optional[str]:
        """
        Find where this external toolbox actually keeps a logical path.

        A network asks for `registries/aaosa.hocon`; a external toolbox may hold it at
        `neuro_san_studio/registries/aaosa.hocon` or elsewhere. Resolution is the one
        piece of knowledge that differs per external toolbox layout, and the reason a build can
        name files without knowing how the external toolbox is arranged.

        :param logical_path: The path an agent network asks for.
        :return: The source's own path for it, or None when it holds no such file.
        :raises NotImplementedError: Always; an implementation resolves its own paths.
        """
        raise NotImplementedError

    def read_text(self, logical_path: str) -> Optional[str]:
        """
        Read one external toolbox file as text, without putting it on disk.

        For everything that is parsed rather than included or imported — the toolbox
        catalogue, a network definition being inspected — so that a reader need not
        materialize to look.

        :param logical_path: The path an agent network asks for.
        :return: The file as UTF-8 text, or None when there is no such file.
        :raises NotImplementedError: Always; an implementation reads its own files.
        :raises UnicodeDecodeError: If the file is not valid UTF-8.
        """
        raise NotImplementedError

    def materialize(self, logical_path: str) -> Optional[Path]:
        """
        Put one external toolbox file under `include_base` at its logical path.

        Needed only where a library reads paths instead of content: a HOCON include,
        or a coded-tool module. The copy is placed at the *logical* path, not the
        source's own, because that is the name the including file uses.

        A file the external toolbox no longer holds is removed from the mirror rather than left
        behind, so a stale copy cannot satisfy an include the external toolbox has dropped.

        :param logical_path: The path an agent network asks for.
        :return: The local path, or None when the external toolbox holds no such file.
        :raises NotImplementedError: Always; an implementation owns its mirror.
        :raises OSError: If the file cannot be written.
        """
        raise NotImplementedError

    def ensure_coded_tool(self, module_file: str) -> bool:
        """
        Make one coded-tool module importable under `import_root`.

        More than materializing it: the module has to sit inside an importable
        package, so the package marker is written too.

        :param module_file: The module's file name, such as `web_fetch.py`.
        :return: True when the module is importable, False when there is no such tool.
        :raises NotImplementedError: Always; an implementation owns its mirror.
        :raises OSError: If the module cannot be written.
        """
        raise NotImplementedError

    def include_base(self) -> Path:
        """
        The directory pyhocon parses a network against.

        Every file a network includes, directly or transitively, must be under here at
        its logical path before parsing starts.

        :return: The include base directory.
        :raises NotImplementedError: Always; an implementation owns its mirror.
        """
        raise NotImplementedError

    def import_root(self) -> Path:
        """
        The directory to put on `sys.path` so coded tools can be imported.

        Also what a subprocess is given, because an MCP host imports its tool in its
        own interpreter.

        :return: The import root directory.
        :raises NotImplementedError: Always; an implementation owns its mirror.
        """
        raise NotImplementedError

    def fetch(self, force: bool = False) -> bool:
        """
        Do now whatever this workspace would otherwise do on first use.

        A source that answers `list_paths` over a network wants that call made once,
        by a trusted process, rather than by each build that happens to be first — and
        wants it refreshed before anything cached for it expires. A workspace with
        nothing to prepare returns True without doing anything.

        Best effort by contract: a workspace that cannot pre-fetch content is not broken, and a
        caller is expected to carry on.

        :param force: Refresh even when what was prepared earlier is still usable.
        :return: True when the workspace is ready to resolve paths.
        :raises NotImplementedError: Always; an implementation knows what it prepares.
        """
        raise NotImplementedError
