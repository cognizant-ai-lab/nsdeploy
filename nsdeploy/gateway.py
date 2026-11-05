"""Host-based gateway for exposing many nsdeploy sites through one TCP port."""
from __future__ import annotations

import argparse
import http
import http.client
import json
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Iterable, Mapping


GATEWAY_TIMEOUT_SECONDS = 480
_HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
}
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")  # RFC 9110 token
_CTL_RE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")  # control characters except HTAB


def network_slug(network: str) -> str:
    """Return a stable DNS label for an agent-network name."""
    slug = re.sub(r"[^a-z0-9-]+", "-", network.strip().lower().replace("_", "-"))
    slug = re.sub(r"-+", "-", slug).strip("-")
    if not _DNS_LABEL_RE.fullmatch(slug):
        raise ValueError(f"network name cannot be converted to a DNS label: {network!r}")
    return slug


def normalize_base_domain(base_domain: str) -> str:
    domain = base_domain.strip().lower().rstrip(".")
    if "://" in domain or "/" in domain or ":" in domain:
        raise ValueError("base domain must be a hostname without a scheme, path, or port")
    labels = domain.split(".")
    if not domain or any(not _DNS_LABEL_RE.fullmatch(label) for label in labels):
        raise ValueError(f"invalid base domain: {base_domain!r}")
    return domain


def public_origin(network: str, base_domain: str, *, scheme: str = "http",
                  port: int | None = None) -> str:
    scheme = scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError("public scheme must be http or https")
    host = f"{network_slug(network)}.{normalize_base_domain(base_domain)}"
    default_port = 80 if scheme == "http" else 443
    suffix = f":{port}" if port is not None and port != default_port else ""
    return f"{scheme}://{host}{suffix}"


def parse_routes(values: Iterable[str]) -> Dict[str, str]:
    """Parse repeated NETWORK=http(s)://backend route assignments."""
    routes: Dict[str, str] = {}
    owners: Dict[str, str] = {}
    for value in values:
        network, separator, target = value.partition("=")
        if not separator or not network.strip() or not target.strip():
            raise ValueError(f"route must be NETWORK=http(s)://backend, got: {value}")
        network = network.strip()
        slug = network_slug(network)
        if slug in owners and owners[slug] != network:
            raise ValueError(
                f"network names {owners[slug]!r} and {network!r} both map to subdomain {slug!r}"
            )
        parsed = urllib.parse.urlsplit(target.strip())
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError(f"route backend must be an http(s) origin, got: {target}")
        if parsed.path not in {"", "/"}:
            raise ValueError(f"route backend must not contain a path, got: {target}")
        owners[slug] = network
        routes[slug] = target.strip().rstrip("/")
    if not routes:
        raise ValueError("at least one --route is required")
    return routes


def _safe_reason(status: int, reason: str | None) -> str:
    """Return a backend reason phrase that cannot split the status line."""
    if reason and not _CTL_RE.search(reason):
        return reason
    try:
        return http.HTTPStatus(status).phrase
    except ValueError:
        return ""


def _safe_header(name: str, value: str) -> tuple[str, str] | None:
    """Return a CR/LF-free backend header, or None if it cannot be forwarded safely."""
    if not _HEADER_NAME_RE.fullmatch(name):
        return None
    # Unfold obsolete line folding (RFC 9112 section 5.2) into a single space.
    value = re.sub(r"\r?\n[ \t]+", " ", value).strip()
    if _CTL_RE.search(value):
        return None
    return name, value


def make_gateway_handler(base_domain: str, routes: Mapping[str, str]):
    domain = normalize_base_domain(base_domain)
    route_map = dict(routes)

    class GatewayHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_GET(self):
            self._proxy()

        def do_HEAD(self):
            self._proxy()

        def do_POST(self):
            self._proxy()

        def do_PUT(self):
            self._proxy()

        def do_PATCH(self):
            self._proxy()

        def do_DELETE(self):
            self._proxy()

        def do_OPTIONS(self):
            self._proxy()

        def _send_json(self, status: int, value: dict) -> None:
            body = json.dumps(value).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _route(self) -> str | None:
            raw_host = self.headers.get("Host", "")
            try:
                host = urllib.parse.urlsplit(f"//{raw_host}").hostname or ""
            except ValueError:
                return None
            suffix = f".{domain}"
            if not host.lower().endswith(suffix):
                return None
            slug = host.lower()[:-len(suffix)]
            return route_map.get(slug)

        def _proxy(self) -> None:
            if self.path.split("?", 1)[0] == "/_nsdeploy/gateway/health":
                return self._send_json(200, {"status": "ok", "routes": len(route_map)})
            target = self._route()
            if target is None:
                return self._send_json(404, {"error": "unknown nsdeploy subdomain"})

            parsed = urllib.parse.urlsplit(target)
            connection_cls = (http.client.HTTPSConnection
                              if parsed.scheme == "https" else http.client.HTTPConnection)
            connection = connection_cls(parsed.hostname, parsed.port,
                                        timeout=GATEWAY_TIMEOUT_SECONDS)
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else None
            headers = {
                name: value for name, value in self.headers.items()
                if name.lower() not in _HOP_BY_HOP_HEADERS
            }
            original_host = self.headers.get("Host", "")
            headers["Host"] = original_host
            headers["X-Forwarded-Host"] = original_host
            headers["X-Forwarded-Proto"] = self.headers.get("X-Forwarded-Proto", "http")
            peer = self.client_address[0]
            prior = self.headers.get("X-Forwarded-For")
            headers["X-Forwarded-For"] = f"{prior}, {peer}" if prior else peer
            response_started = False
            try:
                connection.request(self.command, self.path, body=body, headers=headers)
                response = connection.getresponse()
                self.send_response(response.status,
                                   _safe_reason(response.status, response.reason))
                response_started = True
                has_length = False
                for name, value in response.getheaders():
                    lower = name.lower()
                    if lower in _HOP_BY_HOP_HEADERS:
                        continue
                    safe = _safe_header(name, value)
                    if safe is None:
                        continue
                    has_length = has_length or lower == "content-length"
                    self.send_header(*safe)
                if not has_length:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                if self.command != "HEAD":
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except (OSError, http.client.HTTPException) as exc:
                if not response_started and not self.wfile.closed:
                    try:
                        self._send_json(502, {"error": f"nsdeploy backend unavailable: {exc}"})
                    except (BrokenPipeError, ConnectionError):
                        pass
                else:
                    self.close_connection = True
            finally:
                connection.close()

    return GatewayHandler


def run_gateway_command(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="nsdeploy gateway",
        description="Expose multiple loopback nsdeploy sites through one host-routed port.",
    )
    parser.add_argument("--base-domain", required=True,
                        help="shared domain suffix, for example agents.example.com or localhost")
    parser.add_argument("--route", action="append", default=[], metavar="NETWORK=URL",
                        help="network and loopback backend origin (repeatable)")
    parser.add_argument("--bind", default="127.0.0.1", help="listen address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="single gateway port (default 8080)")
    args = parser.parse_args(argv)
    try:
        domain = normalize_base_domain(args.base_domain)
        routes = parse_routes(args.route)
    except ValueError as exc:
        parser.error(str(exc))

    server = ThreadingHTTPServer((args.bind, args.port), make_gateway_handler(domain, routes))
    print(f"\n🌐  nsdeploy subdomain gateway: http://{args.bind}:{args.port}")
    for slug, target in sorted(routes.items()):
        print(f"    {slug}.{domain}  →  {target}")
    print("    Ctrl-C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
