import hashlib
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import TextIO

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent

# fcntl exists only on POSIX. Without it the listing refresh is not serialized across
# processes, which costs duplicate listing requests rather than correctness.
try:
    import fcntl  # POSIX-only module
except ImportError:  # pragma: no cover - Windows has no fcntl.
    fcntl = None


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

    # Named after the module, so logging configuration that names the module still applies.
    LOGGER: logging.Logger = logging.getLogger(__name__)

    # The file list, and the files, kept apart so that an upstream path can never
    # collide with the cache's own bookkeeping. The lock serializes listing refreshes
    # across processes.
    LISTING_NAME: str = "listing.json"
    LOCK_NAME: str = "listing.lock"
    FILES_DIR: str = "files"

    # How long a file list is used before it is asked for again. A branch moves, and a
    # build has to see a file that was added upstream; an hour keeps that within one
    # working session without making the listing call — the expensive one — routine.
    DEFAULT_TTL_SECONDS: float = 3600.0

    # How long readers use an expired file list without asking again after the source
    # could not be reached. Without it, every build waiting on the lock repeats the
    # failed request, and each one can take the source's full timeout.
    RETRY_DELAY_SECONDS: float = 300.0

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
    def read(self, path: str) -> Optional[bytes]:
        """
        Read one file, from the cache when it is there and from the source otherwise.

        A file the source does not have is not recorded. Remembering an absence would
        mean a file added upstream stayed missing for a build that has the cache, and
        the cost of asking again is one request for a path nothing resolves to.

        A file that cannot be written to the cache is still returned, and a cached file
        that cannot be read is a miss. The cache is an optimization, never the reason a
        read fails.

        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when the source has no such file.
        :raises OSError: If the file cannot be read.
        """
        target: Path = self._file_path(path)
        try:
            return target.read_bytes()
        except FileNotFoundError:
            pass
        except OSError as exception:
            CachedContent.LOGGER.warning("cannot read the cached %s from %s; asking the source: %s",
                                         path, self._cache, exception)
        raw: Optional[bytes] = self._content.read(path)
        if raw is None:
            return None
        try:
            self._write(target, raw)
        except OSError as exception:
            CachedContent.LOGGER.warning("cannot cache %s from %s in %s: %s",
                                         path, self._content.identity(), self._cache, exception)
        return raw

    def _load(self) -> None:
        """
        Make the file list available, from memory, then the cache, then the source.

        Going to the source holds a lock shared with every other reader of this cache,
        and checks the cache again once it has the lock. A burst of builds then makes
        one listing request, not one each.

        :raises OSError: If the source has no list and the cache has none to fall back on.
        """
        if self._paths is not None:
            return
        cached: Optional[Dict[str, Any]] = self._read_listing()
        if self._usable(cached):
            self._accept(cached)
            return
        handle: Optional[TextIO] = self._lock()
        try:
            # Another reader may have refreshed the listing while this one waited.
            cached = self._read_listing()
            if self._usable(cached):
                self._accept(cached)
                return
            self._load_upstream_or_fall_back(cached)
        finally:
            CachedContent._unlock(handle)

    def _load_upstream_or_fall_back(self, cached: Optional[Dict[str, Any]]) -> None:
        """
        Ask the source for the file list, falling back to an older cached one.

        :param cached: The cached listing that is past its age, if any.
        :raises OSError: If the source cannot be listed and there is no cached list.
        """
        if cached is not None:
            # An expired listing has to reach past the source's own memo too, which
            # may be as old as the listing.
            self._content.refresh()
        try:
            self._load_upstream()
        except OSError:
            if cached is None:
                raise
            # The cached list is past its age, and the source cannot be reached. A build
            # from a stale list is better than no build, and every file it names is likely
            # cached too.
            CachedContent.LOGGER.warning("cannot list %s; using the cached file list", self._content.identity(),
                                         exc_info=True)
            self._accept(cached)
            self._write_listing(float(cached.get("written") or 0.0), time.time() + CachedContent.RETRY_DELAY_SECONDS)

    def _usable(self, cached: Optional[Dict[str, Any]]) -> bool:
        """
        Report whether a cached listing answers without asking the source.

        An expired listing still answers while a recent failure to reach the source
        asks readers to wait before trying again.

        :param cached: The cached listing, if any.
        :return: True when it exists and it is within its age or a retry is not yet due.
        """
        if cached is None:
            return False
        now: float = time.time()
        # The age is read from the listing itself, so it always belongs to these paths.
        written: float = float(cached.get("written") or 0.0)
        retry_after: float = float(cached.get("retry_after") or 0.0)
        return (now - written) < self._ttl or now < retry_after

    def _lock(self) -> Optional[TextIO]:
        """
        Take the lock that serializes listing refreshes across processes.

        :return: The open lock file, or None when the lock is not available.
        """
        if fcntl is None:
            return None
        handle: Optional[TextIO] = None
        try:
            self._cache.mkdir(parents=True, exist_ok=True)
            handle = (self._cache / CachedContent.LOCK_NAME).open("a+", encoding="utf-8")
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except OSError as exception:
            # A read-only cache cannot be locked. Refreshing unlocked costs at most a
            # duplicate request.
            CachedContent.LOGGER.warning("cannot lock the cache %s: %s", self._cache, exception)
            if handle is not None:
                handle.close()
            return None
        return handle

    @staticmethod
    def _unlock(handle: Optional[TextIO]) -> None:
        """
        Release the listing lock. Closing the file releases it.

        :param handle: The open lock file, or None when no lock was taken.
        """
        if handle is not None:
            handle.close()

    def _load_upstream(self) -> None:
        """
        Ask the source for the file list and keep it.

        :raises OSError: If the source cannot be listed.
        """
        paths: List[str] = self._content.list_paths()
        self._revision = self._content.revision()
        self._paths = paths
        self._write_listing(time.time(), 0.0)

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

    def _write_listing(self, written: float, retry_after: float) -> None:
        """
        Keep the file list for the next reader, including the next process.

        :param written: When the source gave this list.
        :param retry_after: Until when readers use this list even past its age; 0 for none.
        """
        body: Dict[str, Any] = {"identity": self._content.identity(),
                                "revision": self._revision,
                                "written": written,
                                "retry_after": retry_after,
                                "paths": self._paths if self._paths is not None else []}
        raw: bytes = json.dumps(body).encode("utf-8")
        try:
            self._write(self._cache / CachedContent.LISTING_NAME, raw)
        except OSError as exception:
            # A cache that cannot be written is a slow source, not a broken one.
            CachedContent.LOGGER.warning("cannot cache the file list of %s in %s: %s",
                                         self._content.identity(), self._cache, exception)

    def _file_path(self, path: str) -> Path:
        """
        Where one file of the source is kept in the cache.

        Keyed by a digest of the path rather than by the path itself. A repository can
        replace a file `assets` with a directory `assets/` between revisions, and files
        are kept indefinitely; a flat key cannot collide that way, and cannot leave
        the cache directory whatever the path holds.

        :param path: A path exactly as `list_paths` returned it.
        :return: The cache path.
        """
        digest: str = hashlib.sha256(path.encode("utf-8")).hexdigest()
        return self._cache / CachedContent.FILES_DIR / digest

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
