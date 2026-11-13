import asyncio
import json
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

# A coded tool that reports its progress the way neuro-san's coded tools do.
PROGRESS_TOOL = '''
class ProgressTool:
    async def async_invoke(self, args, sly_data):
        reporter = args.get("progress_reporter")
        await reporter.async_report_progress({"progress": 0.5}, "Halfway through")
        await reporter.async_report_progress({"progress": 1.0})
        return f"looked up {args.get('query')}"
'''


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class McpHostProgressTests(unittest.TestCase):
    """A hosted coded tool's progress reports reach the MCP caller before the result."""

    def test_progress_reports_arrive_as_log_notifications(self):
        """Each report_progress call arrives as an MCP log message, then the result."""
        with tempfile.TemporaryDirectory() as studio:
            (Path(studio) / "coded_tools").mkdir()
            (Path(studio) / "coded_tools" / "__init__.py").write_text("")
            (Path(studio) / "coded_tools" / "progress_tool.py").write_text(PROGRESS_TOOL)
            port = _free_port()
            spec = Path(studio) / "spec.json"
            spec.write_text(json.dumps({
                "name": "lookup", "module": "coded_tools.progress_tool", "class_name": "ProgressTool",
                "description": "Looks something up.", "port": port,
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            }))
            with subprocess.Popen(
                    [sys.executable, "-m", "nsdeploy.mcp_host", "--studio", studio, "--spec", str(spec)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as host:
                try:
                    url = f"http://127.0.0.1:{port}/mcp"
                    deadline = time.time() + 30
                    while time.time() < deadline:
                        with socket.socket() as sock:
                            if sock.connect_ex(("127.0.0.1", port)) == 0:
                                break
                        time.sleep(0.2)
                    logs, schema, result = asyncio.run(self._call(url))
                finally:
                    host.terminate()
                    host.wait(timeout=10)

        self.assertEqual(result, "looked up minivans")
        self.assertEqual(logs, [{"progress": 0.5, "message": "Halfway through"}, {"progress": 1.0}])
        # The Context parameter the progress goes through is not part of the tool's inputs.
        self.assertEqual(sorted(schema.get("properties", {})), ["query"])

    @staticmethod
    async def _call(url):
        logs = []

        async def on_log(params):
            logs.append(params.data)

        async with streamable_http_client(url) as (read, write, _):
            async with ClientSession(read, write, logging_callback=on_log) as session:
                await session.initialize()
                tools = await session.list_tools()
                result = await session.call_tool("lookup", {"query": "minivans"})
        return logs, tools.tools[0].inputSchema, result.content[0].text


if __name__ == "__main__":
    unittest.main()
