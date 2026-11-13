from typing import Dict
from typing import Optional
from typing import Union
import unittest

from anyio.streams.memory import MemoryObjectReceiveStream
from anyio.streams.memory import MemoryObjectSendStream
import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.shared.message import SessionMessage
from mcp.types import CallToolResult
from starlette.applications import Starlette

from nsdeploy.byok import BYOK_AUTH_HEADER
from nsdeploy.byok import BYOK_MODEL_HEADER
from nsdeploy.byok import ByokContextMiddleware
from nsdeploy.byok import ByokCredentials
from nsdeploy.byok import authorization_for_key
from nsdeploy.byok import byok_headers
from nsdeploy.byok import current_byok_credentials


class ByokTests(unittest.IsolatedAsyncioTestCase):
    """Tests for bring-your-own-key header helpers and MCP middleware."""

    def test_header_helpers_and_repr_do_not_expose_key(self) -> None:
        """Check header helpers and repr do not expose key."""
        self.assertEqual(authorization_for_key("secret"), "Bearer secret")
        self.assertEqual(authorization_for_key("Bearer secret"), "Bearer secret")
        self.assertEqual(byok_headers("secret", "gpt-test"), {
            BYOK_AUTH_HEADER: "Bearer secret",
            BYOK_MODEL_HEADER: "gpt-test",
        })
        self.assertNotIn("secret", repr(ByokCredentials("Bearer secret", "gpt-test")))

    async def test_fastmcp_session_keeps_initializer_credentials(self) -> None:
        """Check fastmcp session keeps initializer credentials."""
        mcp: FastMCP = FastMCP(
            "byok-test",
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )

        @mcp.tool(name="check")
        async def check() -> str:
            credentials: Optional[ByokCredentials] = current_byok_credentials()
            return f"{credentials.authorization}|{credentials.model}" if credentials else "missing"

        app: Starlette = mcp.streamable_http_app()
        app.add_middleware(ByokContextMiddleware)
        transport: httpx.ASGITransport = httpx.ASGITransport(app=app)
        headers: Dict[str, str] = {
            BYOK_AUTH_HEADER: "Bearer caller-secret",
            BYOK_MODEL_HEADER: "caller-model",
        }
        client: httpx.AsyncClient
        read: MemoryObjectReceiveStream[Union[SessionMessage, Exception]]
        write: MemoryObjectSendStream[SessionMessage]
        session: ClientSession
        result: CallToolResult
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test", headers=headers
            ) as client:
                async with streamable_http_client(
                    "http://test/mcp", http_client=client
                ) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool("check", {})
        self.assertEqual(result.content[0].text, "Bearer caller-secret|caller-model")


if __name__ == "__main__":
    unittest.main()
