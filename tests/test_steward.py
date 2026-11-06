import json
import os
from typing import Any
from typing import ClassVar
from typing import Dict
from typing import List
from typing import Optional
from typing import Tuple
import unittest
from unittest.mock import AsyncMock
from unittest.mock import patch

from nsdeploy.byok import ByokCredentials
from nsdeploy.facade import NetworkRunner
from nsdeploy.facade import PublishedNetwork
from nsdeploy.facade import load_published_network
from nsdeploy.steward import PublicAgentMcpGateway
from nsdeploy.steward import PublicAgentNetworkGateway


class _Response:
    def __init__(self, body: Dict[str, Any], status: int = 200) -> None:
        self.body: Dict[str, Any] = body
        self.status_code: int = status
        self.content: bytes = json.dumps(body).encode()

    def json(self) -> Dict[str, Any]:
        """
        Return the decoded body.

        :return: The response body.
        """
        return self.body

    def raise_for_status(self) -> None:
        """
        Raise when the status code is an HTTP error.

        :raises RuntimeError: If the status code is 400 or above.
        """
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _StaticSiteClient:
    routes: ClassVar[Dict[str, Dict[str, Any]]] = {}
    requests: ClassVar[List[str]] = []
    posts: ClassVar[List[Tuple[str, Dict[str, Any], Dict[str, str]]]] = []

    def __init__(self, **kwargs: Any) -> None:
        pass

    async def __aenter__(self) -> "_StaticSiteClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        pass

    async def get(self, url: str) -> _Response:
        """
        Return the canned response for a known route.

        :param url: The requested URL.
        :return: The canned response.
        :raises RuntimeError: If the URL is not a known route.
        """
        type(self).requests.append(url)
        if url not in type(self).routes:
            raise RuntimeError(f"unexpected request: {url}")
        return _Response(type(self).routes[url])

    async def post(self, url: str, content: bytes, headers: Dict[str, str]) -> _Response:
        """
        Record the post and return a canned chat completion.

        :param url: The requested URL.
        :param content: The JSON request body.
        :param headers: The request headers.
        :return: The canned response.
        """
        type(self).posts.append((url, json.loads(content), dict(headers)))
        return _Response({"choices": [{"message": {
            "role": "assistant", "content": "private runner result",
        }}]})


