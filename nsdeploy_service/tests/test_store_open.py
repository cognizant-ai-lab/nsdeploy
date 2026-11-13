"""The store must open a database on a filesystem that refuses WAL, and must wait
out a file another replica is still holding (see Store._open)."""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Callable
from typing import List
from typing import NoReturn
from unittest import mock

from nsdeploy_service.store import Store


class OpenTest(unittest.TestCase):
    """Opens the store on filesystems that refuse WAL or are briefly held by another replica."""
    def setUp(self) -> None:
        self._dir: tempfile.TemporaryDirectory[str]
        self._dir = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up via addCleanup
        self.db: Path = Path(self._dir.name) / "nested" / "service.db"
        self.addCleanup(self._dir.cleanup)

    def test_opens_normally(self) -> None:
        """The store opens and creates the database file."""
        Store(self.db)
        self.assertTrue(self.db.exists())

    def test_falls_back_when_wal_is_refused(self) -> None:
        """An SMB mount rejects journal_mode=WAL; DELETE must be used instead.

        sqlite3.Connection is immutable, so the refusal is injected by wrapping the
        connection rather than by patching its execute.
        """
        seen: List[str] = []
        real_connect: Callable[..., sqlite3.Connection] = sqlite3.connect

        class NoWal:
            """Delegates everything, but refuses WAL the way an SMB mount does."""

            def __init__(self, wrapped: sqlite3.Connection) -> None:
                self._wrapped: sqlite3.Connection = wrapped

            def execute(self, sql: str, *args: Any) -> sqlite3.Cursor:
                """
                Records the statement and refuses WAL, delegating everything else.

                :param sql: The SQL statement to execute.
                :param args: Positional arguments passed through to the wrapped execute.
                :return: The cursor from the wrapped connection.
                :raises sqlite3.OperationalError: When the statement enables WAL.
                """
                seen.append(sql)
                if sql == "PRAGMA journal_mode=WAL":
                    raise sqlite3.OperationalError("database is locked")
                return self._wrapped.execute(sql, *args)

            def __getattr__(self, name: str) -> Any:
                return getattr(self._wrapped, name)

            def __setattr__(self, name: str, value: Any) -> None:
                if name == "_wrapped":
                    object.__setattr__(self, name, value)
                else:
                    setattr(self._wrapped, name, value)

        with mock.patch("sqlite3.connect", lambda *a, **k: NoWal(real_connect(*a, **k))):
            Store(self.db)

        self.assertIn("PRAGMA journal_mode=WAL", seen)
        self.assertIn("PRAGMA journal_mode=DELETE", seen)

    def test_retries_while_another_replica_holds_the_file(self) -> None:
        """The first attempts fail as they do mid-rollout; the open must still succeed."""
        real_connect: Callable[..., sqlite3.Connection] = sqlite3.connect
        attempts: List[int] = []

        def connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
            attempts.append(1)
            if len(attempts) < 3:
                raise sqlite3.OperationalError("unable to open database file")
            return real_connect(*args, **kwargs)

        with mock.patch.object(Store, "OPEN_TIMEOUT_SECONDS", 10.0), \
                mock.patch("sqlite3.connect", connect), \
                mock.patch("time.sleep"):
            Store(self.db)

        self.assertEqual(len(attempts), 3)

    def test_gives_up_once_the_deadline_passes(self) -> None:
        """A permanently unopenable path must raise, not hang forever."""
        def connect(*args: Any, **kwargs: Any) -> NoReturn:
            raise sqlite3.OperationalError("unable to open database file")

        with mock.patch.object(Store, "OPEN_TIMEOUT_SECONDS", 0.0), \
                mock.patch("sqlite3.connect", connect):
            with self.assertRaises(sqlite3.OperationalError):
                Store(self.db)


if __name__ == "__main__":
    unittest.main()
