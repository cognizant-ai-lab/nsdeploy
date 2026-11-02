"""Public, data-only configuration for runtime form discovery."""
from urllib.parse import urlsplit


def action_discovery_config(pages=None, modules=None, callers=None, host_page=False):
    pages, modules, callers = list(pages or []), list(modules or []), list(callers or [])
    for path in pages + modules:
        # Origin-relative paths keep bundles portable and cannot point discovery
        # at a third-party application the publisher does not control.
        url = urlsplit(path)
        if not path.startswith("/") or path.startswith("//") or "\\" in path or url.scheme or url.netloc or url.fragment:
            raise ValueError("Action pages/modules require origin-relative paths such as /booking.")
    for caller in callers:
        url = urlsplit(caller)
        if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or url.path or url.query or url.fragment:
            raise ValueError("Action callers must be exact HTTP(S) origins without paths.")
    if callers and not pages:
        raise ValueError("--action-caller-origin requires --action-page; JavaScript modules declare their own policy.")
    if not pages and not modules and not host_page:
        return {}
    return {"pages": list(dict.fromkeys(pages)), "hostPage": bool(host_page), "modules": list(dict.fromkeys(modules)),
            "callerOrigins": list(dict.fromkeys(callers))}
