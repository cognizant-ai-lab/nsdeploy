import asyncio
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from nsdeploy.theme import ThemeSpec

from nsdeploy_service.bundle_error import BundleError
from nsdeploy_service.bundle_result import BundleResult
from nsdeploy_service.bundler import Bundler
from nsdeploy_service.config import Settings
from nsdeploy_service.models import BundleOptions

# Self-contained on purpose: it includes nothing from neuro-san-studio, so every test
# here resolves against an empty local checkout and never reaches the network.
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

NO_FRONT_MAN = '{ "tools": [] }'


class BundlerTest(unittest.TestCase):
    """The build half: a HOCON in, a gzipped tar out, and the refusals."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        # An empty checkout, so includes resolve locally and GithubStudio is never
        # constructed. The test network has no includes, so there is nothing to find.
        (self.root / "studio").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _bundler(self, **overrides: Any) -> Bundler:
        settings = Settings(studio=str(self.root / "studio"),
                            work_root=self.root / "work", **overrides)
        return Bundler(settings)

    def _build(self, hocon: str = HELLO_SHOP, bundler: Optional[Bundler] = None,
               **options: Any) -> BundleResult:
        builder = bundler or self._bundler()
        wanted = BundleOptions(name="hello_shop", **options)
        return asyncio.run(builder.build(hocon.encode("utf-8"), wanted))

    @staticmethod
    def _names(result: BundleResult) -> List[str]:
        with tarfile.open(fileobj=io.BytesIO(result.archive), mode="r:gz") as archive:
            return sorted(archive.getnames())

    @staticmethod
    def _read(result: BundleResult, path: str) -> Dict[str, Any]:
        with tarfile.open(fileobj=io.BytesIO(result.archive), mode="r:gz") as archive:
            handle = archive.extractfile(path)
            return json.loads(handle.read().decode("utf-8"))

    def test_builds_a_bundle_with_index_html_at_the_archive_root(self):
        """bundle_host validates <source>/index.html, so an archive that needs a
        --strip-components would land one directory too deep."""
        result = self._build()
        names = self._names(result)
        self.assertIn("index.html", names)
        self.assertIn("agent-manifest.json", names)
        self.assertIn("hello_shop.network.json", names)
        self.assertEqual(result.files, len(names))
        self.assertGreater(result.unpacked_bytes, 0)

    def test_carries_the_shared_runtime(self):
        """The runtime is most of a bundle and is what makes it standalone."""
        names = self._names(self._build())
        runtime = [name for name in names if name.startswith("runtime/")]
        self.assertTrue(runtime, "the bundle carries no runtime/ directory")

    def test_the_manifest_is_not_left_inside_the_bundle(self):
        """nsdeploy writes the private steward manifest beside the bundle, not in it
        (generate.py calls write_private_steward_manifest(out_dir.parent)). Packing
        the parent instead would ship it and move index.html off the root."""
        self.assertNotIn("manifest.hocon", self._names(self._build()))

    def test_one_network_always_packs_to_one_set_of_bytes(self):
        """The digest is offered as an identity, so it has to be a function of the
        content alone — not of when the build ran or who it ran as."""
        first = self._build()
        second = self._build()
        self.assertEqual(first.sha256, second.sha256)
        self.assertEqual(first.archive, second.archive)

    def test_site_url_is_baked_into_the_manifest(self):
        """It cannot be changed after the build, which is why the field exists."""
        result = self._build(site_url="https://shop.example.com/bundle/")
        manifest = self._read(result, "agent-manifest.json")
        self.assertEqual(manifest["linking"]["site"], "https://shop.example.com/bundle")

    def test_reports_what_a_static_bundle_cannot_carry(self):
        warnings = self._build().warnings
        self.assertTrue(any("MCP facade is unavailable" in line for line in warnings),
                        f"no facade warning in {warnings}")

    def test_refuses_an_empty_hocon(self):
        with self.assertRaises(BundleError) as caught:
            self._build(hocon="   ")
        self.assertIn("empty", str(caught.exception))

    def test_refuses_a_hocon_over_the_limit(self):
        bundler = self._bundler(max_hocon_bytes=16)
        with self.assertRaises(BundleError) as caught:
            self._build(bundler=bundler)
        self.assertIn("the limit is 16", str(caught.exception))

    def test_refuses_bytes_that_are_not_utf8(self):
        bundler = self._bundler()
        wanted = BundleOptions(name="hello_shop")
        with self.assertRaises(BundleError) as caught:
            asyncio.run(bundler.build(b"\xff\xfe{}", wanted))
        self.assertIn("UTF-8", str(caught.exception))

    def test_refuses_a_name_that_is_a_path(self):
        """safe_network_name rejects rather than sanitises, so '../evil' is an error
        and not a silent rename — the name becomes a filename here too."""
        bundler = self._bundler()
        wanted = BundleOptions(name="../evil")
        with self.assertRaises(BundleError) as caught:
            asyncio.run(bundler.build(HELLO_SHOP.encode("utf-8"), wanted))
        self.assertIn("invalid network name", str(caught.exception))

    def test_refuses_a_network_with_no_front_man(self):
        with self.assertRaises(BundleError) as caught:
            self._build(hocon=NO_FRONT_MAN)
        self.assertIn("front-man", str(caught.exception))

    def test_refuses_a_hocon_it_cannot_parse(self):
        """pyhocon raises its own grammar exceptions; the caller gets a 400, not a
        500, because this is a file they can fix."""
        with self.assertRaises(BundleError) as caught:
            self._build(hocon="{ this is not ")
        self.assertIn("could not be resolved", str(caught.exception))


class BundlerThemeTest(unittest.TestCase):
    """Theming is opt-in per request, which is the one place a bundle deliberately
    disagrees with a deployment."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "studio").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _bundler(self, **overrides: Any) -> Bundler:
        settings = Settings(studio=str(self.root / "studio"),
                            work_root=self.root / "work", **overrides)
        return Bundler(settings)

    def _build(self, bundler: Bundler, **options: Any) -> BundleResult:
        wanted = BundleOptions(name="hello_shop", **options)
        return asyncio.run(bundler.build(HELLO_SHOP.encode("utf-8"), wanted))

    def test_the_service_wide_theme_setting_does_not_theme_a_bundle(self):
        """A deployment answers 202 and themes behind it. This endpoint answers on the
        open connection, so inheriting THEME=1 would turn every bundle request into a
        30-90 second one without anyone asking for it."""
        bundler = self._bundler(theme=True)
        with mock.patch("nsdeploy_service.bundler.propose_theme") as proposer:
            with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}):
                self._build(bundler)
        proposer.assert_not_called()

    def test_a_requested_theme_asks_the_model(self):
        bundler = self._bundler()
        spec = ThemeSpec()
        spec.body = "<main>themed</main>"
        with mock.patch("nsdeploy_service.bundler.propose_theme",
                        return_value=spec) as proposer:
            with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}):
                result = self._build(bundler, theme=True, theme_model="gpt-5.6")
        proposer.assert_called_once()
        self.assertEqual(proposer.call_args.kwargs["model"], "gpt-5.6")
        self.assertFalse([line for line in result.warnings if "theme" in line])

    def test_a_theme_without_a_key_warns_and_keeps_the_default_look(self):
        bundler = self._bundler()
        with mock.patch("nsdeploy_service.bundler.propose_theme") as proposer:
            with mock.patch.dict("os.environ", {"OPENAI_API_KEY": ""}):
                result = self._build(bundler, theme=True)
        proposer.assert_not_called()
        self.assertTrue(any("OPENAI_API_KEY" in line for line in result.warnings),
                        f"no missing-key warning in {result.warnings}")

    def test_an_unusable_layout_warns_and_keeps_the_default_look(self):
        """propose_theme catches every failure and answers with an empty spec, so an
        empty body is the only signal that the model step did not work."""
        bundler = self._bundler()
        with mock.patch("nsdeploy_service.bundler.propose_theme",
                        return_value=ThemeSpec()):
            with mock.patch.dict("os.environ", {"OPENAI_API_KEY": "sk-test"}):
                result = self._build(bundler, theme=True, theme_model="gpt-5.6")
        self.assertTrue(any("no usable layout" in line for line in result.warnings),
                        f"no unusable-layout warning in {result.warnings}")


