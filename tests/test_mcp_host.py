import asyncio
import inspect
import unittest
from typing import Any, Dict

from nsdeploy.mcp_host import _make_tool_function


class EchoTool:
    """
    Coded tool stand-in that returns the arguments it receives.
    """

    def invoke(self, args: Dict[str, Any], sly_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Return the received arguments.

        :param args: Tool arguments
        :param sly_data: Private data, always empty here
        :return: The arguments
        """
        return {"args": args, "sly_data": sly_data}


class TestMcpHost(unittest.TestCase):
    """
    Tests the MCP tool function built from a JSON-Schema parameter list.
    """

    def test_signature_mirrors_parameters(self) -> None:
        """
        Tests that required and optional parameters become typed keyword-only parameters.
        """
        parameters = {"properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
                      "required": ["query"]}
        fn = _make_tool_function(EchoTool(), parameters)
        params = inspect.signature(fn).parameters
        self.assertEqual(list(params), ["query", "limit"])
        self.assertIs(params.get("query").annotation, str)
        self.assertIs(params.get("query").default, inspect.Parameter.empty)
        self.assertIs(params.get("limit").annotation, int)
        self.assertIsNone(params.get("limit").default)
        result = asyncio.run(fn(query="q"))
        self.assertEqual(result, '{"args": {"query": "q"}, "sly_data": {}}')

    def test_non_identifier_parameter_is_rejected(self) -> None:
        """
        Tests that a parameter name that is not an identifier raises instead of running as code.
        """
        parameters = {"properties": {"x=__import__('os').system('true')": {"type": "string"}}}
        with self.assertRaises(ValueError):
            _make_tool_function(EchoTool(), parameters)


if __name__ == "__main__":
    unittest.main()
