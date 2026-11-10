from dataclasses import dataclass
from dataclasses import field
from typing import List


@dataclass
class BundleResult:
    """One finished static bundle, held in memory.

    The archive is the whole deliverable, so it is the response body. Everything
    else here describes what is in it and travels in response headers instead.

    `sha256` is the digest of the archive, not of the tree. The packer flattens
    ownership, mode and timestamps, so two builds of one network give one digest:
    a client can use it to tell a rebuild from a re-send.
    """

    name: str
    archive: bytes
    files: int
    unpacked_bytes: int
    sha256: str
    warnings: List[str] = field(default_factory=list)
