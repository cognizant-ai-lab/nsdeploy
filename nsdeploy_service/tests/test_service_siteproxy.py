"""Serving deployed sites by hostname through the service's single listener.

A browser origin is scheme + host + port, so a hostname per deployment gives each
site its own origin and the bundle's root-absolute paths resolve — which is what
makes a single-port ingress workable. These tests run a real upstream server and
proxy to it, rather than mocking the transport, because the things that break are
streaming and header fidelity.
"""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings, sanitize_label, slugify
from nsdeploy_service.siteproxy import site_hostname

PUBLIC_HOST = "agents.example.com"


class SlugTest(unittest.TestCase):
    """Network name slugs used in site hostnames."""
    def test_underscores_become_hyphens(self):
        """Network names are identifiers; underscores are illegal in hostnames."""
        self.assertEqual(slugify("store_order_management_system"),
                         "store-order-management-system")

    def test_lowercases_and_strips_punctuation(self):
        """A slug is lowercased and stripped of punctuation."""
        self.assertEqual(slugify("Bank KYC (end-to-end)!"), "bank-kyc-end-to-end")

    def test_collapses_runs_and_trims_edges(self):
        """A slug collapses separator runs and trims its edges."""
        self.assertEqual(slugify("__a very___odd  name__"), "a-very-odd-name")

    def test_is_capped_so_the_id_always_survives(self):
        """`{slug}-{id}` must fit in a 63-character DNS label with the 12-char id
        intact — the id is what makes the hostname unique."""
        slug = slugify("x" * 200)
        self.assertLessEqual(len(slug), 40)
        self.assertLessEqual(len(f"{slug}-{'a' * 12}"), 63)

    def test_an_empty_name_yields_an_empty_slug(self):
        """An empty name yields an empty slug."""
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("___"), "")

    def test_sanitize_enforces_a_legal_label(self):
        """sanitize_label enforces a legal DNS label."""
        self.assertEqual(sanitize_label("--Bad__Label--"), "bad-label")
        self.assertLessEqual(len(sanitize_label("z" * 200)), 63)


class SubdomainLabelTest(unittest.TestCase):
    """Subdomain labels and site URLs built from the subdomain template."""
    def _settings(self, template):
        return Settings(public_scheme="https", public_host=PUBLIC_HOST,
                        subdomain_template=template, port_start=8100, port_end=8199)

    def test_slug_and_id_together(self):
        """The slug and the id are combined in one label."""
        label = self._settings("{slug}-{id}").subdomain_label(
            "b8955663ecd1", 8100, "store_merchandising_operations")
        self.assertEqual(label, "store-merchandising-operations-b8955663ecd1")

    def test_id_only_stays_supported(self):
        """An id-only template stays supported."""
        self.assertEqual(
            self._settings("{id}").subdomain_label("b8955663ecd1", 8100, "whatever"),
            "b8955663ecd1")

    def test_name_is_an_alias_for_slug(self):
        """The name placeholder is an alias for slug."""
        self.assertEqual(
            self._settings("{name}").subdomain_label("i", 1, "Bank_KYC"), "bank-kyc")

    def test_a_nameless_deployment_still_gets_a_label(self):
        """A nameless deployment still gets a label."""
        self.assertEqual(
            self._settings("{slug}-{id}").subdomain_label("b8955663ecd1", 8100, ""),
            "b8955663ecd1")

    def test_an_unknown_placeholder_falls_back_to_the_id(self):
        """A mis-set template must not stop a deployment getting a URL."""
        self.assertEqual(
            self._settings("{nope}").subdomain_label("b8955663ecd1", 8100, "n"),
            "b8955663ecd1")

    def test_the_full_url(self):
        """The full site URL is built from the label and public host."""
        url = self._settings("{slug}-{id}").site_url(
            "c2a3a18ee383", 8102, "bank_kyc_end_to_end")
        self.assertEqual(url, "https://bank-kyc-end-to-end-c2a3a18ee383.agents.example.com")

    def test_without_a_template_the_port_form_is_unchanged(self):
        """Without a template the port form of the URL is unchanged."""
        settings = Settings(public_scheme="http", public_host="10.1.2.3",
                            port_start=8100, port_end=8199)
        self.assertEqual(settings.site_url("abc", 8100, "some_net"),
                         "http://10.1.2.3:8100")


