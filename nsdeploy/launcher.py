"""
Launch the deployed site: one static origin that serves the generated site + the
neuro-san-web runtime, an OpenAI-compatible MOCK LLM router and a BYOK pass-through
proxy (both same-origin under /v1 and /byok/v1), plus one MCP server subprocess per
hostable tool. No neuro-san server is involved.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

from nsdeploy.resolve import DeploymentPlan

# The vendored neuro-san-web browser runtime (self-contained ES modules) lives at
# the project root. Overridable via serve(..., runtime_dir=...) / --runtime-dir.
DEFAULT_RUNTIME_DIR = Path(__file__).resolve().parents[1] / "runtime"
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json",
}
WORKER_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'"


def _sse(obj: Dict[str, Any]) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode("utf-8")


def _last_user_text(messages: List[Dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else json.dumps(c)
    return ""


def _called_tool_names(messages: List[Dict[str, Any]]) -> set:
    return {m.get("name") for m in messages if m.get("role") == "tool" and m.get("name")}


def make_handler(site_dir: Path, upstream: str, runtime_dir: Path):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self):
            path = self.path.split("?")[0]
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b""
            if path == "/v1/chat/completions":
                return self._mock_router(raw)
            if path == "/byok/v1/chat/completions":
                return self._byok_proxy(raw)
            self._send(404, b"not found", "text/plain")

        # --- deterministic, name-agnostic mock LLM router (no key needed) ---------
        def _mock_router(self, raw: bytes):
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            messages = body.get("messages", []) or []
            tools = body.get("tools", []) or []
            available = [t.get("function", {}).get("name") for t in tools if t.get("function")]
            called = _called_tool_names(messages)
            uncalled = [n for n in available if n not in called]
            text = _last_user_text(messages)

            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            # No Content-Length: signal end-of-stream by closing the connection so the
            # browser's SSE reader gets `done` (mirrors res.end() in the Node demo).
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            if uncalled:
                name = uncalled[0]
                schema = next((t["function"].get("parameters", {}) for t in tools
                               if t.get("function", {}).get("name") == name), {})
                args: Dict[str, Any] = {}
                for p in (schema.get("required") or []):
                    args[p] = text
                for common in ("request", "inquiry", "search_terms", "query", "input"):
                    args.setdefault(common, text)
                tc = {"index": 0, "id": f"call_{name}", "type": "function",
                      "function": {"name": name, "arguments": json.dumps(args)}}
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [tc]}}]}))
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}))
            else:
                summary = self._summarize(messages)
                for piece in summary.split(" "):
                    self.wfile.write(_sse({"model": "neuro-san-mock",
                                           "choices": [{"index": 0, "delta": {"content": piece + " "}}]}))
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}))
            self.wfile.write(b"data: [DONE]\n\n")

        def _summarize(self, messages: List[Dict[str, Any]]) -> str:
            results = [m.get("content", "") for m in messages if m.get("role") == "tool"]
            if not results:
                return "(mock) I have no grounded tool output to summarize for this request."
            joined = " ".join(str(r) for r in results)[:1200]
            return "(mock summary) Based on the tools I consulted: " + joined

        # --- BYOK CORS pass-through proxy to a real OpenAI-compatible upstream ----
        def _byok_proxy(self, raw: bytes):
            auth = self.headers.get("Authorization", "")
            req = urllib.request.Request(
                f"{upstream}/chat/completions", data=raw, method="POST",
                headers={"Content-Type": "application/json", "Authorization": auth, "Accept": "text/event-stream"},
            )
            try:
                up = urllib.request.urlopen(req, timeout=120)
            except urllib.error.HTTPError as e:
                detail = e.read()
                self.send_response(e.code)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(detail)))
                self.end_headers()
                self.wfile.write(detail)
                return
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", up.headers.get("Content-Type", "text/event-stream"))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            while True:
                chunk = up.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)

        # --- static files: /runtime/* from the runtime, else from the site -------
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/":
                path = "/index.html"
            if path.startswith("/runtime/"):
                file_path = runtime_dir / path[len("/runtime/"):]
            else:
                file_path = site_dir / path.lstrip("/")
            if ".." in path or not file_path.is_file():
                return self._send(404, b"404 " + path.encode(), "text/plain")
            data = file_path.read_bytes()
            extra = {}
            if path == "/runtime/sandbox-worker.js":
                extra["Content-Security-Policy"] = WORKER_CSP
            self._send(200, data, MIME.get(file_path.suffix, "application/octet-stream"), extra)

        def _send(self, code: int, body: bytes, ctype: str, extra: Optional[Dict[str, str]] = None):
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

    return Handler


def spawn_mcp_servers(plan: DeploymentPlan, studio_root: Path, python_exe: str) -> List[subprocess.Popen]:
    """Start one FastMCP server subprocess per hostable tool."""
    procs: List[subprocess.Popen] = []
    env = dict(os.environ)
    repo_root = str(Path(__file__).resolve().parents[1])
    env["PYTHONPATH"] = os.pathsep.join([repo_root, str(studio_root), env.get("PYTHONPATH", "")])
    for tool in plan.hostable_tools:
        spec = {"name": tool.name, "module": tool.module, "class_name": tool.class_name,
                "description": tool.description, "parameters": tool.parameters, "port": tool.port}
        spec_file = Path(tempfile.gettempdir()) / f"nsdeploy_{tool.name}_{tool.port}.json"
        spec_file.write_text(json.dumps(spec), encoding="utf-8")
        proc = subprocess.Popen(
            [python_exe, "-m", "nsdeploy.mcp_host", "--studio", str(studio_root), "--spec", str(spec_file)],
            env=env, cwd=repo_root,
        )
        procs.append(proc)
    return procs


def serve(site_dir: Path, plan: DeploymentPlan, studio_root: Path, *, port: int = 8080,
          upstream: str = "https://api.openai.com/v1", python_exe: Optional[str] = None,
          runtime_dir: Optional[Path] = None) -> None:
    python_exe = python_exe or sys.executable
    runtime_dir = runtime_dir or DEFAULT_RUNTIME_DIR
    procs = spawn_mcp_servers(plan, studio_root, python_exe)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(site_dir, upstream, runtime_dir))
    url = f"http://127.0.0.1:{port}/"
    print(f"\n🌐  {plan.network_name} is live:  {url}")
    print(f"    LLM: mock router (no key) at /v1  ·  BYOK proxy at /byok/v1 → {upstream}")
    if plan.hostable_tools:
        print("    MCP tool servers:")
        for t in plan.hostable_tools:
            print(f"      • {t.name}  →  http://127.0.0.1:{t.port}/mcp")
    print("    Ctrl-C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        for p in procs:
            p.terminate()
