import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeployOptions

# The same self-contained network the bundler tests use: it includes nothing from
# neuro-san-studio, so every build here resolves against an empty local checkout and
# never reaches the network.
HELLO_SHOP = """
{
    "llm_config": { "model_name": "gpt-4o" },
    "metadata": {
        "description": "A corner shop assistant.",
        "sample_queries": ["What flavours do you have today?"]
    },
    "tools": [
        {
            "name": "shop_assistant",
            "function": { "description": "Answer a customer." },
            "instructions": "You are the assistant of a small corner shop.",
            "tools": ["order_desk"]
        },
        {
            "name": "order_desk",
            "function": { "description": "Write down one order." },
            "instructions": "You take one order and repeat it back."
        }
    ]
}
"""


class DeploymentBundleTest(unittest.TestCase):
    """A bundle for a network which is already deployed.

    The deployments here are fabricated rather than built: `create` writes the work
    dir and the HOCON, and the record is then flipped to the status under test. That
    keeps every case to the one thing it is about — no child process is started and
    no site is served, because a bundle is rebuilt from the HOCON and never from the
    served tree.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        # An empty checkout, so includes resolve locally and GithubStudio is never
        # constructed. The test network has no includes, so there is nothing to find.
        (self.root / "studio").mkdir()
        self.client = None

    def tearDown(self) -> None:
        if self.client is not None:
            self.client.__exit__(None, None, None)
        self._tmp.cleanup()

    def _open(self, **overrides: Any):
        """
        Start one service and keep it open for the length of the test.

        :param overrides: Settings overrides for this test.
        :return: The test client.
        """
        from fastapi.testclient import TestClient

        from nsdeploy_service.app import create_app

        settings = Settings(studio=str(self.root / "studio"),
                            work_root=self.root / "work",
                            port_start=8700, port_end=8709, **overrides)
        self.client = TestClient(create_app(settings))
        self.client.__enter__()
        return self.client

    def _deploy(self, client, status: str = "ready",
                options: Optional[DeployOptions] = None) -> Dict[str, Any]:
        """
        Fabricate one deployment at a chosen status, without building it.

        :param client: The open test client.
        :param status: The status to record.
        :param options: The deploy options to record, if not the defaults.
        :return: The persisted record.
        """
        supervisor = client.app.state.supervisor
        wanted: DeployOptions = options or DeployOptions(name="hello_shop")
        dep = supervisor.create(HELLO_SHOP.encode("utf-8"), wanted)
        row: Dict[str, Any] = dep.as_row()
        row["status"] = status
        row["url"] = f"http://127.0.0.1:{dep.port}"
        supervisor.store.save_deployment(row)
        return supervisor.store.get_deployment(dep.id)

    @staticmethod
    def _names(payload: bytes) -> List[str]:
        """
        Every path in an archive.

        :param payload: The archive bytes.
        :return: The sorted member names.
        """
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            return sorted(archive.getnames())

    @staticmethod
    def _text(payload: bytes, path: str) -> str:
        """
        One file out of an archive.

        :param payload: The archive bytes.
        :param path: The member to read.
        :return: The member's contents as text.
        """
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            handle = archive.extractfile(path)
            return handle.read().decode("utf-8")

    # --- what the endpoint refuses ----------------------------------------
    def test_an_unknown_deployment_is_a_404(self):
        client = self._open()
        response = client.get("/deployments/nosuchid/bundle")
        self.assertEqual(response.status_code, 404)

    def test_a_deployment_with_nothing_built_yet_is_a_409(self):
        """`queued` and `building` have produced no site yet, and `failed` tried
        and could not. None of the three has anything finished to hand over."""
        client = self._open()
        # One deployment for each status which must be refused.
        for status in ("queued", "building", "failed"):
            with self.subTest(status=status):
                row = self._deploy(client, status=status)
                response = client.get(f"/deployments/{row['id']}/bundle")
                self.assertEqual(response.status_code, 409)
                self.assertIn(status, response.json()["detail"])

    def test_a_stopped_deployment_still_builds(self):
        """A network does not stop being worth packaging when its process is torn
        down. The HOCON and the editable source outlive the site, so taking a
        deployment down and then wanting it as a static site is an ordinary order
        of events."""
        client = self._open()
        row = self._deploy(client, status="stopped")
        response = client.get(f"/deployments/{row['id']}/bundle")
        self.assertEqual(response.status_code, 200)
        self.assertIn("index.html", self._names(response.content))

    def test_a_stopped_deployment_bundles_the_same_as_a_ready_one(self):
        """Status gates the request; it is not an input to the build. A bundle is
        made from the HOCON and the editable source, and neither changes when the
        process goes away."""
        client = self._open()
        live = self._deploy(client, status="ready")
        running = client.get(f"/deployments/{live['id']}/bundle")
        supervisor = client.app.state.supervisor
        stopped_row = dict(supervisor.store.get_deployment(live["id"]))
        stopped_row["status"] = "stopped"
        supervisor.store.save_deployment(stopped_row)
        torn_down = client.get(f"/deployments/{live['id']}/bundle")
        self.assertEqual(torn_down.status_code, 200)
        self.assertEqual(torn_down.content, running.content)

    def test_a_record_whose_hocon_is_gone_is_a_410_not_a_404(self):
        """The deployment is real; it is its source which is missing. A 404 would
        say the id is wrong and send the caller looking in the wrong place."""
        client = self._open()
        row = self._deploy(client)
        Path(row["hocon_path"]).unlink()
        response = client.get(f"/deployments/{row['id']}/bundle")
        self.assertEqual(response.status_code, 410)
        self.assertIn("no longer on disk", response.json()["detail"])

    # --- what it returns ---------------------------------------------------
    def test_returns_the_archive_and_describes_it_in_the_headers(self):
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle",
                              params={"site_url": "https://shop.example.com"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/gzip")
        self.assertEqual(response.headers["content-disposition"],
                         'attachment; filename="hello_shop.tar.gz"')
        self.assertEqual(response.headers["x-bundle-name"], "hello_shop")
        self.assertEqual(len(response.headers["x-bundle-sha256"]), 64)
        self.assertGreater(int(response.headers["x-bundle-files"]), 0)
        self.assertIn("index.html", self._names(response.content))

    def test_the_response_may_not_be_cached(self):
        """A GET is cacheable by default, and the deployment's look can change under
        it at any time through POST /deployments/{id}/theme-spec."""
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_the_bundle_is_static_rather_than_a_copy_of_the_served_site(self):
        """The served tree is generated for a server. A bundle addresses its own
        files relatively and carries no links endpoint, so the two cannot be the
        same bytes however convenient that would be."""
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle")
        index = self._text(response.content, "index.html")
        self.assertIn("./theme.css", index)
        self.assertNotIn('href="/theme.css"', index)
        manifest = json.loads(self._text(response.content, "agent-manifest.json"))
        linking = manifest.get("linking") or {}
        self.assertEqual(linking.get("link_updates"), {"mode": "browser-local"})
        self.assertNotIn("links_endpoint", linking)
        self.assertFalse((manifest.get("agent_mcp") or {}).get("available"))
        self.assertEqual((manifest.get("deployment") or {}).get("mode"), "static")

    def test_the_deployments_own_url_is_never_baked_in(self):
        """It is this service's loopback port. A bundle that carried it would be
        unusable everywhere it is meant to be hosted."""
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle")
        manifest = self._text(response.content, "agent-manifest.json")
        self.assertNotIn(row["url"], manifest)

    def test_the_site_url_is_baked_in_when_it_is_given(self):
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle",
                              params={"site_url": "https://shop.example.com/corner"})
        manifest = json.loads(self._text(response.content, "agent-manifest.json"))
        linking = manifest.get("linking") or {}
        self.assertEqual(linking.get("site"), "https://shop.example.com/corner")

    def test_nothing_about_the_bundle_reaches_the_deployment(self):
        """The record and the work dir are read, never written. A bundle request
        that restyled or rebuilt a live site would be a surprising GET."""
        client = self._open()
        row = self._deploy(client)
        work = Path(row["work_dir"])
        before = sorted(path.name for path in work.iterdir())
        client.get(f"/deployments/{row['id']}/bundle")
        after = sorted(path.name for path in work.iterdir())
        self.assertEqual(before, after)
        self.assertEqual(client.get(f"/deployments/{row['id']}").json()["status"],
                         "ready")

    # --- what it inherits from the deployment ------------------------------
    def test_the_look_is_taken_from_the_deployments_editable_source(self):
        """Editable source is what the deployment's next build would use and what a
        token edit writes to, so it is what the deployment's look *is*."""
        client = self._open()
        row = self._deploy(client)
        source = Path(row["work_dir"]) / "site-source"
        source.mkdir(parents=True, exist_ok=True)
        (source / "theme.json").write_text(
            json.dumps({"brand": "Corner Shop", "colors": {"primary": "#ff00ff"}}),
            encoding="utf-8")
        response = client.get(f"/deployments/{row['id']}/bundle")
        self.assertIn("#ff00ff", self._text(response.content, "theme.css"))
        manifest = self._text(response.content, "agent-manifest.json")
        self.assertIn("Corner Shop", manifest)

    def test_a_deployment_with_no_theme_on_disk_says_so(self):
        """It still builds — the default look is a look — but silence would leave a
        client wondering why the bundle does not match the site."""
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle")
        reported = json.loads(response.headers["x-bundle-warnings"])
        self.assertTrue(any("default look" in line for line in reported),
                        f"no default-look warning in {reported}")

    def test_the_warnings_name_what_the_deployment_has_and_the_bundle_cannot(self):
        client = self._open()
        row = self._deploy(client)
        response = client.get(f"/deployments/{row['id']}/bundle")
        reported = json.loads(response.headers["x-bundle-warnings"])
        self.assertTrue(any("rebuilt from the deployment" in line for line in reported),
                        f"no rebuild warning in {reported}")

    def test_the_upstream_is_the_deployments_own_unless_overridden(self):
        client = self._open()
        row = self._deploy(client, options=DeployOptions(
            name="hello_shop", upstream="https://llm.example.com/v1"))
        response = client.get(f"/deployments/{row['id']}/bundle")
        self.assertIn("https://llm.example.com/v1",
                      self._text(response.content, "agent-manifest.json"))

    def test_an_upstream_query_overrides_the_deployments_own(self):
        client = self._open()
        row = self._deploy(client, options=DeployOptions(
            name="hello_shop", upstream="https://llm.example.com/v1"))
        response = client.get(f"/deployments/{row['id']}/bundle",
                              params={"upstream": "https://other.example.com/v1"})
        manifest = self._text(response.content, "agent-manifest.json")
        self.assertIn("https://other.example.com/v1", manifest)
        self.assertNotIn("https://llm.example.com/v1", manifest)

    def test_two_calls_with_one_deployment_give_one_archive(self):
        """The packer flattens ownership, mode and timestamps, so a client can tell
        a rebuild from a re-send by the digest alone."""
        client = self._open()
        row = self._deploy(client)
        first = client.get(f"/deployments/{row['id']}/bundle")
        second = client.get(f"/deployments/{row['id']}/bundle")
        self.assertEqual(first.content, second.content)
        self.assertEqual(first.headers["x-bundle-sha256"],
                         second.headers["x-bundle-sha256"])


if __name__ == "__main__":
    unittest.main()
