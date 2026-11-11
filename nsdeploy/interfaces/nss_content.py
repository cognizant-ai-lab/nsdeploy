from typing import List
from typing import Optional


class NssContent:
    """Read-only access to one neuro-san-studio's files, however they are stored.

    This is the pluggable half of the studio seam: a checkout, a GitHub repository, a
    released archive, an installed package or a dictionary in a test each implement
    these four methods and nothing else. Everything nsdeploy does with the files —
    resolving a logical path, mirroring to disk, making `coded_tools` importable,
    giving pyhocon an include base — belongs to `NssWorkspace`, which is written once
    over any of them.

    Deliberately not in this interface:

    * **No directory semantics.** No listdir, stat or walk. `list_paths` returns every
      file in one flat sequence, because that is all resolution needs and it is the
      only shape a non-filesystem source can answer cheaply.
    * **No writing.** nsdeploy never changes a studio.
    * **No history.** One revision at a time; which one is `revision`'s business.
    * **No local path.** A source that has no files on disk is a valid source. Only
      the workspace materializes, and only because pyhocon and Python's import system
      read paths rather than content.

    Content is bytes, not text. Most studio files are UTF-8 HOCON or Python, but a
    source is the wrong place to decide an encoding, and a studio that grows an image
    or a font should not need a new interface. `NssWorkspace` decodes.
    """

    def identity(self) -> str:
        """
        Name this source well enough for a person to act on a failure.

        What a reader needs is where a missing include was looked for: a repository
        and ref, a checkout path, an archive name. It goes into build output, so it
        must carry no credential.

        :return: A short human-readable identity.
        :raises NotImplementedError: Always; an implementation names itself.
        """
        raise NotImplementedError

    def revision(self) -> str:
        """
        Identify which version of the studio this is.

        Opaque to nsdeploy: a commit sha, a tag, an archive digest, a timestamp. It
        exists so a build can record what it resolved against and a rebuild can be
        compared against it. Nothing today pins a build to a studio version, which is
        why no build is reproducible.

        :return: The revision, or an empty string when the source cannot tell.
        :raises NotImplementedError: Always; an implementation knows its version.
        """
        raise NotImplementedError

    def list_paths(self) -> List[str]:
        """
        Every file this source holds, as `/`-separated paths relative to its root.

        Resolution matches a logical path against this list, so it has to be complete
        rather than filtered. Implementations are expected to make it cheap — it is
        asked for once per workspace and is the call most likely to cost a network
        round trip or a disk walk.

        :return: The file paths.
        :raises NotImplementedError: Always; an implementation lists its own files.
        :raises OSError: If the files cannot be listed.
        """
        raise NotImplementedError

    def read(self, path: str) -> Optional[bytes]:
        """
        Read one file by the path `list_paths` reported for it.

        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when the source no longer has it.
        :raises NotImplementedError: Always; an implementation reads its own files.
        :raises OSError: If the file exists but cannot be read.
        """
        raise NotImplementedError