class SiteHostnameTest(unittest.TestCase):
    """Hostname lookup for a deployment record."""
    def _settings(self):
        return Settings(public_scheme="https", public_host=PUBLIC_HOST,
                        subdomain_template="{slug}-{id}",
                        port_start=8100, port_end=8199)

    def test_taken_from_the_recorded_url_when_present(self):
        """The hostname is taken from the recorded URL when present."""
        row = {"id": "i", "name": "n", "port": 8100,
               "url": "https://recorded-host.agents.example.com"}
        self.assertEqual(site_hostname(self._settings(), row),
                         "recorded-host.agents.example.com")

    def test_derived_when_the_deployment_has_no_url_yet(self):
        """A queued or stopped record has no url, but its hostname must still be
        recognised so the proxy can answer usefully instead of 404ing."""
        row = {"id": "b8955663ecd1", "name": "store_x", "port": None, "url": None}
        self.assertEqual(site_hostname(self._settings(), row),
                         "store-x-b8955663ecd1.agents.example.com")

    def test_none_without_a_subdomain_template(self):
        """No hostname is derived without a subdomain template."""
        settings = Settings(public_host="10.1.2.3", port_start=8100, port_end=8199)
        self.assertIsNone(site_hostname(settings, {"id": "i", "name": "n", "url": None}))


