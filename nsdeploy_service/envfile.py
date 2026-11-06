"""Read/write the `.env` file that stores locally-configured credentials.

Lives at REPO_ROOT/.env — sibling to the nsdeploy checkout, one level above this
package — so it holds both this service's own token (NSDEPLOY_SERVICE_API_TOKEN)
and provider keys nsdeploy itself reads at deploy time (OPENAI_API_KEY). Nothing
here executes .env as shell or via a third-party loader: it is a flat KEY=VALUE
file this module owns end to end, written by POST /settings and picked up by
`load_into_environ()` at process start.

Three locations, in order — see `_resolve_env_path()`. The packaged fallback inside
this directory exists for containers: the Dockerfile already COPYs this package
wholesale, so a `.env` dropped here ships with no extra build step and no container
env var, which is the only credential channel some private deployments have.
NSDEPLOY_SERVICE_ENV_FILE overrides both and is the right answer when a mounted
volume is available, since it is also the only way the writes POST /settings makes
survive a container restart.

Two things write this file: the host's own POST /settings, and the admin panel when
a default credential changes (adminPanel/effects.py). Both go through
`write_env_values`, which merges rather than rewrites, so neither clobbers the
other's lines.
"""
from __future__ import annotations

import os
from pathlib import Path

from nsdeploy_service.config import REPO_ROOT
from nsdeploy_service.config import SERVICE_ROOT


def env_path() -> Path:
    """Where credentials are read from, and where a save writes.

    1. NSDEPLOY_SERVICE_ENV_FILE, if set — always wins, and is the only one that can
       point outside the image at a mounted volume.
    2. REPO_ROOT/.env — the documented location, preferred when it exists so an
       existing checkout keeps behaving exactly as before.
    3. SERVICE_ROOT/.env — inside this package. Rides along with the Dockerfile's
       existing `COPY nsdeploy_service`, needing no Dockerfile edit.

    Only an existing file is selected. With none present the repo-root path is
    returned anyway, so a first save creates it where the docs say it lives rather
    than burying it in the package.

    Resolved per call rather than once at import. The override is then honoured even
    when it is set after this module is first imported — which is what lets a test
    point it at a temporary file instead of writing the real credentials.
    """
    override = os.environ.get("NSDEPLOY_SERVICE_ENV_FILE", "").strip()
    if override:
        return Path(override)
    root = REPO_ROOT / ".env"
    if root.is_file():
        return root
    packaged = SERVICE_ROOT / ".env"
    if packaged.is_file():
        return packaged
    return root


def read_env_file() -> dict[str, str]:
    """Parse env_path() into a dict. A missing file is empty, not an error."""
    try:
        text = env_path().read_text(encoding="utf-8")
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        values[key.strip()] = value.strip().strip('"')
    return values


def load_into_environ() -> None:
    """Seed os.environ from the file for keys not already set.

    `setdefault` rather than overwrite: a real environment variable (from the shell,
    a container, or a process manager) must win over a stale file, the same
    precedence config.py already gives NSDEPLOY_SERVICE_* elsewhere.
    """
    for key, value in read_env_file().items():
        os.environ.setdefault(key, value)


def write_env_values(updates: dict[str, str]) -> None:
    """Merge `updates` into env_path(), preserving every other line untouched.

    An existing `KEY=...` line is replaced in place, so hand-added comments and
    unrelated settings keep their position; unmatched keys are appended at the end.
    That merge is what lets the host's POST /settings and the admin panel both own
    part of the same file without either dropping the other's keys.
    """
    path = env_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []

    remaining = dict(updates)
    out = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.partition("=")[0].strip()
            if key in remaining:
                out.append(f"{key}={remaining.pop(key)}")
                continue
        out.append(line)
    for key, value in remaining.items():
        out.append(f"{key}={value}")

    # REPO_ROOT always exists, but an NSDEPLOY_SERVICE_ENV_FILE pointing into a
    # volume may name a directory nothing has created yet.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    # Best-effort: a secret-bearing file should not be world-readable, but an
    # unsupported chmod (e.g. some network filesystems) must not fail the save.
    try:
        path.chmod(0o600)
    except OSError:
        pass


def mask(value: str) -> str:
    """Everything but the last 4 characters, so a value can be shown without being read."""
    value = value or ""
    if len(value) <= 4:
        return "•" * len(value)
    return "•" * (len(value) - 4) + value[-4:]
