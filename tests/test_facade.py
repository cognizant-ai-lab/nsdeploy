import unittest

from nsdeploy.facade import (
    MOCK_TOOL_CALLS_PER_AGENT,
    NetworkRunner,
    PUBLIC_SITE_CALL_BUDGET,
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


if __name__ == "__main__":
    unittest.main()