class _Upstream(BaseHTTPRequestHandler):
    """Stands in for a deployed site.

    Mirrors nsdeploy's own launcher: HTTP/1.1, and an SSE response with no
    Content-Length that signals end-of-stream by closing the connection.
    """

    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler API
        """Serve the manifest, an SSE stream, or a plain echo of the path."""
        if self.path == "/agent-manifest.json":
            body = json.dumps({"networks": [{"name": "netd"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Mcp-Session-Id", "sess-42")
            # Exactly what launcher._mock_router does: no Content-Length, and the
            # close is the end-of-stream signal.
            self.send_header("Connection", "close")
            self.close_connection = True  # pylint: disable=attribute-defined-outside-init; handler API
            self.end_headers()
            for i in range(3):
                self.wfile.write(f"data: chunk{i}\n\n".encode())
                self.wfile.flush()
            return
        body = f"site saw {self.path}".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler API
        """Echo the request body with a 201 response."""
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else b""
        body = b"echo:" + payload
        self.send_response(201)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class SiteProxyTest(unittest.TestCase):
    """Hostname-based proxying through the service's single listener."""
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _settings(self, **over):
        base = {"public_scheme": "https", "public_host": PUBLIC_HOST,
                "subdomain_template": "{slug}-{id}",
                "work_root": self.root, "port_start": self.port, "port_end": self.port + 40,
                "max_deployments": 5}
        base.update(over)
        return Settings(**base)

    def _client(self, **over):
        settings = self._settings(**over)
        # create_app returns the SiteProxy wrapper when a template is configured.
        return TestClient(create_app(settings), base_url=f"https://{PUBLIC_HOST}"), settings

    def _supervisor(self, client):
        app = client.app
        return getattr(app, "app", app).state.supervisor

    def _seed(self, client, status="ready"):
        supervisor = self._supervisor(client)
        org = supervisor.fallback_org
        work_dir = self.root / "d"
        work_dir.mkdir(parents=True, exist_ok=True)
        supervisor.store.save_deployment({
            "id": "b8955663ecd1", "org_id": org["id"], "name": "store_x",
            "status": status,
            "url": f"https://store-x-b8955663ecd1.{PUBLIC_HOST}" if status == "ready" else None,
            "port": self.port if status == "ready" else None,
            "created_at": "2026-09-24T00:00:00+00:00",
            "ready_at": "2026-09-24T00:00:05+00:00", "stopped_at": None,
            "expires_at": None, "error": None, "pid": None,
            "network_json": None, "warnings_json": None,
            "log_path": str(work_dir / "nsdeploy.log"), "work_dir": str(work_dir),
        })
        return f"store-x-b8955663ecd1.{PUBLIC_HOST}"

    # --- routing ----------------------------------------------------------
    def test_the_service_hostname_still_reaches_the_api(self):
        """The service hostname still reaches the API."""
        client, _ = self._client()
        with client:
            self._seed(client)
            self.assertEqual(client.get("/health").json()["status"], "ok")

    def test_the_service_root_is_still_the_console_redirect(self):
        """The service root still redirects to the console."""
        client, _ = self._client()
        with client:
            self._seed(client)
            response = client.get("/", follow_redirects=False)
            self.assertIn(response.status_code, (302, 307))
            self.assertEqual(response.headers["location"], "/app/")

    def test_a_site_hostname_reaches_the_site_root(self):
        """The case a catch-all route could never serve: `/` on a site hostname."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            response = client.get("/", headers={"host": host})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "site saw /")

    def test_root_absolute_asset_paths_reach_the_site(self):
        """Root-absolute asset paths reach the site."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            body = client.get("/agent-manifest.json", headers={"host": host}).json()
            self.assertEqual(body["networks"][0]["name"], "netd")

    def test_the_query_string_is_preserved(self):
        """The query string is preserved."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            response = client.get("/runtime/index.js?v=3", headers={"host": host})
            self.assertEqual(response.text, "site saw /runtime/index.js?v=3")

    def test_x_forwarded_host_wins_over_host(self):
        """Azure Front Door rewrites Host to the origin FQDN so Container Apps
        ingress accepts the request, and preserves the caller's name here."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            response = client.get("/", headers={"host": PUBLIC_HOST,
                                                "x-forwarded-host": host})
            self.assertEqual(response.text, "site saw /")

    def test_a_chained_forwarded_host_uses_the_client_facing_name(self):
        """A chained forwarded host uses the client-facing name."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            response = client.get("/", headers={
                "host": PUBLIC_HOST, "x-forwarded-host": f"{host}, inner.example.net"})
            self.assertEqual(response.text, "site saw /")

    def test_an_unknown_hostname_falls_through_to_the_api(self):
        """An unknown hostname falls through to the API."""
        client, _ = self._client()
        with client:
            self._seed(client)
            response = client.get("/health", headers={"host": "nope.agents.example.com"})
            self.assertEqual(response.status_code, 200)

    # --- fidelity ---------------------------------------------------------
    def test_a_post_body_is_relayed(self):
        """A POST body is relayed to the site."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            response = client.post("/v1/chat/completions", headers={"host": host},
                                   content=b"hello")
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.text, "echo:hello")

    def test_streaming_arrives_in_chunks_with_headers_intact(self):
        """/v1 and /byok/v1 are SSE; buffering would break token delivery, and the
        MCP session header has to survive."""
        client, _ = self._client()
        with client:
            host = self._seed(client)
            with client.stream("GET", "/stream", headers={"host": host}) as response:
                self.assertEqual(response.headers["content-type"], "text/event-stream")
                self.assertEqual(response.headers["mcp-session-id"], "sess-42")
                text = "".join(part for part in response.iter_text())
            for i in range(3):
                self.assertIn(f"data: chunk{i}", text)

    # --- states and access ------------------------------------------------
    def test_a_stopped_site_answers_503_with_what_to_do(self):
        """A stopped site answers 503 with what to do."""
        client, _ = self._client()
        with client:
            host = self._seed(client, status="stopped")
            response = client.get("/", headers={"host": host})
            self.assertEqual(response.status_code, 503)
            self.assertIn("Restart it", response.text)

    def test_a_site_needs_no_api_token(self):
        """Deployed sites are public; only the management API is gated."""
        client, _ = self._client(api_token="secret")
        with client:
            host = self._seed(client)
            self.assertEqual(client.get("/", headers={"host": host}).status_code, 200)
            self.assertEqual(client.get("/deployments").status_code, 401)

    def test_the_proxy_is_inert_without_a_subdomain_template(self):
        """create_app returns a plain FastAPI app without a subdomain template."""
        app = create_app(Settings(work_root=self.root, subdomain_template="",
                                  port_start=8100, port_end=8199))
        self.assertIsInstance(app, FastAPI)


if __name__ == "__main__":
    unittest.main()
