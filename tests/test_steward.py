import json
import os
import unittest
from unittest.mock import patch

from nsdeploy.byok import ByokCredentials
from nsdeploy.facade import NetworkRunner, load_published_network
from nsdeploy.steward import PublicAgentMcpGateway, PublicAgentNetworkGateway


class _Response:
    def __init__(self, body, status=200):
        self.body = body
        self.status_code = status
        self.content = json.dumps(body).encode()

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _StaticSiteClient:
    routes = {}
    requests = []
    posts = []

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url):
        type(self).requests.append(url)
        if url not in type(self).routes:
            raise RuntimeError(f"unexpected request: {url}")
        return _Response(type(self).routes[url])

    async def post(self, url, content, headers):
        type(self).posts.append((url, json.loads(content), dict(headers)))
        return _Response({"choices": [{"message": {
            "role": "assistant", "content": "private runner result",
        }}]})


def _site(name, tools, front_man=None):
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
    def setUp(self):
        _StaticSiteClient.routes = {}
        _StaticSiteClient.requests = []
        _StaticSiteClient.posts = []

    async def test_loader_fetches_exact_static_network_and_rejects_server_code(self):
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "helper", "instructions": "Assist."},
            {"name": "front", "instructions": "Help."},
        ], front_man="front"))
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            published = await load_published_network("https://harbor.example/harbor")
        self.assertEqual(published.network, "harbor")
        self.assertEqual(published.front_man, "front")

        _StaticSiteClient.routes.update(_site("unsafe", [
            {"name": "front", "instructions": "Help."},
            {"name": "code", "class": "untrusted.Tool"},
        ]))
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            with self.assertRaisesRegex(ValueError, "executable server-side"):
                await load_published_network("https://unsafe.example/unsafe")

    async def test_loader_supports_static_bundle_below_domain_root(self):
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
            published = await load_published_network(
                "https://cdn.example/agents/harbor"
            )
        self.assertEqual(published.site_base, "https://cdn.example/agents")
        self.assertEqual(published.front_man, "front")

    async def test_deny_policy_blocks_before_fetching_public_data(self):
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

    async def test_runner_recursively_fetches_public_network_without_mcp_facade(self):
        child_tools = [{"name": "child_front", "instructions": "Answer."}]
        _StaticSiteClient.routes.update(_site("child", child_tools))
        root_config = {"tools": [{
            "name": "root_front",
            "instructions": "Delegate.",
            "tools": ["https://child.example/child"],
        }]}
        runner = NetworkRunner(
            root_config, "https://root.example", "mock://nsdeploy",
            credentials=ByokCredentials("Bearer private", "mock-1"),
            public_network_mode="fetch", network_name="root",
        )
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result = await runner.run("ask the child", "root_front")
        self.assertIn("facade mock", result)
        self.assertEqual(_StaticSiteClient.requests, [
            "https://child.example/agent-manifest.json",
            "https://child.example/child.network.json",
        ])
        self.assertFalse(any(url.endswith("/mcp") for url in _StaticSiteClient.requests))

    async def test_recursive_fetch_stops_a_public_network_cycle(self):
        _StaticSiteClient.routes.update(_site("child", [{
            "name": "child_front",
            "instructions": "Delegate back.",
            "tools": ["https://root.example/root"],
        }]))
        _StaticSiteClient.routes.update(_site("root", [{
            "name": "root_front", "instructions": "Delegate.",
            "tools": ["https://child.example/child"],
        }]))
        runner = NetworkRunner(
            _StaticSiteClient.routes["https://root.example/root.network.json"],
            "https://root.example", "mock://nsdeploy",
            credentials=ByokCredentials("Bearer private", "mock-1"),
            public_network_mode="fetch", network_name="root",
        )
        with patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result = await runner.run("ask both", "root_front")
        self.assertIn("Skipped recursive call", result)

    async def test_private_steward_runs_static_site_and_old_class_remains_compatible(self):
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "front", "instructions": "Help."},
        ]))
        env = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "mock-1",
            "NSDEPLOY_STEWARD_LLM_UPSTREAM": "mock://nsdeploy",
        }
        gateway = PublicAgentNetworkGateway()
        with patch.dict(os.environ, env, clear=False), \
             patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result = await gateway.async_invoke({
                "site_url": "https://harbor.example/harbor",
                "request": "help me",
            }, {})
        self.assertIn("facade mock", result)
        self.assertFalse(any(url.endswith("/mcp") for url in _StaticSiteClient.requests))
        self.assertIsInstance(PublicAgentMcpGateway(), PublicAgentNetworkGateway)

    async def test_private_steward_uses_its_llm_credentials_not_the_public_site(self):
        _StaticSiteClient.routes.update(_site("harbor", [
            {"name": "front", "instructions": "Help."},
        ]))
        env = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "private-model",
            "NSDEPLOY_STEWARD_LLM_UPSTREAM": "https://llm.example/v1",
        }
        with patch.dict(os.environ, env, clear=False), \
             patch("nsdeploy.facade.httpx.AsyncClient", _StaticSiteClient):
            result = await PublicAgentNetworkGateway().async_invoke({
                "site_url": "https://harbor.example/harbor",
                "request": "help me",
            }, {})
        self.assertEqual(result, "private runner result")
        self.assertEqual(_StaticSiteClient.posts[0][0], "https://llm.example/v1/chat/completions")
        self.assertEqual(_StaticSiteClient.posts[0][1]["model"], "private-model")
        self.assertEqual(_StaticSiteClient.posts[0][2]["Authorization"], "Bearer private-key")

    async def test_private_steward_falls_back_for_an_older_mcp_only_site(self):
        gateway = PublicAgentNetworkGateway()
        env = {
            "NSDEPLOY_STEWARD_BYOK_API_KEY": "private-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "private-model",
        }
        with patch.dict(os.environ, env, clear=False), \
             patch.object(NetworkRunner, "from_public_site", side_effect=ValueError("no manifest")), \
             patch.object(gateway, "_invoke_mcp", return_value="legacy result") as fallback:
            result = await gateway.async_invoke({
                "site_url": "https://legacy.example/network",
                "request": "help me",
            }, {})
        self.assertEqual(result, "legacy result")
        fallback.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
