"""
Launch the deployed site: one static origin that serves the generated site + the
neuro-san-web runtime, an OpenAI-compatible MOCK LLM router and a BYOK pass-through
proxy (both same-origin under /v1 and /byok/v1), plus one MCP server subprocess per
hostable tool. No neuro-san server is involved.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from nsdeploy.byok import BYOK_AUTH_HEADER, BYOK_MODEL_HEADER
from nsdeploy.resolve import DeploymentPlan

# The vendored neuro-san-web browser runtime (self-contained ES modules) ships inside
# the package as data so editable and regular installs both find it. Overridable via
# serve(..., runtime_dir=...) / --runtime-dir.
DEFAULT_RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json",
}
MCP_PROXY_TIMEOUT_SECONDS = 480
UPSTREAM_REQUEST_TIMEOUT_SECONDS = 480
MODEL_CATALOG_TIMEOUT_SECONDS = 120

# A served site must never use an LLM credential configured on the host: every real
# completion carries the visitor's (or MCP caller's) own key. These patterns identify
# provider credentials and provider endpoints that must not leak into the facade
# subprocess. Non-secret settings (NSDEPLOY_FACADE_UPSTREAM, NSDEPLOY_FACADE_MODEL,
# timeouts, PATH, PYTHONPATH) are kept.
_SCRUB_PREFIXES = ("OPENAI_", "ANTHROPIC_", "AZURE_OPENAI_", "GEMINI_", "GOOGLE_API_",
                   "NSDEPLOY_STEWARD_BYOK_")
_SCRUB_SUFFIXES = ("_API_KEY", "_API_TOKEN", "_SECRET_KEY")
_SCRUB_EXACT = {"GOOGLE_APPLICATION_CREDENTIALS", "NSDEPLOY_FACADE_API_KEY"}


def scrubbed_env(base: Mapping[str, str]) -> Dict[str, str]:
    """Copy of `base` without LLM-provider credentials or provider endpoints."""
    return {
        name: value for name, value in base.items()
        if not (name in _SCRUB_EXACT
                or name.startswith(_SCRUB_PREFIXES)
                or name.endswith(_SCRUB_SUFFIXES))
    }


def _facade_command(python_exe: str, site_dir: Path, plan: DeploymentPlan, port: int,
                    facade_port: int, facade_upstream: str) -> List[str]:
    """argv for the public MCP facade subprocess. It carries no credential: the facade
    only ever uses the caller's BYOK headers."""
    return [python_exe, "-m", "nsdeploy.facade", "--config",
            str(site_dir / f"{plan.network_name}.network.json"), "--site-base",
            f"http://127.0.0.1:{port}", "--front-man", plan.front_man,
            "--port", str(facade_port), "--upstream", facade_upstream]


# The most text the mock LLM passes on, in a tool call's arguments or a summary.
MOCK_TEXT_LIMIT = 1200


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


def _responses_text(content: Any) -> str:
    """The text of a Responses API message content: a string, or a list of parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def _responses_to_chat(body: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    A Responses API request's input and tools, in the chat-completions shape the mock
    router reads: messages with a "tool" role for each function result, named after
    the call it answers, and tools as {"function": {...}}.
    """
    raw_input = body.get("input", [])
    items = [{"type": "message", "role": "user", "content": raw_input}] if isinstance(raw_input, str) else raw_input or []
    names_by_call: Dict[str, str] = {}
    messages: List[Dict[str, Any]] = []
    for item in items:
        kind = item.get("type", "message")
        if kind == "message":
            messages.append({"role": item.get("role"), "content": _responses_text(item.get("content"))})
        elif kind == "function_call":
            names_by_call[item.get("call_id", "")] = item.get("name", "")
            messages.append({"role": "assistant", "tool_calls": [{"function": {"name": item.get("name")}}]})
        elif kind == "function_call_output":
            messages.append({"role": "tool", "name": names_by_call.get(item.get("call_id", ""), ""),
                             "content": item.get("output", "")})
    tools = [{"function": {"name": t.get("name"), "parameters": t.get("parameters", {})}}
             for t in body.get("tools", []) or [] if t.get("type") == "function"]
    return messages, tools