class BundleEndpointTest(unittest.TestCase):
    """The delivery half: one request in, one archive out."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "studio").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _client(self):
        from fastapi.testclient import TestClient

        from nsdeploy_service.app import create_app

        settings = Settings(studio=str(self.root / "studio"),
                            work_root=self.root / "work",
                            port_start=8700, port_end=8709)
        return TestClient(create_app(settings))

    def test_returns_the_archive_and_describes_it_in_the_headers(self):
        """The body is the bundle, so everything else about the build travels beside
        it rather than in it."""
        with self._client() as client:
            response = client.post(
                "/bundles",
                files={"file": ("hello_shop.hocon", HELLO_SHOP.encode("utf-8"),
                                "application/octet-stream")},
                data={"site_url": "https://shop.example.com/bundle"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/gzip")
        self.assertEqual(response.headers["content-disposition"],
                         'attachment; filename="hello_shop.tar.gz"')
        self.assertEqual(response.headers["x-bundle-name"], "hello_shop")
        self.assertEqual(len(response.headers["x-bundle-sha256"]), 64)
        self.assertGreater(int(response.headers["x-bundle-files"]), 0)
        self.assertGreater(int(response.headers["x-bundle-unpacked-bytes"]), 0)
        reported = json.loads(response.headers["x-bundle-warnings"])
        self.assertIsInstance(reported, list)
        with tarfile.open(fileobj=io.BytesIO(response.content), mode="r:gz") as archive:
            self.assertIn("index.html", archive.getnames())

    def test_the_name_falls_back_to_the_uploaded_filename(self):
        with self._client() as client:
            response = client.post(
                "/bundles",
                files={"file": ("corner_shop.hocon", HELLO_SHOP.encode("utf-8"),
                                "application/octet-stream")},
            )
        self.assertEqual(response.headers["x-bundle-name"], "corner_shop")

    def test_the_raw_body_route_builds_the_same_bundle(self):
        with self._client() as client:
            multipart = client.post(
                "/bundles",
                files={"file": ("hello_shop.hocon", HELLO_SHOP.encode("utf-8"),
                                "application/octet-stream")},
                data={"site_url": "https://shop.example.com/bundle"},
            )
            raw = client.post(
                "/bundles/raw",
                params={"name": "hello_shop",
                        "site_url": "https://shop.example.com/bundle"},
                content=HELLO_SHOP.encode("utf-8"),
            )
        self.assertEqual(raw.status_code, 200)
        self.assertEqual(raw.content, multipart.content)

    def test_a_bad_request_is_a_400_with_a_reason(self):
        with self._client() as client:
            response = client.post(
                "/bundles",
                files={"file": ("empty.hocon", b"   ", "application/octet-stream")},
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("empty", response.json()["detail"])

    def test_nothing_about_a_bundle_reaches_the_deployment_store(self):
        """A bundle is built, handed over and forgotten. If one ever landed in the
        store it would appear in the directory and on the map as a network that
        nothing is serving."""
        with self._client() as client:
            client.post("/bundles",
                        files={"file": ("hello_shop.hocon", HELLO_SHOP.encode("utf-8"),
                                        "application/octet-stream")})
            listed = client.get("/deployments").json()
        self.assertEqual(listed["deployments"], [])


if __name__ == "__main__":
    unittest.main()
