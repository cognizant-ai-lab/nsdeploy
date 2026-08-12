import json
import unittest
from unittest.mock import patch

from nsdeploy.byok import BYOK_AUTH_HEADER, BYOK_MODEL_HEADER, ByokContextMiddleware

from nsdeploy.facade import (
    MOCK_TOOL_CALLS_PER_AGENT,
    NetworkRunner,
    PUBLIC_SITE_CALL_BUDGET,
    PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS,
    _mcp_http_timeout,
    _is_public_site_ref,
    _pack_context,
    _unpack_context,
)


class FacadeContextTests(unittest.IsolatedAsyncioTestCase):
    def test_context_round_trip(self):
        packed = _pack_context(
            "Find a venue",
            {"http://127.0.0.1:8091", "http://127.0.0.1:8098"},
            4,
        )
        request, visited, remaining = _unpack_context(packed)
        self.assertEqual(request, "Find a venue")
        self.assertEqual(visited, {"http://127.0.0.1:8091", "http://127.0.0.1:8098"})
        self.assertEqual(remaining, 4)

    def test_missing_context_uses_default_budget(self):
        request, visited, remaining = _unpack_context("plain request")
        self.assertEqual(request, "plain request")
        self.assertEqual(visited, set())
        self.assertEqual(remaining, PUBLIC_SITE_CALL_BUDGET)

    def test_public_site_refs_use_standard_facade_contract(self):
        self.assertTrue(_is_public_site_ref("http://127.0.0.1:8097/main_street_exchange"))
        self.assertFalse(_is_public_site_ref("http://127.0.0.1:8097/mcp"))
        self.assertFalse(_is_public_site_ref("http://127.0.0.1:8097/_mcp/0/mcp"))

    def test_mcp_http_timeout_covers_long_sse_streams(self):
        timeout = _mcp_http_timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(timeout.read, PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS)

    async def test_real_facade_requires_caller_byok(self):
        runner = NetworkRunner(
            {"tools": [{"name": "front", "instructions": "Help."}]},
            "http://127.0.0.1:8091",
            "https://api.example/v1",
            "host-key-must-not-be-used",
        )
        result = await runner.run("request", "front")
        self.assertIn("caller BYOK credentials are required", result)

    async def test_real_facade_uses_caller_key_and_model(self):
        calls = []

        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {"choices": [{"message": {"role": "assistant", "content": "done"}}]}

        class Client:
            def __init__(self, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def post(self, url, content, headers):
                calls.append((url, json.loads(content), headers))
                return Response()

        runner = NetworkRunner(
            {"tools": [{"name": "front", "instructions": "Help."}]},
            "http://127.0.0.1:8091",
            "https://api.example/v1",
            "host-key-must-not-be-used",
        )
        results = []

        async def app(scope, receive, send):
            results.append(await runner._complete([{"role": "user", "content": "hello"}], []))

        scope = {"type": "http", "headers": [
            (BYOK_AUTH_HEADER.lower().encode(), b"Bearer caller-secret"),
            (BYOK_MODEL_HEADER.lower().encode(), b"caller-model"),
        ]}
        with patch("nsdeploy.facade.httpx.AsyncClient", Client):
            await ByokContextMiddleware(app)(scope, None, None)

        self.assertEqual(results[0]["message"]["content"], "done")
        self.assertEqual(calls[0][1]["model"], "caller-model")
        self.assertEqual(calls[0][2]["Authorization"], "Bearer caller-secret")
        self.assertNotIn("host-key-must-not-be-used", json.dumps(calls))

    async def test_public_site_hop_forwards_caller_byok(self):
        client_headers = []

        class Client:
            def __init__(self, **kwargs):
                client_headers.append(kwargs.get("headers", {}))
                raise RuntimeError("stop after capturing headers")

        runner = NetworkRunner(
            {"tools": [{"name": "front", "instructions": "Help."}]},
            "http://127.0.0.1:8091",
            "https://api.example/v1",
            "host-key-must-not-be-used",
        )
        tools = [{
            "name": "remote",
            "kind": "mcp",
            "endpoint": "http://127.0.0.1:8092/mcp",
            "remote_name": "invoke_network",
        }]

        async def app(scope, receive, send):
            with patch("nsdeploy.facade.httpx.AsyncClient", Client):
                await runner._call_tool(
                    "remote", {"request": "continue"}, tools, 0,
                    {"http://127.0.0.1:8091"}, {"remaining": 12},
                )

        scope = {"type": "http", "headers": [
            (BYOK_AUTH_HEADER.lower().encode(), b"Bearer caller-secret"),
            (BYOK_MODEL_HEADER.lower().encode(), b"caller-model"),
        ]}
        await ByokContextMiddleware(app)(scope, None, None)

        self.assertEqual(client_headers[0][BYOK_AUTH_HEADER], "Bearer caller-secret")
        self.assertEqual(client_headers[0][BYOK_MODEL_HEADER], "caller-model")

    async def test_skips_recursive_public_site(self):
        runner = NetworkRunner(
            {"tools": [{"name": "front", "instructions": ""}]},
            "http://127.0.0.1:8091",
            "mock://nsdeploy",
            "",
        )
        tools = [{
            "name": "remote",
            "kind": "mcp",
            "endpoint": "http://127.0.0.1:8091/mcp",
            "remote_name": "invoke_network",
        }]
        result = await runner._call_tool(
            "remote", {"request": "loop back"}, tools, 0,
            {"http://127.0.0.1:8091"}, {"remaining": 12},
        )
        self.assertIn("Skipped recursive call", result)

    async def test_mock_facade_finishes_after_one_tool_hop(self):
        runner = NetworkRunner(
            {"tools": [{"name": "front", "instructions": ""}]},
            "http://127.0.0.1:8091",
            "mock://nsdeploy",
            "",
        )
        tools = [{
            "name": "remote",
            "description": "remote",
            "parameters": {"type": "object", "properties": {"request": {"type": "string"}}},
            "kind": "mcp",
            "endpoint": "http://127.0.0.1:8092/mcp",
            "remote_name": "invoke_network",
        }]
        first = await runner._complete([{"role": "user", "content": "request"}], tools)
        self.assertEqual(len(first["message"]["tool_calls"]), 1)
        second = await runner._complete([
            {"role": "user", "content": "request"},
            {"role": "tool", "name": "remote", "content": "result"},
        ], tools)
        self.assertEqual(second["message"].get("tool_calls"), None)
        self.assertEqual(MOCK_TOOL_CALLS_PER_AGENT, 1)
        self.assertGreater(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS, 30)


if __name__ == "__main__":
    unittest.main()