def make_handler(site_dir: Path, upstream: str, runtime_dir: Path, ext_mcps: List[str],
                 local_mcps: Optional[List[str]] = None, facade_mcp: Optional[str] = None):
    ext_mcp_re = re.compile(r"^/ext-mcp/(\d+)/mcp$")
    local_mcp_re = re.compile(r"^/_mcp/(\d+)/mcp$")
    local_mcps = local_mcps or []
    facade_mcp = facade_mcp or ""
    link_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Expose-Headers", "Mcp-Session-Id, X-Nsdeploy-LLM-Route")

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
            if path == "/v1/responses":
                return self._mock_responses(raw)
            if path in ("/byok/v1/chat/completions", "/byok/v1/responses"):
                return self._byok_proxy(raw, path[len("/byok/v1"):])
            if path == "/_nsdeploy/links":
                return self._save_link(raw)
            if path == "/mcp" and facade_mcp:
                return self._mcp_proxy(facade_mcp, raw, "public facade", "POST")
            m = local_mcp_re.match(path)
            if m:
                return self._local_mcp_proxy(int(m.group(1)), raw, "POST")
            m = ext_mcp_re.match(path)
            if m:
                return self._ext_mcp_proxy(int(m.group(1)), raw, "POST")
            self._send(404, b"not found", "text/plain")

        def do_DELETE(self):
            path = self.path.split("?")[0]
            if path == "/mcp" and facade_mcp:
                return self._mcp_proxy(facade_mcp, b"", "public facade", "DELETE")
            m = local_mcp_re.match(path)
            if m:
                return self._local_mcp_proxy(int(m.group(1)), b"", "DELETE")
            m = ext_mcp_re.match(path)
            if m:
                return self._ext_mcp_proxy(int(m.group(1)), b"", "DELETE")
            self._send(404, b"not found", "text/plain")

        def _save_link(self, raw: bytes):
            """Persist one outbound demo link on this site; no shared registry."""
            try:
                body = json.loads(raw or b"{}")
                network = body.get("network", "")
                reference = body.get("reference", "")
                target = body.get("target", "").rstrip("/")
                parsed = urllib.parse.urlparse(target)
                if (not isinstance(network, str) or not isinstance(reference, str)
                        or not network or not reference or len(reference) > 200
                        or parsed.scheme not in ("http", "https") or not parsed.netloc):
                    raise ValueError("network, reference, and an http(s) target are required")

                config_path = site_dir / f"{network}.network.json"
                if not config_path.is_file():
                    return self._send(404, b'{"error":"unknown network"}', "application/json")
                config = json.loads(config_path.read_text(encoding="utf-8"))
                if reference not in (config.get("link_slots", {}) or {}):
                    return self._send(404, b'{"error":"unknown link slot"}', "application/json")

                links_path = site_dir / "links.json"
                with link_lock:
                    try:
                        doc = json.loads(links_path.read_text(encoding="utf-8"))
                    except (OSError, ValueError):
                        doc = {"version": 1, "networks": {}}
                    doc.setdefault("networks", {}).setdefault(network, {})[reference] = target
                    temp_path = site_dir / ".links.json.tmp"
                    temp_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
                    temp_path.replace(links_path)
                result = json.dumps({"linked": reference, "target": target}).encode("utf-8")
                return self._send(200, result, "application/json")
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                result = json.dumps({"error": str(exc)}).encode("utf-8")
                return self._send(400, result, "application/json")

        # --- deterministic, name-agnostic mock LLM router (no key needed) ---------
        def _mock_router(self, raw: bytes):
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            call, summary = self._mock_decision(body.get("messages", []) or [], body.get("tools", []) or [])
            tool_call: Optional[Dict[str, Any]] = None
            if call:
                name, arguments = call
                tool_call = {"index": 0, "id": f"call_{name}", "type": "function",
                             "function": {"name": name, "arguments": arguments}}

            self.send_response(200)
            self._cors()
            self.send_header("X-Nsdeploy-LLM-Route", "mock")
            if not body.get("stream"):
                # A non-streaming request gets one chat.completion, as OpenAI answers it.
                # The neuro-san agent loop asks this way whenever a network's llm_config
                # does not turn streaming on.
                message: Dict[str, Any] = {"role": "assistant", "content": None if tool_call else summary}
                if tool_call:
                    message["tool_calls"] = [{k: v for k, v in tool_call.items() if k != "index"}]
                payload = json.dumps({
                    # Unique per completion, as OpenAI's are. LangChain uses it as the message
                    # id, and LangGraph replaces a message whose id it has already seen.
                    "id": f"chatcmpl-neuro-san-mock-{uuid.uuid4().hex}", "object": "chat.completion",
                    "model": "neuro-san-mock",
                    "choices": [{"index": 0, "message": message,
                                 "finish_reason": "tool_calls" if tool_call else "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                }).encode("utf-8")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            # No Content-Length: signal end-of-stream by closing the connection so the
            # browser's SSE reader gets `done` (mirrors res.end() in the Node demo).
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            if tool_call:
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [tool_call]}}]}))
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}))
            else:
                for i, piece in enumerate(summary.split(" ")):
                    # The first delta carries the role, as OpenAI's stream does. The
                    # neuro-san agent loop drops streamed content that never names one.
                    delta = {"role": "assistant", "content": piece + " "} if i == 0 else {"content": piece + " "}
                    self.wfile.write(_sse({"model": "neuro-san-mock",
                                           "choices": [{"index": 0, "delta": delta}]}))
                self.wfile.write(_sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}))
            self.wfile.write(b"data: [DONE]\n\n")

        def _mock_decision(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]):
            """
            What the mock LLM does next, whichever API asked: call the first tool it
            hasn't called yet, with the user's request as its arguments, or once every
            tool has answered, summarize what they returned. Returns
            ((tool name, arguments JSON) or None, summary text).
            """
            available = [t.get("function", {}).get("name") for t in tools if t.get("function")]
            called = _called_tool_names(messages)
            uncalled = [n for n in available if n not in called]
            # Capped like the summary: each agent's request quotes the one before it,
            # so passing it on whole would double its size at every hop of a deep
            # chain of networks, where a real model writes a short request instead.
            text = _last_user_text(messages)[:MOCK_TEXT_LIMIT]
            if not uncalled:
                return None, self._summarize(messages)
            name = uncalled[0]
            schema = next((t["function"].get("parameters", {}) for t in tools
                           if t.get("function", {}).get("name") == name), {})
            args: Dict[str, Any] = {}
            for p in (schema.get("required") or []):
                args[p] = text
            for common in ("request", "inquiry", "search_terms", "query", "input"):
                args.setdefault(common, text)
            return (name, json.dumps(args)), ""

        def _mock_responses(self, raw: bytes):
            """
            The mock LLM on OpenAI's Responses API, which neuro-san uses for OpenAI
            models by default ("use_responses_api" in its llm info). Same decisions as
            _mock_router, answered as a response object, or streamed as the response.*
            events OpenAI sends.
            """
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            messages, tools = _responses_to_chat(body)
            call, summary = self._mock_decision(messages, tools)
            response_id = f"resp_neuro_san_mock_{uuid.uuid4().hex}"
            if call:
                name, arguments = call
                item: Dict[str, Any] = {"type": "function_call", "id": f"fc_{uuid.uuid4().hex}", "status": "completed",
                                        "call_id": f"call_{name}", "name": name, "arguments": arguments}
            else:
                item = {"type": "message", "id": f"msg_{uuid.uuid4().hex}", "status": "completed", "role": "assistant",
                        "content": [{"type": "output_text", "text": summary, "annotations": []}]}
            response: Dict[str, Any] = {
                "id": response_id, "object": "response", "created_at": int(time.time()), "status": "completed",
                "model": "neuro-san-mock", "output": [item],
                "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
            }

            self.send_response(200)
            self._cors()
            self.send_header("X-Nsdeploy-LLM-Route", "mock")
            if not body.get("stream"):
                payload = json.dumps(response).encode("utf-8")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            sequence = iter(range(1_000_000))

            def event(kind: str, **fields):
                self.wfile.write(f"event: {kind}\ndata: {json.dumps({'type': kind, 'sequence_number': next(sequence), **fields})}\n\n".encode("utf-8"))

            event("response.created", response={**response, "status": "in_progress", "output": []})
            if call:
                event("response.output_item.added", output_index=0, item={**item, "status": "in_progress", "arguments": ""})
                event("response.function_call_arguments.delta", item_id=item["id"], output_index=0, delta=item["arguments"])
                event("response.function_call_arguments.done", item_id=item["id"], output_index=0, arguments=item["arguments"])
            else:
                event("response.output_item.added", output_index=0, item={**item, "status": "in_progress", "content": []})
                part = {"type": "output_text", "text": "", "annotations": []}
                event("response.content_part.added", item_id=item["id"], output_index=0, content_index=0, part=part)
                for i, piece in enumerate(summary.split(" ")):
                    event("response.output_text.delta", item_id=item["id"], output_index=0, content_index=0,
                          delta=piece if i == 0 else " " + piece)
                event("response.output_text.done", item_id=item["id"], output_index=0, content_index=0, text=summary)
                event("response.content_part.done", item_id=item["id"], output_index=0, content_index=0,
                      part={**part, "text": summary})
            event("response.output_item.done", output_index=0, item=item)
            event("response.completed", response=response)

        def _summarize(self, messages: List[Dict[str, Any]]) -> str:
            results = [m.get("content", "") for m in messages if m.get("role") == "tool"]
            if not results:
                return "(mock) I have no grounded tool output to summarize for this request."
            joined = " ".join(str(r) for r in results)[:MOCK_TEXT_LIMIT]
            return "(mock summary) Based on the tools I consulted: " + joined

        # --- BYOK CORS pass-through proxy to a real OpenAI-compatible upstream ----
        def _byok_proxy(self, raw: bytes, endpoint: str):
            """Pass one request on to the upstream's endpoint, e.g. /chat/completions or /responses."""
            auth = self.headers.get("Authorization", "")
            req = urllib.request.Request(
                f"{upstream}{endpoint}", data=raw, method="POST",
                headers={"Content-Type": "application/json", "Authorization": auth, "Accept": "text/event-stream"},
            )
            try:
                up = urllib.request.urlopen(req, timeout=UPSTREAM_REQUEST_TIMEOUT_SECONDS)
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
            self.send_header(
                "X-Nsdeploy-LLM-Route",
                up.headers.get("X-Nsdeploy-LLM-Route", "byok"),
            )
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            while True:
                chunk = up.read(2048)
                if not chunk:
                    break
                self.wfile.write(chunk)

        # --- same-origin proxies to private local/external MCP servers -------------
        def _local_mcp_proxy(self, index: int, raw: bytes, method: str):
            if index < 0 or index >= len(local_mcps):
                return self._send(404, b"unknown local MCP", "text/plain")
            return self._mcp_proxy(local_mcps[index], raw, "local", method)

        def _ext_mcp_proxy(self, index: int, raw: bytes, method: str):
            if index < 0 or index >= len(ext_mcps):
                return self._send(404, b"unknown external MCP", "text/plain")
            return self._mcp_proxy(ext_mcps[index], raw, "external", method)

        def _mcp_proxy(self, target: str, raw: bytes, kind: str, method: str):
            # Forward the MCP/JSON-RPC request + the headers the protocol needs.
            fwd = {"Accept": self.headers.get("Accept", "application/json, text/event-stream"),
                   "MCP-Protocol-Version": self.headers.get("MCP-Protocol-Version", "2025-06-18"),
                   # urllib's default Python-urllib/* user agent is blocked by
                   # some Cloudflare-protected MCP providers (for example
                   # api.you.com returns 1010). Forward the browser UA so the
                   # same-origin proxy represents the browser-initiated request.
                   "User-Agent": self.headers.get(
                       "User-Agent",
                       "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
                   )}
            if method == "POST":
                fwd["Content-Type"] = "application/json"
            sid = self.headers.get("Mcp-Session-Id")
            if sid:
                fwd["Mcp-Session-Id"] = sid
            last_event_id = self.headers.get("Last-Event-ID")
            if last_event_id:
                fwd["Last-Event-ID"] = last_event_id
            if kind == "public facade":
                for header in (BYOK_AUTH_HEADER, BYOK_MODEL_HEADER):
                    value = self.headers.get(header)
                    if value:
                        fwd[header] = value
            try:
                up = urllib.request.urlopen(
                    urllib.request.Request(
                        target, data=raw if raw else None, method=method, headers=fwd),
                    timeout=MCP_PROXY_TIMEOUT_SECONDS)
            except urllib.error.HTTPError as e:
                detail = e.read()
                self._send(e.code, detail, e.headers.get("Content-Type", "application/json"))
                return
            except Exception as e:  # network/DNS/timeout — report as an MCP-readable error
                msg = json.dumps({"jsonrpc": "2.0", "error": {"code": -32000,
                                  "message": f"{kind} MCP unreachable: {e}"}}).encode("utf-8")
                self._send(502, msg, "application/json")
                return
            self.send_response(up.status)
            self._cors()
            self.send_header("Content-Type", up.headers.get("Content-Type", "application/json"))
            up_sid = up.headers.get("Mcp-Session-Id")
            if up_sid:
                self.send_header("Mcp-Session-Id", up_sid)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            try:
                while True:
                    chunk = up.read(2048)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except BrokenPipeError:
                # The MCP client may cancel a long-lived GET stream after its
                # session has completed. The upstream session is still valid.
                pass
            finally:
                up.close()

        # --- static files: /runtime/* from the runtime, else from the site -------
        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/mcp" and facade_mcp:
                return self._mcp_proxy(facade_mcp, b"", "public facade", "GET")
            m = local_mcp_re.match(path)
            if m:
                return self._local_mcp_proxy(int(m.group(1)), b"", "GET")
            m = ext_mcp_re.match(path)
            if m:
                return self._ext_mcp_proxy(int(m.group(1)), b"", "GET")
            if path == "/byok/v1/models":
                return self._byok_models_proxy()
            if path == "/":
                path = "/index.html"
            if path.startswith("/runtime/"):
                file_path = runtime_dir / path[len("/runtime/"):]
            else:
                file_path = site_dir / path.lstrip("/")
            if ".." in path or not file_path.is_file():
                return self._send(404, b"404 " + path.encode(), "text/plain")
            data = file_path.read_bytes()
            self._send(200, data, MIME.get(file_path.suffix, "application/octet-stream"))

        def _byok_models_proxy(self):
            """Expose the active upstream catalog for browser-side model validation."""
            auth = self.headers.get("Authorization", "")
            req = urllib.request.Request(
                f"{upstream}/models", method="GET",
                headers={"Authorization": auth, "Accept": "application/json"},
            )
            try:
                up = urllib.request.urlopen(req, timeout=MODEL_CATALOG_TIMEOUT_SECONDS)
                detail = up.read()
                return self._send(
                    up.status, detail,
                    up.headers.get("Content-Type", "application/json"),
                )
            except urllib.error.HTTPError as exc:
                detail = exc.read()
                return self._send(
                    exc.code, detail,
                    exc.headers.get("Content-Type", "application/json"),
                )
            except Exception as exc:
                detail = json.dumps({"error": f"model catalog unavailable: {exc}"}).encode("utf-8")
                return self._send(502, detail, "application/json")

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


