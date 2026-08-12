import unittest

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from nsdeploy.byok import (
    BYOK_AUTH_HEADER,
    BYOK_MODEL_HEADER,
    ByokContextMiddleware,
    ByokCredentials,
    authorization_for_key,
    byok_headers,
    current_byok_credentials,
)


class ByokTests(unittest.IsolatedAsyncioTestCase):
    def test_header_helpers_and_repr_do_not_expose_key(self):
        self.assertEqual(authorization_for_key("secret"), "Bearer secret")
        self.assertEqual(authorization_for_key("Bearer secret"), "Bearer secret")
        self.assertEqual(byok_headers("secret", "gpt-test"), {
            BYOK_AUTH_HEADER: "Bearer secret",
            BYOK_MODEL_HEADER: "gpt-test",
        })
        self.assertNotIn("secret", repr(ByokCredentials("Bearer secret", "gpt-test")))

    async def test_fastmcp_session_keeps_initializer_credentials(self):
        mcp = FastMCP(
            "byok-test",
            transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        )

        @mcp.tool(name="check")
        async def check() -> str:
            credentials = current_byok_credentials()
            return f"{credentials.authorization}|{credentials.model}" if credentials else "missing"

        app = mcp.streamable_http_app()
        app.add_middleware(ByokContextMiddleware)
        transport = httpx.ASGITransport(app=app)
        headers = {
            BYOK_AUTH_HEADER: "Bearer caller-secret",
            BYOK_MODEL_HEADER: "caller-model",
        }
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
