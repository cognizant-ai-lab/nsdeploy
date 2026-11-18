import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent


class CachedContent(ToolboxContent):
    """Another `ToolboxContent`, answered from a directory on disk where it can be.

    Wraps a source that is expensive to read — a repository over the network, an
    archive — and keeps what it returns in a cache directory. The point is the second
    reader: nsdeploy builds run in separate processes, and a cache held in memory
    helps none of them. A build that finds every file it needs in the cache makes no
    upstream request at all.

    **Do not wrap a checkout.** A local studio is meant to show an edit to the next
    build, and that is exactly the property this class removes. It is for a source
    whose content does not change under a given identity: a repository at a commit, a
    release archive. A repository at a branch is the awkward middle case, which is why
    the file list expires and the files do not — a build must see a file that was
    added upstream, and a file that was edited in place under the same name is the
    price of not asking for every file every time.

    **The cache directory belongs to one source.** Two sources sharing one directory
    would answer each other's reads. The file list records the identity that wrote it
    and is ignored when it does not match, so the mistake shows up as a slow build
    rather than as the wrong files; the files themselves cannot be checked that way.
    """

    # The file list, and the files, kept apart so that an upstream path can never
    # collide with the cache's own bookkeeping.
    LISTING_NAME: str = "listing.json"
    FILES_DIR: str = "files"

    # How long a file list is used before it is asked for again. A branch moves, and a
    # build has to see a file that was added upstream; an hour keeps that within one
    # working session without making the listing call — the expensive one — routine.
    DEFAULT_TTL_SECONDS: float = 3600.0

    def __init__(self, content: ToolboxContent, cache_dir: Path,
                 ttl_seconds: float = DEFAULT_TTL_SECONDS) -> None:
        """
        Answer from `cache_dir` where possible, and from `content` otherwise.

        :param content: The source to read when the cache cannot answer.
        :param cache_dir: The directory this source's content is kept in.
        :param ttl_seconds: How long a cached file list is used before it is refreshed.
        """
        self._content: ToolboxContent = content
        self._cache: Path = Path(cache_dir)
        self._ttl: float = float(ttl_seconds)
        self._paths: Optional[List[str]] = None
        self._revision: str = ""
        self._forced: bool = False

    @override
    def identity(self) -> str:
        """
        Name the source behind this cache.

        The cache is not part of the identity: a reader needs to know where a missing
        file was looked for, not where it was not kept.

        :return: The wrapped source's identity.
        """
        return self._content.identity()

    @override
    def revision(self) -> str:
        """
        Report the version the cached file list was taken at.

        :return: The revision, or an empty string when the source cannot tell.
        :raises OSError: If the file list cannot be read.
        """
        self._load()
        return self._revision

    @override
    def list_paths(self) -> List[str]:
        """
        Every file the source holds, from the cache while the cached list is fresh.

        :return: The file paths.
        :raises OSError: If the file list cannot be read.
        """
        self._load()
        paths: List[str] = self._paths if self._paths is not None else []
        # A copy, so a caller that keeps the list cannot change what is cached here.
        return list(paths)

    @override
    def refresh(self) -> None:
        """
        Forget the file list, and ask the wrapped source to forget its own.

        A forced refresh has to reach every layer. Clearing only what this object holds
        would leave the cached listing on disk, and the next reader — in this process
        or the next one — would answer from it until the time to live expired, which is
        the one thing `force` exists to override.

        The cached listing is kept rather than deleted, so that a refresh against a
        source that cannot be reached still falls back to it instead of failing a build
        that would otherwise have worked.

        Cached files are left alone. Each is keyed by the path the source reported, and
        a refreshed listing either names that path again or stops naming it, so a file
        that is no longer part of the toolbox becomes unreachable rather than wrong.
        """
        self._paths = None
        self._revision = ""
        self._forced = True
        self._content.refresh()

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        Read one file, from the cache when it is there and from the source otherwise.

        A file the source does not have is not recorded. Remembering an absence would
        mean a file added upstream stayed missing for a build that has the cache, and
        the cost of asking again is one request for a path nothing resolves to.

        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when the source has no such file.
        :raises OSError: If the file cannot be read.
        """
        target: Optional[Path] = self._file_path(path)
        if target is not None and target.is_file():
            return target.read_bytes()
        raw: Optional[bytes] = self._content.read(path)
        if raw is None:
            return None
        if target is not None:
            self._write(target, raw)
        return raw

    def _load(self) -> None:
        """
        Make the file list available, from memory, then the cache, then the source.

        :raises OSError: If the source has no list and the cache has none to fall back on.
        """
        if self._paths is not None:
            return
        cached: Optional[Dict[str, Any]] = self._read_listing()
        if cached is not None and not self._forced and not self._is_stale():
            self._accept(cached)
            return
        try:
            self._load_upstream()
        except OSError:
            if cached is None:
                raise
            # The cached list is past its age, or a refresh was asked for, and the
            # source cannot be reached. A build from a stale list is better than no
            # build, and every file it names is likely cached too.
            self._accept(cached)
        # Asked for once. A later question in this process reads what was just loaded.
        self._forced = False

    def _load_upstream(self) -> None:
        """
        Ask the source for the file list and keep it.

        :raises OSError: If the source cannot be listed.
        """
        paths: List[str] = self._content.list_paths()
        self._revision = self._content.revision()
        self._paths = paths
        self._write_listing()

    def _accept(self, listing: Dict[str, Any]) -> None:
        """
        Take a cached file list as this source's answer.

        :param listing: The parsed listing file.
        """
        found: List[str] = []
        # One entry per cached path, each of which has to be a string to be asked for.
        for entry in listing.get("paths", []):
            if isinstance(entry, str):
                found.append(entry)
        self._paths = found
        self._revision = str(listing.get("revision") or "")

    def _read_listing(self) -> Optional[Dict[str, Any]]:
        """
        Read the cached file list, if one was written by this same source.

        :return: The parsed listing, or None when there is no usable one.
        """
        listing: Path = self._cache / CachedContent.LISTING_NAME
        try:
            parsed: Any = json.loads(listing.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # No listing, or one left half-written by an older version. Either way the
            # source is asked, which is the same thing a cold cache does.
            return None
        if not isinstance(parsed, dict):
            return None
        if parsed.get("identity") != self._content.identity():
            return None
        return parsed

    def _write_listing(self) -> None:
        """
        Keep the file list for the next reader, including the next process.
        """
        body: Dict[str, Any] = {"identity": self._content.identity(),
                                "revision": self._revision,
                                "paths": self._paths if self._paths is not None else []}
        raw: bytes = json.dumps(body).encode("utf-8")
        try:
            self._write(self._cache / CachedContent.LISTING_NAME, raw)
        except OSError:
            # A cache that cannot be written is a slow source, not a broken one.
            pass

    def _is_stale(self) -> bool:
        """
        Report whether the cached file list is older than the time to live.

        :return: True when the list should be asked for again.
        """
        listing: Path = self._cache / CachedContent.LISTING_NAME
        try:
            written: float = listing.stat().st_mtime
        except OSError:
            return True
        return (time.time() - written) > self._ttl

    def _file_path(self, path: str) -> Optional[Path]:
        """
        Where one file of the source is kept in the cache.

        :param path: A path exactly as `list_paths` returned it.
        :return: The cache path, or None when it would leave the cache directory.
        """
        root: Path = self._cache / CachedContent.FILES_DIR
        target: Path = root / path
        try:
            if not target.resolve().is_relative_to(root.resolve()):
                return None
        except OSError:
            return None
        return target

    @staticmethod
    def _write(target: Path, raw: bytes) -> None:
        """
        Write a cache file so that no reader ever sees it half-written.

        Builds share a cache and run at the same time, so a plain write could be read
        by another build mid-way through. The replace is atomic, and the temporary name
        is unique per writer, so two builds caching one file cannot replace each
        other's partial copy.

        :param target: Where the file belongs.
        :param raw: The bytes to write.
        :raises OSError: If the file cannot be written.
        """
        target.parent.mkdir(parents=True, exist_ok=True)
        handle, partial = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(raw)
            os.replace(partial, target)
        except OSError:
            Path(partial).unlink(missing_ok=True)
            raise
