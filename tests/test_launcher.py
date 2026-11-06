import http.client
import json
import os
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from nsdeploy.byok import BYOK_AUTH_HEADER
from nsdeploy.byok import BYOK_MODEL_HEADER
from nsdeploy.launcher import _facade_command
from nsdeploy.launcher import make_handler
from nsdeploy.launcher import scrubbed_env


class StaticHeaderTests(unittest.TestCase):
    """
    Tests for the static CORS and CSP headers the launcher serves.
    """

    def test_only_public_agent_data_has_static_cors(self):
        """
        Check that only public agent data files carry a wildcard CORS header.
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("agent-manifest.json", "example.network.json", "links.json", "actions.js",
                         "action-bridge.html", "sandbox-worker.js"):
                (root / name).write_text("{}")
            server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(root, "", root, []))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                for path, cors in (("agent-manifest.json", True), ("example.network.json", True),
                                   ("links.json", True), ("actions.js", False), ("action-bridge.html", False),
                                   ("runtime/sandbox-worker.js", False)):
                    url = f"http://127.0.0.1:{server.server_port}/{path}"
                    with urllib.request.urlopen(url, timeout=5) as response:
                        expected = "*" if cors else None
                        self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), expected, path)
                        if path.endswith("sandbox-worker.js"):
                            self.assertIn("connect-src 'none'", response.headers["Content-Security-Policy"])
            finally:
                server.shutdown()
                server.server_close()


class _SessionMcpHandler(BaseHTTPRequestHandler):
    """
    Fake MCP upstream that tracks the session id and credential headers it receives.
    """

    session_id = "test-session-id"
    get_session_id = ""
    delete_session_id = ""
    byok_authorization = ""
    byok_model = ""
    authorization = ""

    def log_message(self, *args):
        pass

    def do_POST(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler naming
        """
        Answer an MCP JSON-RPC POST, requiring the session id after initialize.
        """
        type(self).byok_authorization = self.headers.get(BYOK_AUTH_HEADER, "")
        type(self).byok_model = self.headers.get(BYOK_MODEL_HEADER, "")
        type(self).authorization = self.headers.get("Authorization", "")
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if body.get("method") == "initialize":
            result = {"jsonrpc": "2.0", "id": body["id"], "result": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "serverInfo": {"name": "test", "version": "1"},
            }}
        elif self.headers.get("Mcp-Session-Id") != self.session_id:
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        else:
            result = {"jsonrpc": "2.0", "id": body.get("id"), "result": {"tools": []}}
        payload = f"event: message\ndata: {json.dumps(result)}\n\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Mcp-Session-Id", self.session_id)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler naming
        """
        Record the session id and answer with a keepalive event stream.
        """
        type(self).get_session_id = self.headers.get("Mcp-Session-Id", "")
        payload = b": keepalive\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_DELETE(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler naming
        """
        Record the session id of a session termination request.
        """
        type(self).delete_session_id = self.headers.get("Mcp-Session-Id", "")
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


class _ModelCatalogHandler(BaseHTTPRequestHandler):
    """
    Fake model catalog upstream that records the Authorization header.
    """

    authorization = ""

    def log_message(self, *args):
        pass

    def do_GET(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler naming
        """
        Record the Authorization header and return a one-model catalog.
        """
        type(self).authorization = self.headers.get("Authorization", "")
        payload = json.dumps({"object": "list", "data": [
            {"id": "available-model", "object": "model"},
        ]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class LauncherProxyTests(unittest.TestCase):
    """
    Tests for the launcher's BYOK and MCP proxy routes.
    """

    def test_byok_model_catalog_is_proxied(self):
        """
        Check that the BYOK model catalog request reaches the upstream with the caller's key.
        """
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), _ModelCatalogHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            handler = make_handler(root, f"http://127.0.0.1:{upstream.server_port}", root, [])
            proxy = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{proxy.server_port}/byok/v1/models",
                    headers={"Authorization": "Bearer secret"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    self.assertEqual(json.load(response)["data"][0]["id"], "available-model")
                self.assertEqual(_ModelCatalogHandler.authorization, "Bearer secret")
            finally:
                proxy.shutdown()
                proxy.server_close()
                upstream.shutdown()
                upstream.server_close()

    def test_cross_origin_mcp_session_header_is_exposed_and_forwarded(self):
        """
        Check that the MCP session header is exposed to browsers and forwarded on GET and DELETE.
        """
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), _SessionMcpHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            handler = make_handler(
                root, "http://unused", root, [],
                [f"http://127.0.0.1:{upstream.server_port}/mcp"],
            )
            proxy = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            try:
                url = f"http://127.0.0.1:{proxy.server_port}/_mcp/0/mcp"
                init = self._post(url, {
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "test", "version": "1"}},
                })
                self.assertEqual(init.headers.get("Mcp-Session-Id"), "test-session-id")
                self.assertIn("Mcp-Session-Id", init.headers.get("Access-Control-Expose-Headers", ""))
                listed = self._post(url, {
                    "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
                }, session_id="test-session-id")
                self.assertEqual(listed.status, 200)
                stream_request = urllib.request.Request(url, method="GET", headers={
                    "Accept": "text/event-stream",
                    "Mcp-Session-Id": "test-session-id",
                    "MCP-Protocol-Version": "2025-06-18",
                })
                with urllib.request.urlopen(stream_request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers.get("Content-Type"), "text/event-stream")
                delete_request = urllib.request.Request(url, method="DELETE", headers={
                    "Mcp-Session-Id": "test-session-id",
                    "MCP-Protocol-Version": "2025-06-18",
                })
                with urllib.request.urlopen(delete_request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(_SessionMcpHandler.get_session_id, "test-session-id")
                self.assertEqual(_SessionMcpHandler.delete_session_id, "test-session-id")
            finally:
                proxy.shutdown()
                proxy.server_close()
                upstream.shutdown()
                upstream.server_close()

    def test_public_facade_proxy_forwards_caller_byok_headers(self):
        """
        Check that the public facade proxy forwards the caller's BYOK headers upstream.
        """
        _SessionMcpHandler.byok_authorization = ""
        _SessionMcpHandler.byok_model = ""
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), _SessionMcpHandler)
        upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        upstream_thread.start()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            handler = make_handler(
                root, "http://unused", root, [], [],
                f"http://127.0.0.1:{upstream.server_port}/mcp",
            )
            proxy = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            try:
                self._post(
                    f"http://127.0.0.1:{proxy.server_port}/mcp",
                    {
                        "jsonrpc": "2.0", "id": 1, "method": "initialize",
                        "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "test", "version": "1"}},
                    },
                    extra_headers={
                        BYOK_AUTH_HEADER: "Bearer caller-secret",
                        BYOK_MODEL_HEADER: "caller-model",
                    },
                )
                self.assertEqual(_SessionMcpHandler.byok_authorization, "Bearer caller-secret")
                self.assertEqual(_SessionMcpHandler.byok_model, "caller-model")
            finally:
                proxy.shutdown()
                proxy.server_close()
                upstream.shutdown()
                upstream.server_close()

    @staticmethod
    def _post(url, body, session_id=None, extra_headers=None):
        """
        POST a JSON-RPC body to an MCP endpoint.

        :param url: The endpoint URL.
        :param body: The JSON-RPC request body.
        :param session_id: The MCP session id to send, if any.
        :param extra_headers: Additional request headers, if any.
        :return: The open HTTP response; the caller closes it.
        """
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Origin": "http://127.0.0.1:8095",
        }
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        headers.update(extra_headers or {})
        return urllib.request.urlopen(urllib.request.Request(
            url, data=json.dumps(body).encode(), method="POST", headers=headers,
        ), timeout=5)


class _ChatUpstreamHandler(BaseHTTPRequestHandler):
    """Fake OpenAI-compatible upstream: records what the BYOK proxy forwards."""
    headers_seen = {}
    body_seen = b""

    def log_message(self, *args):
        pass

    def do_POST(self):  # pylint: disable=invalid-name; BaseHTTPRequestHandler naming
        """
        Record the forwarded headers and body, and reject requests without a key.
        """
        type(self).headers_seen = dict(self.headers.items())
        length = int(self.headers.get("Content-Length", 0) or 0)
        type(self).body_seen = self.rfile.read(length)
        if not self.headers.get("Authorization"):
            payload = json.dumps({"error": {"message": "missing key"}}).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
        else:
            payload = (b'data: {"model":"real-model","choices":[{"index":0,"delta":{"content":"ok"},'
                       b'"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ByokOnlyTests(unittest.TestCase):
    """A served site must never use an LLM credential configured on the host."""

    def _serve(self, handler_cls, *make_handler_args):
        """
        Start an optional upstream and a launcher proxy, and register their cleanup.

        :param handler_cls: The upstream request handler class, or None for no upstream.
        :param make_handler_args: Arguments for make_handler after the root; callables receive the upstream port.
        :return: The proxy port.
        """
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls) if handler_cls else None
        if upstream:
            threading.Thread(target=upstream.serve_forever, daemon=True).start()
        temp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; removed in cleanup
        root = Path(temp.name)
        args = [a(upstream.server_port) if callable(a) else a for a in make_handler_args]
        proxy = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(root, *args))
        threading.Thread(target=proxy.serve_forever, daemon=True).start()

        def cleanup():
            proxy.shutdown()
            proxy.server_close()
            if upstream:
                upstream.shutdown()
                upstream.server_close()
            temp.cleanup()
        self.addCleanup(cleanup)
        return proxy.server_port

    def test_byok_chat_proxy_forwards_only_the_visitor_header(self):
        """
        Check that the BYOK chat proxy forwards the visitor's key and never the host key.
        """
        port = self._serve(_ChatUpstreamHandler, lambda p: f"http://127.0.0.1:{p}", Path("."), [])
        body = json.dumps({"model": "visitor-model", "messages": [{"role": "user", "content": "hi"}],
                           "stream": True}).encode()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "server-secret"}):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/byok/v1/chat/completions", data=body, method="POST",
                headers={"Content-Type": "application/json", "Authorization": "Bearer visitor-key"})
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("X-Nsdeploy-LLM-Route"), "byok")
                self.assertIn(b"real-model", response.read())
        self.assertEqual(_ChatUpstreamHandler.headers_seen.get("Authorization"), "Bearer visitor-key")
        self.assertEqual(_ChatUpstreamHandler.body_seen, body)
        self.assertNotIn("server-secret", json.dumps(_ChatUpstreamHandler.headers_seen))

    def test_byok_chat_proxy_never_substitutes_a_key_when_the_visitor_sent_none(self):
        """
        Check that the BYOK chat proxy sends no key when the visitor sent none.
        """
        port = self._serve(_ChatUpstreamHandler, lambda p: f"http://127.0.0.1:{p}", Path("."), [])
        body = json.dumps({"model": "m", "messages": []}).encode()
        with patch.dict(os.environ, {"OPENAI_API_KEY": "server-secret"}):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/byok/v1/chat/completions", data=body, method="POST",
                headers={"Content-Type": "application/json"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(request, timeout=5)  # pylint: disable=consider-using-with; raises
        self.assertEqual(ctx.exception.code, 401)
        with ctx.exception as denied:
            self.assertIn(b"missing key", denied.read())
        self.assertFalse(_ChatUpstreamHandler.headers_seen.get("Authorization"))
        self.assertNotIn("server-secret", json.dumps(_ChatUpstreamHandler.headers_seen))

    def test_mock_router_makes_no_network_call(self):
        """
        Check that the mock router answers with a tool call without any network call.
        """
        port = self._serve(None, "http://unused", Path("."), [])
        body = json.dumps({"model": "mock-1", "messages": [{"role": "user", "content": "hi"}],
                           "tools": [{"type": "function", "function": {
                               "name": "lookup", "parameters": {"type": "object", "required": ["q"]}}}]})
        with patch("urllib.request.urlopen", side_effect=AssertionError("mock router must not call out")):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("POST", "/v1/chat/completions", body=body,
                         headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            text = response.read().decode()
            conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("X-Nsdeploy-LLM-Route"), "mock")
        self.assertIn('"tool_calls"', text)
        self.assertIn('"name": "lookup"', text)

    @staticmethod
    def _mcp_urls(port):
        """
        Build the MCP proxy target list for an upstream port.

        :param port: The upstream port.
        :return: A one-element list with the upstream MCP URL.
        """
        return [f"http://127.0.0.1:{port}/mcp"]

    def test_tool_proxies_do_not_forward_any_credential(self):
        """
        Check that the local and external MCP proxies strip every credential header.
        """
        # The same targets serve both the ext and local proxies.
        port = self._serve(_SessionMcpHandler, "http://unused", Path("."), self._mcp_urls, self._mcp_urls)
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "test", "version": "1"}}}
        for path in ("/_mcp/0/mcp", "/ext-mcp/0/mcp"):
            _SessionMcpHandler.authorization = "unset"
            _SessionMcpHandler.byok_authorization = "unset"
            _SessionMcpHandler.byok_model = "unset"
            # pylint: disable-next=protected-access
            LauncherProxyTests._post(f"http://127.0.0.1:{port}{path}", init, extra_headers={
                "Authorization": "Bearer visitor-key",
                BYOK_AUTH_HEADER: "Bearer caller-key",
                BYOK_MODEL_HEADER: "caller-model",
            })
            self.assertEqual(_SessionMcpHandler.authorization, "", path)
            self.assertEqual(_SessionMcpHandler.byok_authorization, "", path)
            self.assertEqual(_SessionMcpHandler.byok_model, "", path)

    def test_scrubbed_env_removes_provider_credentials_and_keeps_settings(self):
        """
        Check that scrubbed_env drops provider credentials and keeps non-secret settings.
        """
        env = scrubbed_env({
            "OPENAI_API_KEY": "k", "OPENAI_BASE_URL": "u", "OPENAI_ORG_ID": "o",
            "ANTHROPIC_API_KEY": "k", "AZURE_OPENAI_API_KEY": "k", "AZURE_OPENAI_ENDPOINT": "u",
            "GOOGLE_API_KEY": "k", "GEMINI_API_KEY": "k", "GOOGLE_APPLICATION_CREDENTIALS": "f",
            "MISTRAL_API_KEY": "k", "HF_API_TOKEN": "t", "NSDEPLOY_FACADE_API_KEY": "k",
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "k", "NSDEPLOY_STEWARD_BYOK_MODEL": "m",
            "NSDEPLOY_FACADE_UPSTREAM": "http://router/v1", "NSDEPLOY_FACADE_MODEL": "gpt-x",
            "NSDEPLOY_FACADE_SITE_TIMEOUT_SECONDS": "30", "PATH": "/bin", "PYTHONPATH": "/src",
            "HOME": "/home/u",
        })
        self.assertEqual(env, {
            "NSDEPLOY_FACADE_UPSTREAM": "http://router/v1", "NSDEPLOY_FACADE_MODEL": "gpt-x",
            "NSDEPLOY_FACADE_SITE_TIMEOUT_SECONDS": "30", "PATH": "/bin", "PYTHONPATH": "/src",
            "HOME": "/home/u",
        })

    def test_facade_command_carries_no_credential(self):
        """
        Check that the facade command line carries no credential flag.
        """
        plan = types.SimpleNamespace(network_name="net", front_man="front")
        cmd = _facade_command(
            "python", Path("/site"), plan, 8091, 50000, "https://api.example/v1",
            "https://net.agents.example.com",
        )
        flags = {arg for arg in cmd if arg.startswith("--")}
        self.assertEqual(flags, {"--config", "--site-base", "--port", "--upstream"})
        self.assertNotIn("front", cmd)
        self.assertNotIn("--api-key", cmd)
        self.assertEqual(cmd[cmd.index("--site-base") + 1], "https://net.agents.example.com")
        legacy = _facade_command(
            "python", Path("/site"), plan, 8091, 50000, "https://api.example/v1",
        )
        self.assertEqual(legacy[legacy.index("--site-base") + 1], "http://127.0.0.1:8091")


if __name__ == "__main__":
    unittest.main()
