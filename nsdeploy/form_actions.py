"""Public, data-only configuration for runtime form discovery."""
from typing import Any
from typing import Dict
from typing import Iterable
from typing import Optional
from urllib.parse import SplitResult
from urllib.parse import urlsplit


def action_discovery_config(pages: Optional[Iterable[str]] = None, modules: Optional[Iterable[str]] = None,
                            callers: Optional[Iterable[str]] = None, host_page: bool = False,
                            discovered: bool = False) -> Dict[str, Any]:
    """
    Build the data-only action discovery configuration for a deployment.

    :param pages: Origin-relative action page paths.
    :param modules: Origin-relative JavaScript action module paths.
    :param callers: Exact HTTP(S) origins allowed to call the action pages.
    :param host_page: Whether the host page itself exposes actions.
    :param discovered: Whether actions were discovered at runtime.
    :return: The discovery configuration, or an empty dict when nothing is configured.
    :raises ValueError: If a path or caller origin is malformed, or callers are given without pages.
    """
    pages, modules, callers = list(pages or []), list(modules or []), list(callers or [])
    path: str
    for path in pages + modules:
        # Origin-relative paths keep bundles portable and cannot point discovery
        # at a third-party application the publisher does not control.
        url: SplitResult = urlsplit(path)
        # pylint: disable-next=too-many-boolean-expressions  # flat validation list
        if (not path.startswith("/") or path.startswith("//") or "\\" in path
                or url.scheme or url.netloc or url.fragment):
            raise ValueError("Action pages/modules require origin-relative paths such as /booking.")
    caller: str
    for caller in callers:
        url = urlsplit(caller)
        # pylint: disable-next=too-many-boolean-expressions  # flat validation list
        if (url.scheme not in ("http", "https") or not url.netloc or url.username or url.password
                or url.path or url.query or url.fragment):
            raise ValueError("Action callers must be exact HTTP(S) origins without paths.")
    if callers and not pages and not discovered:
        raise ValueError("--action-caller-origin requires --action-page; JavaScript modules declare their own policy.")
    if not pages and not modules and not host_page and not discovered:
        return {}
    return {"pages": list(dict.fromkeys(pages)), "hostPage": bool(host_page), "modules": list(dict.fromkeys(modules)),
            "callerOrigins": list(dict.fromkeys(callers))}
