import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Dict
from typing import Optional
from unittest import mock

from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings
from nsdeploy_service.supervisor import Supervisor
from nsdeploy_service.upload_upstream import UploadUpstream


class TestUploadUpstream(unittest.TestCase):
    """
    Checks that a deploy upload cannot choose its own BYOK upstream.

    A site's /byok/v1 forwards every visitor's API key to the upstream, so an upload may not point it anywhere but
    the service-wide one. In the endpoint tests Supervisor.start is patched out, so an accepted upload is queued and
    recorded but no build process starts.
    """

    HOCON: bytes = b'{"tools": []}'
    SERVICE_UPSTREAM: str = "https://router.example/v1"
    OTHER_UPSTREAM: str = "https://uploader.example/v1"

    def setUp(self) -> None:
        """
        Create a temporary work root for each test.
        """
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        """
        Remove the temporary work root.
        """
        self._tmp.cleanup()

    def _client(self) -> TestClient:
        """
        Build a client for a service with a known upstream.

        :return: The test client, not yet started.
        """
        return TestClient(create_app(Settings(
            work_root=self.root, port_start=8930, port_end=8939, upstream=self.SERVICE_UPSTREAM)))

    @staticmethod
    def _stored_options(client: TestClient, deployment_id: str) -> Dict[str, Any]:
        """
        Read the options a deployment was recorded with.

        :param client: The open test client.
        :param deployment_id: The deployment to read.
        :return: The stored options, or an empty dict when there are none.
        """
        row: Dict[str, Any] = client.app.state.supervisor.store.get_deployment(deployment_id) or {}
        return row.get("options") or {}

    def test_no_upstream_or_a_blank_one_is_allowed(self) -> None:
        """
        An upload that leaves the upstream out, or sends an empty or blank one, may go ahead.
        """
        requested: Optional[str]
        # Each form of "not given" is accepted.
        for requested in (None, "", "   "):
            with self.subTest(requested=requested):
                self.assertIsNone(UploadUpstream.refusal(requested, self.SERVICE_UPSTREAM))

    def test_the_services_own_upstream_is_allowed(self) -> None:
        """
        The service's own upstream is allowed, with or without a trailing slash.
        """
        self.assertIsNone(UploadUpstream.refusal(self.SERVICE_UPSTREAM, self.SERVICE_UPSTREAM))
        self.assertIsNone(UploadUpstream.refusal(self.SERVICE_UPSTREAM + "/", self.SERVICE_UPSTREAM))

    def test_a_different_upstream_is_refused(self) -> None:
        """
        Any other upstream is refused, and the message names the service-wide setting.
        """
        refusal: Optional[str] = UploadUpstream.refusal(self.OTHER_UPSTREAM, self.SERVICE_UPSTREAM)
        self.assertEqual(refusal, UploadUpstream.REFUSAL)
        self.assertIn("NSDEPLOY_SERVICE_UPSTREAM", refusal)

    def test_a_different_upstream_is_refused_and_nothing_is_queued(self) -> None:
        """
        POST /deployments naming another upstream is a 400 and records nothing.
        """
        with self._client() as client, mock.patch.object(Supervisor, "start") as start:
            response = client.post(
                "/deployments",
                files={"file": ("demo.hocon", self.HOCON, "application/octet-stream")},
                data={"upstream": self.OTHER_UPSTREAM})
            listed: Dict[str, Any] = client.get("/deployments").json()
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("NSDEPLOY_SERVICE_UPSTREAM", response.json().get("detail", ""))
        self.assertEqual(listed.get("deployments"), [])
        self.assertEqual(start.call_count, 0)

    def test_the_raw_upload_path_refuses_it_too(self) -> None:
        """
        POST /deployments/raw naming another upstream is a 400 and records nothing.
        """
        with self._client() as client, mock.patch.object(Supervisor, "start") as start:
            response = client.post(
                "/deployments/raw",
                params={
                    "name": "demo",
                    "upstream": self.OTHER_UPSTREAM,
                },
                content=self.HOCON)
            listed: Dict[str, Any] = client.get("/deployments").json()
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("NSDEPLOY_SERVICE_UPSTREAM", response.json().get("detail", ""))
        self.assertEqual(listed.get("deployments"), [])
        self.assertEqual(start.call_count, 0)

    def test_an_upload_without_upstream_is_accepted(self) -> None:
        """
        POST /deployments without an upstream is queued as usual.
        """
        with self._client() as client, mock.patch.object(Supervisor, "start") as start:
            response = client.post(
                "/deployments",
                files={"file": ("demo.hocon", self.HOCON, "application/octet-stream")},
                data={"org_name": "Acme Logistics"})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json().get("status"), "queued")
        self.assertEqual(start.call_count, 1)

    def test_the_services_own_upstream_is_accepted_and_not_stored(self) -> None:
        """
        The service's own upstream passes, and the record does not keep it.
        """
        # The console sends the service upstream on every Launch (deploy.js), so
        # refusing that value would break the Launch button.
        with self._client() as client, mock.patch.object(Supervisor, "start") as start:
            response = client.post(
                "/deployments",
                files={"file": ("demo.hocon", self.HOCON, "application/octet-stream")},
                data={"upstream": self.SERVICE_UPSTREAM})
            options: Dict[str, Any] = self._stored_options(client, response.json().get("id", ""))
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(start.call_count, 1)
        self.assertIn("name", options)
        self.assertIsNone(options.get("upstream"))

    def test_a_blank_upstream_counts_as_not_given(self) -> None:
        """
        An empty or blank upstream is accepted on both upload paths.
        """
        with self._client() as client, mock.patch.object(Supervisor, "start") as start:
            raw = client.post(
                "/deployments/raw",
                params={
                    "name": "demo_raw",
                    "upstream": "",
                },
                content=self.HOCON)
            form = client.post(
                "/deployments",
                files={"file": ("demo_form.hocon", self.HOCON, "application/octet-stream")},
                data={"upstream": "   "})
        self.assertEqual(raw.status_code, 202, raw.text)
        self.assertEqual(form.status_code, 202, form.text)
        self.assertEqual(start.call_count, 2)


if __name__ == "__main__":
    unittest.main()
