"""Port allocation for deployed sites.

A deployed nsdeploy site owns a whole port: launcher.serve() binds its own
ThreadingHTTPServer and every generated URL is root-absolute (/_mcp/<i>/mcp, /v1,
/byok/v1, /mcp, /runtime/*), so sites cannot be multiplexed behind one listener on
a path prefix. The service therefore hands each deployment a dedicated port.
"""
from __future__ import annotations

import socket
import threading
from typing import Optional, Set


class PortPoolExhausted(RuntimeError):
    """No port in the configured range is both unreserved and actually free."""


class PortPool:
    """Reserve ports from a fixed range, skipping any the OS says are in use.

    Reservation is deliberately coarse: a port stays reserved from the moment a
    deployment is accepted until its process tree is confirmed gone. nsdeploy's own
    _free_tcp_port() picks the *private* ports for tool/facade subprocesses; this
    pool only governs the public site port.
    """

    def __init__(self, start: int, end: int, host: str = "127.0.0.1") -> None:
        if end < start:
            raise ValueError("end must be >= start")
        self._start = start
        self._end = end
        self._host = host
        self._reserved: Set[int] = set()
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        """
        Return the number of ports in the pool.

        :return: The pool size.
        """
        return self._end - self._start + 1

    def _is_free(self, port: int) -> bool:
        """True when nothing is listening on the port right now.

        SO_REUSEADDR must NOT be set on this probe. On Windows that flag lets a
        socket bind a port another socket is already listening on (it behaves like
        POSIX SO_REUSEPORT), so the probe succeeded unconditionally and the pool
        handed out ports that were still in use. The readiness check then got its
        HTTP 200 from the *previous* occupant and marked a deployment ready before
        nsdeploy had generated its bundle, which persisted an empty network summary.
        A plain bind is the portable "is anyone listening" test.

        This is advisory only — a race with an unrelated process is still possible
        between the check and nsdeploy's own bind. The caller surfaces that as a
        build failure, which is recoverable (retry gets a different port).
        """
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((self._host, port))
                probe.listen(1)
            except OSError:
                return False
        return True

    def reserve(self, preferred: Optional[int] = None) -> int:
        """Reserve a port, taking `preferred` when it is in range and actually free.

        Restart passes the deployment's previous port. The site's public origin is
        baked into the generated bundle, so reusing the port keeps the URL — and any
        bookmark or linked peer pointing at it — valid across a relaunch. It is a
        preference, not a guarantee: if something else took the port meanwhile, any
        free port is better than failing the restart.
        """
        with self._lock:
            candidates = range(self._start, self._end + 1)
            if preferred is not None and self._start <= preferred <= self._end:
                candidates = [preferred, *(p for p in candidates if p != preferred)]
            for port in candidates:
                if port in self._reserved:
                    continue
                if not self._is_free(port):
                    continue
                self._reserved.add(port)
                return port
        raise PortPoolExhausted(
            f"no free port in {self._start}-{self._end}; stop an existing deployment first"
        )

    def release(self, port: int) -> None:
        """
        Return a reserved port to the pool.

        :param port: The port to release.
        """
        with self._lock:
            self._reserved.discard(port)

    def reserved(self) -> Set[int]:
        """
        Return a snapshot of the currently reserved ports.

        :return: A copy of the reserved port set.
        """
        with self._lock:
            return set(self._reserved)