def _free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_listener(proc: subprocess.Popen, port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"MCP subprocess exited with status {proc.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"MCP subprocess did not listen on port {port} within {timeout:g}s")


def _stop_process(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def spawn_mcp_servers(plan: DeploymentPlan, studio_root: Path, python_exe: str) -> List[Tuple[subprocess.Popen, int]]:
    """Start one FastMCP server per tool on an available private runtime port."""
    bindings: List[Tuple[subprocess.Popen, int]] = []
    # NOTE: tool subprocesses currently inherit the full host environment (some studio
    # coded tools construct provider clients from it). Tightening this to scrubbed_env()
    # is tracked separately together with the affected tools.
    env = dict(os.environ)
    repo_root = str(Path(__file__).resolve().parents[1])
    env["PYTHONPATH"] = os.pathsep.join([repo_root, str(studio_root), env.get("PYTHONPATH", "")])
    try:
        for index, tool in enumerate(plan.hostable_tools):
            last_error: Optional[Exception] = None
            for attempt in range(5):
                port = _free_tcp_port()
                spec = {"name": tool.name, "module": tool.module, "class_name": tool.class_name,
                        "description": tool.description, "parameters": tool.parameters, "port": port}
                spec_file = Path(tempfile.gettempdir()) / (
                    f"nsdeploy_{os.getpid()}_{index}_{attempt}.json")
                spec_file.write_text(json.dumps(spec), encoding="utf-8")
                proc = subprocess.Popen(
                    [python_exe, "-m", "nsdeploy.mcp_host", "--studio", str(studio_root),
                     "--spec", str(spec_file)], env=env, cwd=repo_root,
                )
                try:
                    _wait_for_listener(proc, port)
                    bindings.append((proc, port))
                    break
                except Exception as exc:
                    last_error = exc
                    _stop_process(proc)
            else:
                raise RuntimeError(f"Could not start MCP tool {tool.name}: {last_error}")
    except Exception:
        for proc, _ in bindings:
            _stop_process(proc)
        raise
    return bindings


def serve(site_dir: Path, plan: DeploymentPlan, studio_root: Path, *, port: int = 8080,
          upstream: str = "https://api.openai.com/v1", python_exe: Optional[str] = None,
          runtime_dir: Optional[Path] = None, ext_mcps: Optional[List[str]] = None,
          facade_upstream: Optional[str] = None) -> None:
    python_exe = python_exe or sys.executable
    runtime_dir = runtime_dir or DEFAULT_RUNTIME_DIR
    if not (runtime_dir / "generated" / "browser" / "neuro-san.mjs").is_file():
        raise SystemExit(f"error: the browser runtime is not built ({runtime_dir / 'generated'} is missing). "
                         "Run `npm install && npm run build` in runtime-build/ first.")
    ext_mcps = ext_mcps or []
    bindings = spawn_mcp_servers(plan, studio_root, python_exe)
    facade_proc: Optional[subprocess.Popen] = None
    try:
        local_mcps = [f"http://127.0.0.1:{private_port}/mcp" for _, private_port in bindings]
        facade_port = _free_tcp_port()
        facade_upstream = facade_upstream or os.environ.get("NSDEPLOY_FACADE_UPSTREAM") or upstream
        repo_root = str(Path(__file__).resolve().parents[1])
        # The facade runs the network for MCP callers with *their* BYOK credentials, so it
        # must not even be able to see the host's provider credentials.
        env = scrubbed_env(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([repo_root, str(studio_root), env.get("PYTHONPATH", "")])
        facade_proc = subprocess.Popen(
            _facade_command(python_exe, site_dir, plan, port, facade_port, facade_upstream),
            env=env, cwd=repo_root,
        )
        _wait_for_listener(facade_proc, facade_port)
        httpd = ThreadingHTTPServer(
            ("127.0.0.1", port), make_handler(site_dir, upstream, runtime_dir, ext_mcps,
                                               local_mcps, f"http://127.0.0.1:{facade_port}/mcp"))
        url = f"http://127.0.0.1:{port}/"
        print(f"\n🌐  {plan.network_name} is live:  {url}")
        print(f"    LLM: mock router (no key) at /v1  ·  BYOK proxy at /byok/v1 → {upstream}")
        print(f"    Public MCP facade: /mcp  →  127.0.0.1:{facade_port}  ·  LLM: caller BYOK → {facade_upstream}  ·  steward: {plan.network_name}_private_steward.hocon")
        if plan.hostable_tools:
            print("    MCP tool servers (same-origin proxy → private subprocess):")
            for i, (tool, (_, private_port)) in enumerate(zip(plan.hostable_tools, bindings)):
                print(f"      • {tool.name}  →  /_mcp/{i}/mcp  →  127.0.0.1:{private_port}")
        for i, target in enumerate(ext_mcps):
            print(f"    External MCP (proxied): /ext-mcp/{i}/mcp  →  {target}")
        if plan.link_slots:
            pending = len(set(plan.link_slots) - set(plan.links))
            print(f"    Linker: {pending} pending agent-network link(s); outbound bindings stay on this site")
        print("    Ctrl-C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
    finally:
        if facade_proc is not None:
            _stop_process(facade_proc)
        for proc, _ in bindings:
            _stop_process(proc)
