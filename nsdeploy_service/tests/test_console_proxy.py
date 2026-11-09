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
    CORS_ORIGIN: str = "https://app.example.com"

    def setUp(self) -> None:
        """
        Start one service with the proxy on and one with it off, both requiring `TOKEN`.
        """
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        work = Path(self._tmp.name)
        on_settings = Settings(work_root=work / "on", port_start=8730, port_end=8739, api_token=self.TOKEN,
                               console_proxy=True)
        off_settings = Settings(work_root=work / "off", port_start=8740, port_end=8749, api_token=self.TOKEN,
                                cors_origins=[self.CORS_ORIGIN])
        self.on_client = TestClient(create_app(on_settings))
        self.off_client = TestClient(create_app(off_settings))
        self.on_client.__enter__()  # pylint: disable=unnecessary-dunder-call; left in tearDown
        self.off_client.__enter__()  # pylint: disable=unnecessary-dunder-call; left in tearDown

    def tearDown(self) -> None:
        """
        Stop both services and remove their work directories.
        """
        self.on_client.__exit__(None, None, None)
        self.off_client.__exit__(None, None, None)
        self._tmp.cleanup()

    def _call(self, method: str, path: str, console_proxy: bool = True, token: Optional[str] = None,
              headers: Optional[Dict[str, str]] = None) -> Response:
        """
        Make one request.

        :param method: The HTTP method.
        :param path: The request path, including any query.
        :param console_proxy: Whether to call the service with the proxy on.
        :param token: The bearer token the caller sends, or None to send none.
        :param headers: Other request headers.
        :return: The response.
        """
        sent: Dict[str, str] = dict(headers or {})
        if token is not None:
            sent["Authorization"] = f"Bearer {token}"
        client: TestClient = self.on_client if console_proxy else self.off_client
        return client.request(method, path, headers=sent)

    def test_console_requests_get_the_token(self) -> None:
        """
        A request the console makes succeeds without a token from the caller.
        """
        response = self._call("GET", "/console-api/deployments")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json().get("deployments"), [])

    def test_path_is_passed_on(self) -> None:
        """
        The request reaches its route with its path intact.
        """
        response = self._call("GET", "/console-api/deployments/abc123/logs")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json().get("detail"), "no deployment 'abc123'")

    def test_query_is_passed_on(self) -> None:
        """
        The request reaches its route with its query intact.
        """
        response = self._call("GET", "/console-api/deployments/abc123/logs?tail=-1")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json().get("detail")[0].get("loc"), ["query", "tail"])

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
                response = self._call(method, path)
                self.assertEqual(response.status_code, 403)
                self.assertTrue(response.json().get("detail").endswith("isn't a console request"))

    def test_head_is_treated_as_get(self) -> None:
        """
        HEAD on a GET the console makes is passed on rather than refused.
        """
        self.assertNotEqual(self._call("HEAD", "/console-api/health").status_code, 403)

    def test_cross_site_requests_are_refused(self) -> None:
        """
        A browser request from another site gets a 403, including one that needs no CORS preflight.
        """
        # Each of these is how a browser marks a request from a page on another origin.
        headers: Dict[str, str]
        for headers in ({"Origin": "https://evil.example.com"}, {"Origin": "null"},
                        {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                        {"Origin": "http://testserver", "Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                response = self._call("POST", "/console-api/deployments", headers=headers)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json().get("detail"), "/console-api refuses requests from another site")

    def test_same_origin_requests_are_passed_on(self) -> None:
        """
        A request from the console's own page is passed on.
        """
        # Each of these is how a browser marks a request from the same origin.
        headers: Dict[str, str]
        for headers in ({"Origin": "http://testserver"}, {"Sec-Fetch-Site": "same-origin"},
                        {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}):
            with self.subTest(headers=headers):
                self.assertEqual(self._call("GET", "/console-api/orgs", headers=headers).status_code, 200)

    def test_settings_leave_out_the_key_endings(self) -> None:
        """
        GET /console-api/settings says the token is set without showing any of it.
        """
        proxied = self._call("GET", "/console-api/settings").json().get("nsdeploy_api_token")
        self.assertEqual(proxied, {"is_set": True, "last4": "", "managed_by_admin_panel": False})
        direct = self._call("GET", "/settings", token=self.TOKEN).json().get("nsdeploy_api_token")
        self.assertEqual(direct.get("last4"), "cret")

    def test_health_warns_while_on(self) -> None:
        """
        /health warns while the proxy is on, and not while it is off.
        """
        self.assertIn(Settings.CONSOLE_PROXY_WARNING, self._call("GET", "/health").json().get("warnings"))
        off_warnings = self._call("GET", "/health", console_proxy=False).json().get("warnings")
        self.assertNotIn(Settings.CONSOLE_PROXY_WARNING, off_warnings)

    def test_off_passes_the_callers_token_through(self) -> None:
        """
        With `console_proxy` off, console requests need the caller's own token, as direct requests do.
        """
        self.assertEqual(self._call("GET", "/console-api/deployments", console_proxy=False).status_code, 401)
        response = self._call("GET", "/console-api/deployments", console_proxy=False, token=self.TOKEN)
        self.assertEqual(response.status_code, 200)

    def test_off_is_a_plain_alias(self) -> None:
        """
        With `console_proxy` off, the allowlist does not apply, so a console request missing from it still works.
        """
        response = self._call("GET", "/console-api/relations", console_proxy=False, token=self.TOKEN)
        self.assertEqual(response.status_code, self._call("GET", "/relations", console_proxy=False,
                                                          token=self.TOKEN).status_code)
        self.assertNotEqual(response.status_code, 403)

    def test_off_answers_cors_preflights(self) -> None:
        """
        With `console_proxy` off, a console on another allowed origin gets its preflights answered.
        """
        headers: Dict[str, str] = {"Origin": self.CORS_ORIGIN, "Access-Control-Request-Method": "POST"}
        response = self._call("OPTIONS", "/console-api/deployments", console_proxy=False, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("access-control-allow-origin"), self.CORS_ORIGIN)

    def test_a_token_that_cannot_be_sent_is_refused(self) -> None:
        """
        POST /settings refuses a token the proxy could not put in a header.
        """
        response = self.off_client.post("/settings", json={"nsdeploy_api_token": "s3crèt"},
                                        headers={"Authorization": f"Bearer {self.TOKEN}"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json().get("detail"), "the API token must be printable ASCII")
