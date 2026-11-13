"""Give OpenSSL a CA bundle when the interpreter does not ship one.

Owned by nsdeploy_service, not nsdeploy. The service must work when dropped into an
unmodified nsdeploy of any version, so it cannot rely on a patch living over there.
`_bootstrap/sitecustomize.py` applies this to every `python -m nsdeploy` child the
supervisor spawns — and to their own MCP-host and facade grandchildren, which
inherit PYTHONPATH — so nothing in nsdeploy needs to change.

Some Python builds — notably the python.org Windows installers — carry no OpenSSL
certificate store, so `ssl.get_default_verify_paths()` returns no `cafile` and
*every* HTTPS request fails with CERTIFICATE_VERIFY_FAILED even against a
perfectly valid certificate. The error names certificates, which sends people
looking for a proxy problem that isn't there; the actual fault is that nothing
told Python where its trust store lives.

A build reaches the network from several places — the GitHub studio source,
deploy-time theming, peer manifests, the BYOK proxy, the relation model — so the
trust store is configured once per process instead of at each call site.

**This is applied in-process, not through the environment.** Setting
`SSL_CERT_FILE` looks tidier and is inherited by subprocesses, which is exactly the
problem: a hosted coded tool may carry its own TLS stack. `ddgs_search` pulls in
`primp`, a Rust/reqwest client that reads `SSL_CERT_FILE` and then trusts *only*
that file instead of its own root store — so exporting certifi's bundle to fix
Python's urllib made every search fail with "invalid peer certificate:
UnknownIssuer". Patching Python's own SSL defaults fixes the Python callers and
leaves every other stack alone. Each Python entry point calls this for itself;
nothing is inherited.

An operator's own configuration always wins. If `SSL_CERT_FILE`/`SSL_CERT_DIR` is
already set, or the interpreter has a store that exists, nothing changes — which
matters behind a TLS-inspecting proxy, where the corporate root is the only CA
that will work and silently substituting certifi's bundle would break every
request instead of fixing one.
"""
from __future__ import annotations

import os
import ssl
from pathlib import Path
from typing import Any
from typing import Callable
from typing import Optional

# Optional dependencies: each fallback is skipped when its package is absent.
try:
    import truststore
except ImportError:
    truststore = None
try:
    import certifi
except ImportError:
    certifi = None

# Set once per process; the value is also the "already done" flag.
_installed: Optional[str] = None  # pylint: disable=invalid-name; mutable process state, not a constant


def has_usable_store() -> bool:
    """Whether OpenSSL already has a certificate file or directory that exists.

    The path being *set* is not enough: Windows builds commonly report a
    build-time Unix path such as /usr/local/ssl/cert.pem that was never shipped.
    """
    paths: ssl.DefaultVerifyPaths = ssl.get_default_verify_paths()
    return any(candidate and Path(candidate).exists()
               for candidate in (paths.cafile, paths.capath))


def _install_python_default(bundle: str) -> None:
    """Make `bundle` the default trust store for this Python process only.

    Both seams are needed. `ssl._create_default_https_context` is what urllib uses,
    and `ssl.create_default_context` is what httpx and most libraries call directly.
    An explicit `cafile`/`capath`/`cadata` from the caller is passed through
    untouched — only the "no opinion" case is filled in.
    """
    original: Callable[..., ssl.SSLContext] = ssl.create_default_context

    def create_default_context(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        if not (kwargs.get("cafile") or kwargs.get("capath") or kwargs.get("cadata")):
            kwargs["cafile"] = bundle
        return original(*args, **kwargs)

    ssl.create_default_context = create_default_context  # type: ignore[assignment]
    # pylint: disable-next=protected-access  # urllib reads this private seam
    ssl._create_default_https_context = create_default_context  # type: ignore[assignment]


def _try_os_trust_store() -> Optional[str]:
    """Route Python's TLS verification through the operating system's trust store.

    Preferred over certifi because it is the only option that works behind TLS
    inspection. A corporate proxy (Zscaler, Netskope, and friends) re-signs traffic
    with its own root, which is installed in the OS store on a managed machine and
    is, by design, absent from certifi's public bundle — so certifi verifies an
    untouched host and fails on an intercepted one. Interception is commonly
    selective, which makes the failure look host-specific and baffling: on this
    project's own machine api.github.com is untouched while api.openai.com is
    re-signed, so GitHub fetches succeeded and every LLM call failed.
    """
    if truststore is None:
        return None
    try:
        truststore.inject_into_ssl()
    except Exception:  # pylint: disable=broad-exception-caught; any failure falls back to certifi
        return None
    return "the operating system trust store"


def _try_certifi() -> Optional[str]:
    """Fall back to certifi's public roots. Enough for an un-inspected network."""
    if certifi is None:
        return None
    bundle: str = certifi.where()
    if not Path(bundle).is_file():
        return None
    _install_python_default(bundle)
    return bundle


def ensure_ca_bundle() -> Optional[str]:
    """Give this process a working TLS trust store if it has none.

    Returns a short description of what was installed, else None (already
    configured, already working, or nothing available). Idempotent and safe to call
    from every entry point — and it must be called by each of them, because nothing
    here is inherited by a subprocess. That is deliberate: see the module docstring
    on `primp`.
    """
    global _installed  # pylint: disable=global-statement; process-wide idempotence flag
    if _installed:
        return _installed
    if os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR"):
        return None  # an operator or a parent process already chose
    if has_usable_store():
        return None
    # OS store first: it carries the public roots *and* any corporate root, so it
    # is a superset of certifi for this purpose.
    _installed = _try_os_trust_store() or _try_certifi()
    return _installed


def describe_tls_failure(url: str, reason: object) -> str:
    """Actionable text for a certificate verification failure.

    By the time this is reached a bundle has already been configured if one could
    be, so the remaining causes are a real trust problem — usually an inspecting
    proxy — not missing configuration.
    """
    return (
        f"cannot verify the TLS certificate for {url}: {reason}. "
        "the service already routes verification through the OS trust store (or "
        "certifi) when the interpreter has none, so this is a genuine trust "
        "failure. If a proxy re-signs your traffic, install its root CA in the OS "
        "store or point SSL_CERT_FILE at it; `pip install truststore` lets Python "
        "use the OS store directly. Or pass --studio <checkout> (service: "
        "NSDEPLOY_SERVICE_STUDIO) to build without reaching the network."
    )
