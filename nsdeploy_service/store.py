"""SQLite persistence for organizations and deployment records.

Deployments are long-lived and attributed to an organization, so the directory has to
survive a service restart — the in-memory registry cannot be the source of truth.
Division of labour:

* the **store** is authoritative for *reads* (list, directory, one deployment, log path)
* the **supervisor** owns *processes* and writes through on every state transition

A restart therefore leaves rows behind whose processes are gone. `reconcile_orphans()`
settles them at boot rather than letting the directory advertise dead URLs.

stdlib sqlite3 on purpose: one file, no new dependency, and the write volume here is a
handful of rows per deployment.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

UNATTRIBUTED_NAME = "Unattributed"
RESTART_REASON = "the deployment did not survive a service restart"

SCHEMA = """
CREATE TABLE IF NOT EXISTS organizations (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- Case/whitespace-insensitive uniqueness so a "quick profile" cannot be created
    -- twice as "Acme" and "acme ".
    name_key    TEXT NOT NULL UNIQUE,
    address     TEXT NOT NULL DEFAULT '',
    contact     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL REFERENCES organizations(id),
    name          TEXT NOT NULL,
    status        TEXT NOT NULL,
    url           TEXT,
    port          INTEGER,
    created_at    TEXT NOT NULL,
    ready_at      TEXT,
    stopped_at    TEXT,
    expires_at    TEXT,
    error         TEXT,
    pid           INTEGER,
    network_json  TEXT,
    warnings_json TEXT,
    log_path      TEXT NOT NULL,
    work_dir      TEXT NOT NULL,
    -- The DeployOptions the caller chose. Restart replays them, so a relaunched
    -- deployment keeps its original theme/cruse/ttl instead of silently
    -- falling back to whatever the service defaults happen to be now. A stored
    -- upstream is not replayed: every site uses the service-wide upstream.
    options_json  TEXT,
    hocon_path    TEXT,
    -- Map coordinates as {"x": pct, "y": pct}. Assigned at deploy time and never
    -- recalculated, so adding a deployment cannot rearrange the existing map.
    position_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployments_org ON deployments(org_id);
CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at DESC);
"""

LIVE_STATUSES = ("queued", "building", "ready")

# Columns added after the first release. CREATE TABLE IF NOT EXISTS will not add a
# column to a table that already exists, so an existing database needs them applied
# explicitly. Keep this list append-only and every entry nullable.
ADDED_COLUMNS = (
    ("deployments", "options_json", "TEXT"),
    ("deployments", "hocon_path", "TEXT"),
    # Map coordinates, assigned once at deploy time so pins never move.
    ("deployments", "position_json", "TEXT"),
    # When the operator published this network to the map. NULL means draft: built
    # and testable at its own URL, but deliberately not on the map yet.
    ("deployments", "published_at", "TEXT"),
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def org_name_key(name: str) -> str:
    """
    Normalize an organization name for case- and whitespace-insensitive uniqueness.

    :param name: The organization name.
    :return: The normalized key.
    """
    return " ".join(name.split()).casefold()


class StoreError(RuntimeError):
    """A persistence-level rejection (duplicate org, unknown org)."""


class Store:
    """Thread-safe SQLite access.

    One connection guarded by a lock: the supervisor writes from worker threads via
    asyncio.to_thread while request handlers read from the event loop, and sqlite3
    connections are not safe to share across threads without that guard.
    """

    # How long to keep trying to open the database before giving up. A rolling
    # deployment starts the replacement replica while the outgoing one is still
    # draining, and on an SMB mount (an Azure Files volume) the two cannot hold the
    # file at once — the newcomer gets "unable to open database file" and dies, so
    # the platform keeps the old replica and the rollout never completes. Waiting
    # out the drain turns that deadlock into a slow start-up.
    OPEN_TIMEOUT_SECONDS = 120.0

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = self._open(db_path)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA foreign_keys=ON")
            self._conn.executescript(SCHEMA)
            self._migrate()
            self._conn.commit()

    @classmethod
    def _open(cls, db_path: Path) -> sqlite3.Connection:
        """Connect, and settle on a journal mode the filesystem actually supports.

        WAL keeps a long read (the directory) from blocking a status write, but it
        needs shared memory an SMB mount does not provide, where the PRAGMA fails
        with "database is locked". The rollback journal works there, and one writer
        is this store's assumption either way.

        Both the connect and the first statement are retried: whether a file held by
        another replica reports as unopenable or as locked depends on the mount.
        """
        deadline = time.monotonic() + cls.OPEN_TIMEOUT_SECONDS
        delay = 0.5
        while True:
            try:
                conn = sqlite3.connect(str(db_path), check_same_thread=False)
                try:
                    conn.execute("PRAGMA journal_mode=WAL")
                except sqlite3.OperationalError:
                    conn.execute("PRAGMA journal_mode=DELETE")
                return conn
            except sqlite3.OperationalError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 5.0)

    def _migrate(self) -> None:
        """Add post-release columns to a database created by an earlier version."""
        added = set()
        for table, column, decl in ADDED_COLUMNS:
            existing = {
                row["name"]
                for row in self._conn.execute(f"PRAGMA table_info({table})").fetchall()
            }
            if column not in existing:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
                added.add(column)
        if "published_at" in added:
            self._adopt_existing_as_published()

    def _adopt_existing_as_published(self) -> None:
        """Treat networks that predate the publish gate as already published.

        Done here, at the moment the column is created, because that happens exactly
        once. A start-up backfill would be indistinguishable from "publish every
        draft that happens to be ready", which would defeat the gate on the very
        next restart.

        *Every* pre-existing row is adopted, whatever its status. Before the gate the
        map had no publish filter, so every record was on it — including stopped and
        failed ones, as inert pins. Restricting adoption to `status = 'ready'` looked
        tidier but silently dropped pins: a graceful shutdown writes live records as
        `stopped` before exiting, so on the next start-up the rows to adopt were
        already `stopped` and the predicate matched nothing.
        """
        self._conn.execute(
            "UPDATE deployments SET published_at = COALESCE(ready_at, created_at)"
            " WHERE published_at IS NULL")

    def close(self) -> None:
        """
        Close the database connection.
        """
        with self._lock:
            self._conn.close()

    # --- organizations ----------------------------------------------------
    def create_org(self, name: str, address: str = "", contact: str = "") -> Dict[str, Any]:
        """
        Create an organization.

        :param name: The organization name.
        :param address: The organization address.
        :param contact: The organization contact.
        :return: The new organization row.
        :raises StoreError: If the name is empty or already taken.
        """
        clean = " ".join((name or "").split())
        if not clean:
            raise StoreError("organization name is required")
        if len(clean) > 120:
            raise StoreError("organization name must be 120 characters or fewer")
        row = {
            "id": uuid.uuid4().hex[:12],
            "name": clean,
            "name_key": org_name_key(clean),
            "address": (address or "").strip()[:500],
            "contact": (contact or "").strip()[:200],
            "created_at": _now_iso(),
        }
        with self._lock:
            try:
                self._conn.execute(
                    "INSERT INTO organizations (id, name, name_key, address, contact, created_at)"
                    " VALUES (:id, :name, :name_key, :address, :contact, :created_at)", row)
                self._conn.commit()
            except sqlite3.IntegrityError as exc:
                raise StoreError(f"an organization named {clean!r} already exists") from exc
        return dict(row)

    def get_org(self, org_id: str) -> Optional[Dict[str, Any]]:
        """
        Look up an organization by id.

        :param org_id: The organization id.
        :return: The organization row, or None if it does not exist.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM organizations WHERE id = ?", (org_id,)).fetchone()
        return dict(row) if row else None

    def find_org_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Look up an organization by its normalized name.

        :param name: The organization name.
        :return: The organization row, or None if no organization has that name.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM organizations WHERE name_key = ?",
                (org_name_key(name),)).fetchone()
        return dict(row) if row else None

    def ensure_org(self, name: str, address: str = "", contact: str = "") -> Dict[str, Any]:
        """Get-or-create by name. Used to seed the fallback organization."""
        existing = self.find_org_by_name(name)
        if existing:
            return existing
        try:
            return self.create_org(name, address, contact)
        except StoreError:
            # Lost a race with a concurrent creator; the other one's row is fine.
            existing = self.find_org_by_name(name)
            if existing:
                return existing
            raise

    def list_orgs(self) -> List[Dict[str, Any]]:
        """Every organization, newest first, with live and total deployment counts."""
        placeholders = ",".join("?" * len(LIVE_STATUSES))
        with self._lock:
            rows = self._conn.execute(
                f"""
                SELECT o.*,
                       (SELECT COUNT(*) FROM deployments d WHERE d.org_id = o.id)
                           AS deployment_count,
                       (SELECT COUNT(*) FROM deployments d WHERE d.org_id = o.id
                            AND d.status IN ({placeholders})) AS live_count
                  FROM organizations o
                 ORDER BY o.created_at DESC, o.name ASC
                """, LIVE_STATUSES).fetchall()
        return [dict(row) for row in rows]

    def update_org(self, org_id: str, **fields: str) -> Optional[Dict[str, Any]]:
        """
        Update an organization's name, address or contact.

        :param org_id: The organization id.
        :param fields: The fields to change; None values and unknown keys are ignored.
        :return: The updated organization row, or None if it does not exist.
        :raises StoreError: If the new name is blank or already taken.
        """
        allowed = {k: v for k, v in fields.items()
                   if k in ("name", "address", "contact") and v is not None}
        if not allowed:
            return self.get_org(org_id)
        if "name" in allowed:
            clean = " ".join(allowed["name"].split())
            if not clean:
                raise StoreError("organization name cannot be blank")
            allowed["name"] = clean
            allowed["name_key"] = org_name_key(clean)
        assignments = ", ".join(f"{key} = :{key}" for key in allowed)
        with self._lock:
            try:
                cursor = self._conn.execute(
                    f"UPDATE organizations SET {assignments} WHERE id = :id",
                    {**allowed, "id": org_id})
                self._conn.commit()
            except sqlite3.IntegrityError as exc:
                raise StoreError("another organization already uses that name") from exc
        return self.get_org(org_id) if cursor.rowcount else None

    def delete_org(self, org_id: str) -> bool:
        """Remove an organization. Refuses while it still owns deployment records."""
        with self._lock:
            owned = self._conn.execute(
                "SELECT COUNT(*) AS n FROM deployments WHERE org_id = ?", (org_id,)).fetchone()["n"]
            if owned:
                raise StoreError(
                    f"this organization still owns {owned} deployment record(s); "
                    f"stop and remove them first")
            cursor = self._conn.execute("DELETE FROM organizations WHERE id = ?", (org_id,))
            self._conn.commit()
        return bool(cursor.rowcount)

    # --- deployments ------------------------------------------------------
    # Nullable columns default to None when a caller omits them, so adding another
    # optional column never breaks an existing write path.
    OPTIONAL_COLUMNS = ("url", "port", "ready_at", "stopped_at", "expires_at", "error",
                        "pid", "network_json", "warnings_json", "options_json", "hocon_path",
                        "position_json", "published_at")

    def save_deployment(self, row: Dict[str, Any]) -> None:
        """Insert or replace one deployment record (write-through from the supervisor)."""
        row = {**{column: None for column in self.OPTIONAL_COLUMNS}, **row}
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO deployments
                    (id, org_id, name, status, url, port, created_at, ready_at, stopped_at,
                     expires_at, error, pid, network_json, warnings_json, log_path, work_dir,
                     options_json, hocon_path, position_json, published_at)
                VALUES
                    (:id, :org_id, :name, :status, :url, :port, :created_at, :ready_at,
                     :stopped_at, :expires_at, :error, :pid, :network_json, :warnings_json,
                     :log_path, :work_dir, :options_json, :hocon_path, :position_json,
                     :published_at)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status, url=excluded.url, port=excluded.port,
                    ready_at=excluded.ready_at, stopped_at=excluded.stopped_at,
                    expires_at=excluded.expires_at, error=excluded.error, pid=excluded.pid,
                    network_json=excluded.network_json, warnings_json=excluded.warnings_json,
                    options_json=excluded.options_json, hocon_path=excluded.hocon_path,
                    -- Keep the first position ever assigned; a restart or rebuild must
                    -- not move an existing pin on the map.
                    position_json=COALESCE(deployments.position_json, excluded.position_json)
                    -- published_at is deliberately absent: it is owned by
                    -- set_published(), so a status write-through cannot publish or
                    -- unpublish anything. A restart therefore keeps a network on the
                    -- map instead of demanding it be published again.
                """, row)
            self._conn.commit()

    def get_deployment(self, deployment_id: str) -> Optional[Dict[str, Any]]:
        """
        Look up a deployment by id, including its organization name.

        :param deployment_id: The deployment id.
        :return: The decoded deployment row, or None if it does not exist.
        """
        with self._lock:
            row = self._conn.execute(
                """SELECT d.*, o.name AS org_name FROM deployments d
                     JOIN organizations o ON o.id = d.org_id
                    WHERE d.id = ?""", (deployment_id,)).fetchone()
        return self._decode(row) if row else None

    def list_deployments(self, org_id: Optional[str] = None,
                         status: Optional[str] = None) -> List[Dict[str, Any]]:
        """
        List deployments, optionally filtered by organization and status.

        :param org_id: Restrict to this organization, if given.
        :param status: Restrict to this status, if given.
        :return: The decoded deployment rows.
        """
        clauses, params = [], []
        if org_id:
            clauses.append("d.org_id = ?")
            params.append(org_id)
        if status:
            clauses.append("d.status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._conn.execute(
                f"""SELECT d.*, o.name AS org_name FROM deployments d
                      JOIN organizations o ON o.id = d.org_id
                    {where} ORDER BY d.created_at DESC""", params).fetchall()
        return [self._decode(row) for row in rows]

    def set_position(self, deployment_id: str, position: Dict[str, Any]) -> None:
        """Write a map position unconditionally.

        save_deployment deliberately preserves an existing position; this is the one
        path allowed to set one, used to backfill records created before the column
        existed. Without it those records get a fresh position on every read and the
        map rearranges itself as deployments are added.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE deployments SET position_json = ? WHERE id = ?",
                (json.dumps(position), deployment_id))
            self._conn.commit()

    def set_summary(self, deployment_id: str, network: Dict[str, Any],
                    warnings: List[str]) -> None:
        """Overwrite a record's network summary and warnings.

        save_deployment writes these from the supervisor's in-memory Deployment, which
        does not exist for a record left behind by an earlier run. This is the repair
        path for a summary that was persisted empty: the summary carries the resolved
        outbound links the network map turns into edges, so an empty one hides the
        fact that two deployed networks can reach each other.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE deployments SET network_json = ?, warnings_json = ? WHERE id = ?",
                (json.dumps(network), json.dumps(warnings) if warnings else None,
                 deployment_id))
            self._conn.commit()

    def set_published(self, deployment_id: str, when: Optional[str]) -> None:
        """Publish (a timestamp) or withdraw (None) one network from the map.

        The only writer of `published_at`. save_deployment leaves the column alone so
        that the supervisor's ordinary status write-through — building, ready,
        stopped, restarted — can never change what is published.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE deployments SET published_at = ? WHERE id = ?",
                (when, deployment_id))
            self._conn.commit()

    def deployments_without_position(self) -> List[str]:
        """
        List the ids of deployments that have no map position yet.

        :return: The deployment ids.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT id FROM deployments WHERE position_json IS NULL"
                " ORDER BY created_at ASC").fetchall()
        return [row["id"] for row in rows]

    def delete_deployment(self, deployment_id: str) -> bool:
        """Forget a terminal record. Callers must stop the process first."""
        with self._lock:
            cursor = self._conn.execute("DELETE FROM deployments WHERE id = ?", (deployment_id,))
            self._conn.commit()
        return bool(cursor.rowcount)

    def count_by_status(self) -> Dict[str, int]:
        """
        Count deployments per status.

        :return: A mapping from status to deployment count.
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT status, COUNT(*) AS n FROM deployments GROUP BY status").fetchall()
        return {row["status"]: row["n"] for row in rows}

    def reconcile_orphans(self) -> List[str]:
        """Settle records left mid-flight by a previous run.

        Deployed sites are children of the service process, so a restart has already
        killed them. Any row still claiming queued/building/ready is stale and must not
        keep advertising a URL that answers nothing.
        """
        placeholders = ",".join("?" * len(LIVE_STATUSES))
        now = _now_iso()
        with self._lock:
            rows = self._conn.execute(
                f"SELECT id FROM deployments WHERE status IN ({placeholders})",
                LIVE_STATUSES).fetchall()
            orphans = [row["id"] for row in rows]
            if orphans:
                self._conn.execute(
                    f"""UPDATE deployments
                           SET status='stopped', url=NULL, port=NULL, pid=NULL,
                               stopped_at=?, error=COALESCE(NULLIF(error,''), ?)
                         WHERE status IN ({placeholders})""",
                    (now, RESTART_REASON, *LIVE_STATUSES))
                self._conn.commit()
        return orphans

    @staticmethod
    def _decode(row: sqlite3.Row) -> Dict[str, Any]:
        record = dict(row)
        for field, target in (("network_json", "network"),
                              ("warnings_json", "warnings"),
                              ("options_json", "options"),
                              ("position_json", "position")):
            raw = record.pop(field, None)
            try:
                record[target] = json.loads(raw) if raw else None
            except ValueError:
                record[target] = None
        record["warnings"] = record["warnings"] or []
        return record
