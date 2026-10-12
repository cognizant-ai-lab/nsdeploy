import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from nsdeploy.cailville import (
    augment_config,
    public_site_directory,
    write_runtime_link_files,
)
from nsdeploy.linker import load_link_file
from nsdeploy.gateway import (
    make_gateway_handler,
    network_slug,
    parse_routes,
    public_origin,
)


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

    def do_GET(self):
        self._reply()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        self._reply(self.rfile.read(length))


class GatewayTests(unittest.TestCase):
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
            urllib.request.urlopen(urllib.request.Request(
                base + "/", headers={"Host": "unknown.agents.test"},
            ), timeout=5)
        self.assertEqual(context.exception.code, 404)
        context.exception.close()

    def test_cailville_links_and_steward_directory_use_subdomains(self):
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
