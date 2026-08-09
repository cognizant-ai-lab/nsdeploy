import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from nsdeploy.launcher import make_handler


class _SessionMcpHandler(BaseHTTPRequestHandler):
    session_id = "test-session-id"

    def log_message(self, *args):
        pass

    def do_POST(self):
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


class _ModelCatalogHandler(BaseHTTPRequestHandler):
    authorization = ""

    def log_message(self, *args):
        pass

    def do_GET(self):
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
    def test_byok_model_catalog_is_proxied(self):
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
            finally:
                proxy.shutdown()
                proxy.server_close()
                upstream.shutdown()
                upstream.server_close()

    @staticmethod
    def _post(url, body, session_id=None):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Origin": "http://127.0.0.1:8095",
        }
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        return urllib.request.urlopen(urllib.request.Request(
            url, data=json.dumps(body).encode(), method="POST", headers=headers,
        ), timeout=5)


if __name__ == "__main__":
    unittest.main()