def _site(name: str, tools: List[Dict[str, Any]], front_man: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    return {
        f"https://{name}.example/agent-manifest.json": {
            "networks": [{
                "name": name,
                "front_man": front_man or tools[0]["name"],
                "hocon": f"/{name}.network.json",
            }],
        },
        f"https://{name}.example/{name}.network.json": {"tools": tools},
    }


class PublishedNetworkRunnerTests(unittest.IsolatedAsyncioTestCase):
    """Tests for loading and running published static networks."""

    def setUp(self) -> None:
        _StaticSiteClient.routes = {}
        _StaticSiteClient.requests = []
        _StaticSiteClient.posts = []

    async def test_loader_fetches_exact_static_network_and_rejects_server_code(self) -> None:
        """Check loader fetches exact static network and rejects server code."""
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "helper", "instructions": "Assist."},
            {"name": "front", "instructions": "Help."},
        ], front_man="front"))
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            published: PublishedNetwork = await load_published_network("https://harbor.example/harbor")
        self.assertEqual(published.network, "harbor")
        self.assertEqual(published.front_man, "front")

        _StaticSiteClient.routes.update(_site("unsafe", [
            {"name": "front", "instructions": "Help."},
            {"name": "code", "class": "untrusted.Tool"},
        ]))
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            with self.assertRaisesRegex(ValueError, "executable server-side"):
                await load_published_network("https://unsafe.example/unsafe")

    async def test_loader_supports_static_bundle_below_domain_root(self) -> None:
        """Check loader supports static bundle below domain root."""
        _StaticSiteClient.routes.update({
            "https://cdn.example/agents/agent-manifest.json": {
                "networks": [{
                    "name": "harbor", "front_man": "front",
                    "hocon": "./harbor.network.json",
                }],
            },
            "https://cdn.example/agents/harbor.network.json": {
                "tools": [{"name": "front", "instructions": "Help."}],
            },
        })
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            published: PublishedNetwork = await load_published_network(
                "https://cdn.example/agents/harbor"
            )
        self.assertEqual(published.site_base, "https://cdn.example/agents")
        self.assertEqual(published.front_man, "front")

    async def test_deny_policy_blocks_before_fetching_public_data(self) -> None:
        """Check deny policy blocks before fetching public data."""
        _StaticSiteClient.routes.update(_site("blocked", [
            {"name": "front", "instructions": "Help."},
        ]))
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            with self.assertRaisesRegex(PermissionError, "denied"):
                await NetworkRunner.from_public_site(
                    "https://blocked.example/blocked", "mock://nsdeploy",
                    denied_origins={"https://blocked.example"},
                )
        self.assertEqual(_StaticSiteClient.requests, [])

    async def test_runner_recursively_fetches_public_network_without_mcp_facade(self) -> None:
        """Check runner recursively fetches public network without mcp facade."""
        child_tools: List[Dict[str, Any]] = [{"name": "child_front", "instructions": "Answer."}]
        _StaticSiteClient.routes.update(_site("child", child_tools))
        root_config: Dict[str, Any] = {"tools": [{
            "name": "root_front",
            "instructions": "Delegate.",
            "tools": ["https://child.example/child"],
        }]}
        runner: NetworkRunner = NetworkRunner(
            root_config, "https://root.example", "mock://nsdeploy",
            credentials=ByokCredentials("Bearer private", "mock-1"),
            public_network_mode="fetch", network_name="root",
        )
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result: str = await runner.run("ask the child", "root_front")
        self.assertIn("facade mock", result)
        self.assertEqual(_StaticSiteClient.requests, [
            "https://child.example/agent-manifest.json",
            "https://child.example/child.network.json",
        ])
        self.assertFalse(any(url.endswith("/mcp") for url in _StaticSiteClient.requests))

    async def test_recursive_fetch_stops_a_public_network_cycle(self) -> None:
        """Check recursive fetch stops a public network cycle."""
        _StaticSiteClient.routes.update(_site("child", [{
            "name": "child_front",
            "instructions": "Delegate back.",
            "tools": ["https://root.example/root"],
        }]))
        _StaticSiteClient.routes.update(_site("root", [{
            "name": "root_front", "instructions": "Delegate.",
            "tools": ["https://child.example/child"],
        }]))
        runner: NetworkRunner = NetworkRunner(
            _StaticSiteClient.routes["https://root.example/root.network.json"],
            "https://root.example", "mock://nsdeploy",
            credentials=ByokCredentials("Bearer private", "mock-1"),
            public_network_mode="fetch", network_name="root",
        )
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result: str = await runner.run("ask both", "root_front")
        self.assertIn("Skipped recursive call", result)

    async def test_private_steward_runs_static_site_and_old_class_remains_compatible(self) -> None:
        """Check private steward runs static site and old class remains compatible."""
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "front", "instructions": "Help."},
        ]))
        env: Dict[str, str] = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "mock-1",
            "NSDEPLOY_STEWARD_LLM_UPSTREAM": "mock://nsdeploy",
        }
        gateway: PublicAgentNetworkGateway = PublicAgentNetworkGateway()
        with patch.dict(os.environ, env, clear=False), \
             patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result: str = await gateway.async_invoke({
                "site_url": "https://harbor.example/harbor",
                "request": "help me",
            }, {})
        self.assertIn("facade mock", result)
        self.assertFalse(any(url.endswith("/mcp") for url in _StaticSiteClient.requests))
        self.assertIsInstance(PublicAgentMcpGateway(), PublicAgentNetworkGateway)

    async def test_private_steward_uses_its_llm_credentials_not_the_public_site(self) -> None:
        """Check private steward uses its llm credentials not the public site."""
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "front", "instructions": "Help."},
        ]))
        env: Dict[str, str] = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "private-model",
            "NSDEPLOY_STEWARD_LLM_UPSTREAM": "https://llm.example/v1",
        }
        with patch.dict(os.environ, env, clear=False), \
             patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result: str = await PublicAgentNetworkGateway().async_invoke({
                "site_url": "https://harbor.example/harbor",
                "request": "help me",
            }, {})
        self.assertEqual(result, "private runner result")
        self.assertEqual(_StaticSiteClient.posts[0][0], "https://llm.example/v1/chat/completions")
        self.assertEqual(_StaticSiteClient.posts[0][1]["model"], "private-model")
        self.assertEqual(_StaticSiteClient.posts[0][2]["Authorization"], "Bearer private-key")

    async def test_private_steward_falls_back_for_an_older_mcp_only_site(self) -> None:
        """Check private steward falls back for an older mcp only site."""
        gateway: PublicAgentNetworkGateway = PublicAgentNetworkGateway()
        env: Dict[str, str] = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "private-model",
        }
        fallback: AsyncMock
        with patch.dict(os.environ, env, clear=False), \
             patch.object(NetworkRunner, "from_public_site", side_effect=ValueError("no manifest")), \
             patch.object(gateway, "_invoke_mcp", return_value="legacy result") as fallback:
            result: str = await gateway.async_invoke({
                "site_url": "https://legacy.example/network",
                "request": "help me",
            }, {})
        self.assertEqual(result, "legacy result")
        fallback.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
