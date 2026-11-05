import tempfile
import unittest
from pathlib import Path
from typing import Any, List

from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings

ORIGIN = "https://console.example.com"


class CorsSettingsTest(unittest.TestCase):
    """What CORS_ORIGINS accepts, and what it refuses at start-up."""

    @staticmethod
    def _settings(origins: List[str]) -> Settings:
        return Settings(cors_origins=origins, port_start=8100, port_end=8199)

    def test_no_origins_by_default(self):
        """The default has to stay "no CORS at all", because adding the middleware
        changes every response — Vary at minimum — on a service that answers a
        same-origin console today."""
        self.assertEqual(Settings().cors_origins, [])

    def test_accepts_an_origin_with_and_without_a_port(self):
        """Origins with and without a port are accepted."""
        settings = self._settings([ORIGIN, "http://127.0.0.1:5173"])
        settings.validate()
        self.assertEqual(settings.cors_allowed_origins(),
                         [ORIGIN, "http://127.0.0.1:5173"])

    def test_a_trailing_slash_is_removed_rather_than_refused(self):
        """The usual way to write it, and a literal match would never fire — the
        Origin header has no trailing slash."""
        settings = self._settings([ORIGIN + "/"])
        settings.validate()
        self.assertEqual(settings.cors_allowed_origins(), [ORIGIN])

    def test_accepts_a_lone_wildcard(self):
        """A lone wildcard is accepted."""
        settings = self._settings(["*"])
        settings.validate()
        self.assertEqual(settings.cors_allowed_origins(), ["*"])

    def test_refuses_a_wildcard_mixed_with_named_origins(self):
        """A wildcard mixed with named origins is refused."""
        with self.assertRaises(ValueError) as caught:
            self._settings(["*", ORIGIN]).validate()
        self.assertIn("alongside named origins", str(caught.exception))

    def test_refuses_an_entry_with_a_path(self):
        """A browser sends scheme://host[:port] and nothing else, so an entry with a
        path silently matches nothing."""
        with self.assertRaises(ValueError) as caught:
            self._settings([ORIGIN + "/app"]).validate()
        self.assertIn("path, query or fragment", str(caught.exception))

    def test_refuses_a_bare_hostname(self):
        """A bare hostname is refused."""
        with self.assertRaises(ValueError) as caught:
            self._settings(["console.example.com"]).validate()
        self.assertIn("is not an origin", str(caught.exception))

    def test_refuses_a_wildcard_host(self):
        """CORSMiddleware matches literally; '*.example.com' is not a pattern to it."""
        with self.assertRaises(ValueError) as caught:
            self._settings(["https://*.example.com"]).validate()
        self.assertIn("wildcard", str(caught.exception))


class CorsResponseTest(unittest.TestCase):
    """What a cross-origin caller actually gets back."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self, **overrides: Any):
        settings = Settings(work_root=self.root / "work",
                            port_start=8700, port_end=8709, **overrides)
        return TestClient(create_app(settings))

    def test_no_cors_headers_when_no_origin_is_configured(self):
        """The default must not change: a service that sends no CORS headers today
        still sends none after this feature exists."""
        with self._client() as client:
            response = client.get("/health", headers={"Origin": ORIGIN})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_a_listed_origin_is_allowed(self):
        """A listed origin receives the allow-origin header."""
        with self._client(cors_origins=[ORIGIN]) as client:
            response = client.get("/health", headers={"Origin": ORIGIN})
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)

    def test_an_unlisted_origin_is_not_allowed(self):
        """An unlisted origin receives no allow-origin header."""
        with self._client(cors_origins=[ORIGIN]) as client:
            response = client.get("/health",
                                  headers={"Origin": "https://evil.example.com"})
        # The request still answers — CORS is enforced by the browser, not here —
        # but without the header the browser refuses to hand it to the page.
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_a_preflight_is_answered_for_a_bundle_build(self):
        """POST /bundles with an Authorization header is never a simple request, so a
        browser preflights it. Without this the client never sends the real one."""
        with self._client(cors_origins=[ORIGIN]) as client:
            response = client.options("/bundles", headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)
        allowed = response.headers["access-control-allow-headers"].lower()
        self.assertIn("authorization", allowed)
        self.assertIn("content-type", allowed)
        self.assertIn("POST", response.headers["access-control-allow-methods"])

    def test_the_bundle_headers_are_exposed(self):
        """A browser hides every response header a server does not name here, so an
        archive fetched cross-origin would arrive with no name, digest or warnings."""
        with self._client(cors_origins=[ORIGIN]) as client:
            response = client.get("/health", headers={"Origin": ORIGIN})
        exposed = response.headers["access-control-expose-headers"].lower()
        for name in ("x-bundle-name", "x-bundle-sha256", "x-bundle-files",
                     "x-bundle-unpacked-bytes", "x-bundle-warnings",
                     "content-disposition", "location"):
            self.assertIn(name, exposed)

    def test_credentials_are_never_allowed(self):
        """This API authenticates with a bearer header, never a cookie. Allowing
        credentials would forbid '*' outright and make a listed origin able to act as
        whoever is signed in."""
        with self._client(cors_origins=[ORIGIN]) as client:
            response = client.get("/health", headers={"Origin": ORIGIN})
        self.assertNotIn("access-control-allow-credentials", response.headers)

    def test_a_wildcard_allows_any_origin(self):
        """A wildcard allows any origin."""
        with self._client(cors_origins=["*"]) as client:
            response = client.get("/health",
                                  headers={"Origin": "https://anywhere.example.com"})
        self.assertEqual(response.headers["access-control-allow-origin"], "*")

    def test_health_warns_about_a_wildcard_with_no_token(self):
        """/health warns about a wildcard origin with no API token."""
        with self._client(cors_origins=["*"]) as client:
            warnings = client.get("/health").json()["warnings"]
        self.assertTrue(any("CORS_ORIGINS is '*'" in line for line in warnings),
                        f"no wildcard warning in {warnings}")

    def test_health_does_not_warn_when_a_token_gates_the_wildcard(self):
        """/health does not warn when an API token gates the wildcard."""
        with self._client(cors_origins=["*"], api_token="s3cret") as client:
            warnings = client.get("/health").json()["warnings"]
        self.assertFalse([line for line in warnings if "CORS_ORIGINS" in line])


if __name__ == "__main__":
    unittest.main()
