import json
import socket
import socketserver
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path

from nsdeploy.cailville import augment_config
from nsdeploy.cailville import public_site_directory
from nsdeploy.cailville import write_runtime_link_files
from nsdeploy.linker import load_link_file
from nsdeploy.gateway import make_gateway_handler
from nsdeploy.gateway import network_slug
from nsdeploy.gateway import parse_routes
from nsdeploy.gateway import public_origin


class _BackendHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, body=b""):
        payload = json.dumps({
            "backend": self.server.backend_name,
            "host": self.headers.get("Host"),
            "forwarded_host": self.headers.get("X-Forwarded-Host"),
            "body": body.decode("utf-8"),
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler API
        """Echo a GET request."""
        self._reply()

    def do_POST(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler API
        """Echo a POST request with its body."""
        length = int(self.headers.get("Content-Length", 0) or 0)
        self._reply(self.rfile.read(length))


class _SplittingBackendHandler(socketserver.StreamRequestHandler):
    """Backend that tries to smuggle extra headers and a second response through the gateway."""

    def handle(self):
        while self.rfile.readline() not in (b"\r\n", b"\n", b""):
            pass
        self.wfile.write(
            b"HTTP/1.1 200 OK\rSet-Cookie: reason=injected\r\n"
            b"X-Folded: first\r\n second\r\n"
            b"X-Ctl: bad\x00value\r\n"
            b"X-Safe: kept\r\n"
            b"Content-Length: 2\r\n"
            b"\r\n"
            b"ok"
        )


class GatewayTests(unittest.TestCase):
    """Tests for host-based routing and header sanitizing in the gateway."""

    def setUp(self):
        self.servers = []

    def tearDown(self):
        for server in reversed(self.servers):
            server.shutdown()
            server.server_close()

    def _server(self, handler, *, backend_name=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.backend_name = backend_name
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)
        return server

    def test_dns_names_and_public_origins_are_stable(self):
        """Check dns names and public origins are stable."""
        self.assertEqual(network_slug("Harbor_Town Hall"), "harbor-town-hall")
        self.assertEqual(
            public_origin("Harbor_Town Hall", "agents.example.com", scheme="https", port=443),
            "https://harbor-town-hall.agents.example.com",
        )
        self.assertEqual(
            public_origin("Harbor_Town Hall", "localhost", port=8080),
            "http://harbor-town-hall.localhost:8080",
        )
        with self.assertRaisesRegex(ValueError, "both map to subdomain"):
            parse_routes([
                "foo_bar=http://127.0.0.1:9001",
                "foo-bar=http://127.0.0.1:9002",
            ])

    def test_gateway_routes_get_and_post_by_host_on_one_port(self):
        """Check gateway routes get and post by host on one port."""
        alpha = self._server(_BackendHandler, backend_name="alpha")
        beta = self._server(_BackendHandler, backend_name="beta")
        routes = parse_routes([
            f"alpha_network=http://127.0.0.1:{alpha.server_port}",
            f"beta=http://127.0.0.1:{beta.server_port}",
        ])
        gateway = self._server(make_gateway_handler("agents.test", routes))
        base = f"http://127.0.0.1:{gateway.server_port}"

        request = urllib.request.Request(
            base + "/anything?value=1",
            headers={"Host": f"alpha-network.agents.test:{gateway.server_port}"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
        self.assertEqual(result["backend"], "alpha")
        self.assertEqual(result["forwarded_host"], f"alpha-network.agents.test:{gateway.server_port}")

        request = urllib.request.Request(
            base + "/mcp", data=b'{"hello":"world"}', method="POST",
            headers={
                "Host": f"beta.agents.test:{gateway.server_port}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
        self.assertEqual(result["backend"], "beta")
        self.assertEqual(result["body"], '{"hello":"world"}')

        with self.assertRaises(urllib.error.HTTPError) as context:
            # pylint: disable-next=consider-using-with; raises HTTPError, closed below
            urllib.request.urlopen(urllib.request.Request(
                base + "/", headers={"Host": "unknown.agents.test"},
            ), timeout=5)
        self.assertEqual(context.exception.code, 404)
        context.exception.close()

    def test_gateway_does_not_relay_cr_lf_from_backend_response(self):
        """Check gateway does not relay cr lf from backend response."""
        backend = self._server(_SplittingBackendHandler)
        routes = parse_routes([f"alpha=http://127.0.0.1:{backend.server_port}"])
        gateway = self._server(make_gateway_handler("agents.test", routes))

        with socket.create_connection(("127.0.0.1", gateway.server_port), timeout=5) as sock:
            sock.sendall(
                b"GET / HTTP/1.1\r\nHost: alpha.agents.test\r\nConnection: close\r\n\r\n"
            )
            raw = b""
            while chunk := sock.recv(65536):
                raw += chunk

        head, _, body = raw.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        self.assertEqual(lines[0], b"HTTP/1.1 200 OK")
        self.assertEqual(body, b"ok")
        for line in lines:
            self.assertNotIn(b"\r", line)
            self.assertNotIn(b"\n", line)
            self.assertNotIn(b"\x00", line)
        self.assertNotIn(b"Set-Cookie: reason=injected", head)
        self.assertIn(b"X-Folded: first second", lines)
        self.assertIn(b"X-Safe: kept", lines)
        self.assertFalse(any(line.startswith(b"X-Ctl:") for line in lines))

    def test_cailville_links_and_steward_directory_use_subdomains(self):
        """Check cailville links and steward directory use subdomains."""
        community = {
            "sites": [
                {"id": "alpha_network", "port": 8091},
                {"id": "beta", "port": 8092},
            ],
            "relationships": [["alpha_network", "beta"]],
        }
        directory = public_site_directory(
            community, base_domain="agents.example.com", public_scheme="https",
            public_port=443,
        )
        self.assertEqual(directory, {
            "alpha_network": "https://alpha-network.agents.example.com",
            "beta": "https://beta.agents.example.com",
        })
        self.assertEqual(public_site_directory(community), {
            "alpha_network": "http://127.0.0.1:8091",
            "beta": "http://127.0.0.1:8092",
        })
        config = {"tools": [{
            "name": "front", "instructions": "help", "tools": [],
        }]}
        augmented = augment_config(
            config, "alpha_network", community, base_domain="agents.example.com",
            public_scheme="https", public_port=443,
        )
        self.assertEqual(
            augmented["links"]["beta"],
            "https://beta.agents.example.com/beta",
        )

    def test_cailville_subdomain_sidecars_are_generated_separately(self):
        """Check cailville subdomain sidecars are generated separately."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cailville = root / "cailville"
            cailville.mkdir()
            community = {
                "sites": [
                    {"id": "alpha_network", "port": 8091},
                    {"id": "beta", "port": 8092},
                ],
                "relationships": [["alpha_network", "beta"]],
            }
            (cailville / "community.json").write_text(json.dumps(community))
            paths = write_runtime_link_files(
                cailville, root, base_domain="localhost", public_port=8080,
            )
            self.assertEqual(load_link_file(paths["alpha_network"], "alpha_network"), {
                "beta": "http://beta.localhost:8080/beta",
            })
            self.assertEqual(load_link_file(paths["beta"], "beta"), {})
            self.assertFalse((cailville / "alpha_network.links.json").exists())


if __name__ == "__main__":
    unittest.main()
