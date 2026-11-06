import asyncio
import inspect
import unittest
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

from mcp.server.fastmcp import FastMCP

from nsdeploy.hosted_tool_function import HostedToolFunction


class TestHostedToolFunction(unittest.TestCase):
    """
    Tests the MCP tool callable built from a JSON-Schema parameter list.
    """

    PARAMETERS: dict = {"properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
                        "required": ["query"]}

    def test_signature_mirrors_parameters(self) -> None:
        """
        Tests that required and optional parameters become typed keyword-only parameters.
        """
        hosted = HostedToolFunction(MagicMock(spec=["invoke"]), "search", "Search", self.PARAMETERS)
        params = inspect.signature(hosted).parameters
        self.assertEqual(list(params), ["query", "limit"])
        self.assertIs(params.get("query").annotation, str)
        self.assertIs(params.get("query").default, inspect.Parameter.empty)
        self.assertIs(params.get("limit").annotation, int)
        self.assertIsNone(params.get("limit").default)

    def test_call_forwards_set_arguments(self) -> None:
        """
        Tests that a call drops unset arguments and JSON-encodes a non-string result.
        """
        coded = MagicMock(spec=["invoke"])
        coded.invoke.return_value = {"ok": True}
        result = asyncio.run(HostedToolFunction(coded, "search", "Search", self.PARAMETERS)(query="q", limit=None))
        coded.invoke.assert_called_once_with({"query": "q"}, {})
        self.assertEqual(result, '{"ok": true}')

    def test_call_uses_async_invoke(self) -> None:
        """
        Tests that a tool with only `async_invoke` is awaited.
        """
        coded = MagicMock(spec=["async_invoke"])
        coded.async_invoke = AsyncMock(return_value="done")
        self.assertEqual(asyncio.run(HostedToolFunction(coded, "search", "Search", self.PARAMETERS)(query="q")), "done")
        coded.async_invoke.assert_awaited_once_with({"query": "q"}, {})

    def test_fastmcp_schema_and_call(self) -> None:
        """
        Tests that FastMCP advertises the schema and routes a tool call through the callable.
        """
        coded = MagicMock(spec=["invoke"])
        coded.invoke.return_value = "hit"
        mcp = FastMCP("test")
        mcp.tool(name="search", description="Search")(HostedToolFunction(coded, "search", "Search", self.PARAMETERS))
        tools = asyncio.run(mcp.list_tools())
        self.assertEqual(tools[0].inputSchema.get("required"), ["query"])
        self.assertEqual(list(tools[0].inputSchema.get("properties")), ["query", "limit"])
        asyncio.run(mcp.call_tool("search", {"query": "q", "limit": 2}))
        coded.invoke.assert_called_once_with({"query": "q", "limit": 2}, {})

    def test_non_identifier_parameter_is_rejected(self) -> None:
        """
        Tests that a parameter name that is not an identifier raises instead of running as code.
        """
        parameters = {"properties": {"x=__import__('os').system('true')": {"type": "string"}}}
        with self.assertRaises(ValueError):
            HostedToolFunction(MagicMock(spec=["invoke"]), "search", "Search", parameters)


if __name__ == "__main__":
    unittest.main()
