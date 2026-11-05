import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings


HOCON = b"""{
  metadata = { description = "A tiny persistent static deployment." }
  tools = [{
    name = "front_agent"
    instructions = "Answer concise demonstration questions."
    function = { description = "Answers small demonstration questions." }
    tools = []
  }]
}
"""


class StaticDeploymentEndpointTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.settings = Settings(
            work_root=self.root / "work", ui_dir=self.root / "missing-ui",
            port=9700, port_start=8980, port_end=8980, max_deployments=1,
        )

    def tearDown(self):
        self._tmp.cleanup()

    def _deploy(self, client: TestClient):
        response = client.post(
            "/deployments",
            files={"file": ("tiny_network.hocon", HOCON, "text/plain")},
            data={"org_name": "Static Team", "deployment_mode": "static_bundle"},
        )
        self.assertEqual(response.status_code, 202, response.text)
        deployment_id = response.json()["id"]
        settled = client.get(f"/deployments/{deployment_id}/wait?timeout=30")
        self.assertEqual(settled.status_code, 200, settled.text)
        return settled.json()

    def test_bundle_deployment_uses_service_url_and_no_port(self):
        with TestClient(create_app(self.settings)) as client:
            view = self._deploy(client)
            self.assertEqual(view["status"], "ready")
            self.assertEqual(view["deployment_mode"], "static_bundle")
            self.assertIsNone(view["port"])
            self.assertIsNone(view["pid"])
            self.assertEqual(view["url"], "http://testserver/sites/tiny_network")

            site = client.get("/sites/tiny_network/")
            self.assertEqual(site.status_code, 200)
            self.assertIn("front_agent", client.get(
                "/sites/tiny_network/tiny_network.network.json").text)
            manifest = client.get("/sites/tiny_network/agent-manifest.json")
            self.assertEqual(manifest.status_code, 200)
            self.assertEqual(manifest.headers["access-control-allow-origin"], "*")
            self.assertEqual(manifest.json()["deployment"]["mode"], "static")

            graph = client.get("/graph").json()
            self.assertEqual(graph["nodes"][0]["url"], view["url"])
            self.assertEqual(client.get("/health").json()["port_pool"]["reserved"], [])

    def test_ready_bundle_survives_service_restart_and_can_be_stopped(self):
        with TestClient(create_app(self.settings)) as client:
            view = self._deploy(client)
            deployment_id = view["id"]

        with TestClient(create_app(self.settings)) as client:
            current = client.get(f"/deployments/{deployment_id}").json()
            self.assertEqual(current["status"], "ready")
            self.assertEqual(current["url"], view["url"])
            self.assertEqual(client.get(f"/sites/{deployment_id}/").status_code, 200)

            stopped = client.delete(f"/deployments/{deployment_id}")
            self.assertEqual(stopped.status_code, 200)
            self.assertEqual(stopped.json()["status"], "stopped")
            self.assertEqual(client.get(f"/sites/{deployment_id}/").status_code, 404)

    def test_console_requests_static_bundle_mode(self):
        source = (Path(__file__).parents[1] / "ui" / "assets" / "js" /
                  "views" / "deploy.js").read_text(encoding="utf-8")
        self.assertIn("form.append('deployment_mode', 'static_bundle')", source)

    def test_same_name_in_another_org_replaces_and_keeps_named_url(self):
        with TestClient(create_app(self.settings)) as client:
            first = self._deploy(client)
            response = client.post(
                "/deployments",
                files={"file": ("tiny_network.hocon", HOCON, "text/plain")},
                data={"org_name": "Another Team", "deployment_mode": "static_bundle"},
            )
            self.assertEqual(response.status_code, 202, response.text)
            second = response.json()
            self.assertEqual(second["id"], first["id"])
            self.assertTrue(second["replaced"])
            self.assertEqual(second["org_name"], "Another Team")
            settled = client.get(f"/deployments/{second['id']}/wait?timeout=30")
            self.assertEqual(settled.json()["status"], "ready")
            self.assertEqual(
                settled.json()["url"], "http://testserver/sites/tiny_network")
            self.assertEqual(client.get("/sites/tiny_network/").status_code, 200)


if __name__ == "__main__":
    unittest.main()
