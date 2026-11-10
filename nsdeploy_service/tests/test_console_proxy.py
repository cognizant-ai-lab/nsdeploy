import tempfile
import unittest
from pathlib import Path
from typing import Dict
from typing import Optional

from fastapi.testclient import TestClient
from httpx import Response

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings


class TestConsoleProxy(unittest.TestCase):
    """
    /console-api adds the server's API token to the requests the console makes, and refuses every other request.
    """

    TOKEN: str = "s3cret"

    def setUp(self) -> None:
        """
        Create a work directory for the service.
        """
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.work = Path(self._tmp.name)

    def tearDown(self) -> None:
        """
        Remove the work directory.
        """
        self._tmp.cleanup()

    def _call(self, method: str, path: str, console_proxy: bool = True, token: Optional[str] = None) -> Response:
        """
        Make one request to a service that requires `TOKEN`.

        :param method: The HTTP method.
        :param path: The request path, including any query.
        :param console_proxy: The value of `console_proxy`.
        :param token: The bearer token the caller sends, or None to send none.
        :return: The response.
        """
        settings = Settings(work_root=self.work, port_start=8730, port_end=8739, api_token=self.TOKEN,
                            console_proxy=console_proxy)
        headers: Dict[str, str] = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        with TestClient(create_app(settings)) as client:
            return client.request(method, path, headers=headers)

    def test_console_requests_get_the_token(self) -> None:
        """
        A request the console makes succeeds without a token from the caller.
        """
        response = self._call("GET", "/console-api/deployments")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("deployments"), [])

    def test_query_and_path_parameters_are_passed_on(self) -> None:
        """
        The request reaches its route with its path and query intact.
        """
        response = self._call("GET", "/console-api/deployments/abc123/logs?tail=5")
        self.assertEqual(response.status_code, 404)

    def test_the_callers_token_is_replaced(self) -> None:
        """
        A wrong token from the caller is replaced by the server's.
        """
        self.assertEqual(self._call("GET", "/console-api/orgs", token="wrong").status_code, 200)

    def test_direct_requests_still_need_the_token(self) -> None:
        """
        The proxy does not open the API itself.
        """
        self.assertEqual(self._call("GET", "/deployments").status_code, 401)
        self.assertEqual(self._call("GET", "/deployments", token=self.TOKEN).status_code, 200)

    def test_other_requests_are_refused(self) -> None:
        """
        Requests the console does not make get a 403, so the token cannot be used for them.
        """
        # Each of these would otherwise reach a route that needs the token.
        method: str
        path: str
        for method, path in (("POST", "/console-api/settings"), ("POST", "/console-api/bundles"),
                             ("POST", "/console-api/deployments/raw"), ("GET", "/console-api/relations"),
                             ("GET", "/console-api/deployments/abc123/bundle"), ("GET", "/console-api/deployments/"),
                             ("GET", "/console-api/orgs/abc123/deployments"), ("OPTIONS", "/console-api/deployments"),
                             ("GET", "/console-api/deployments/abc123%2Fbundle")):
            with self.subTest(method=method, path=path):
                self.assertEqual(self._call(method, path).status_code, 403)

    def test_off_passes_the_callers_token_through(self) -> None:
        """
        With `console_proxy` off, console requests need the caller's own token, as direct requests do.
        """
        self.assertEqual(self._call("GET", "/console-api/deployments", console_proxy=False).status_code, 401)
        response = self._call("GET", "/console-api/deployments", console_proxy=False, token=self.TOKEN)
        self.assertEqual(response.status_code, 200)

    def test_off_still_refuses_other_requests(self) -> None:
        """
        With `console_proxy` off, the allowlist still applies.
        """
        response = self._call("POST", "/console-api/settings", console_proxy=False, token=self.TOKEN)
        self.assertEqual(response.status_code, 403)
