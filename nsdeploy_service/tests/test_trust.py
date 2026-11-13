"""TLS trust configuration owned by the service.

Two regressions are pinned here:

* a Python build with no OpenSSL trust store failed every HTTPS request with
  CERTIFICATE_VERIFY_FAILED against a valid certificate, so no network needing an
  uncached studio file could be deployed at all;
* configuring it by exporting SSL_CERT_FILE leaked into child processes, and the
  `primp` (Rust) client inside `ddgs_search` then trusted *only* that bundle and
  rejected every search with "invalid peer certificate: UnknownIssuer".

Assertions are made against the installed wrapper rather than the process-wide
`ssl` module. `create_app()` legitimately injects the OS trust store for the whole
service process, and that is irreversible, so any test reading global `ssl` state
would depend on whether an app happened to be built first.
"""
import inspect
import os
import ssl
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Callable
from typing import ContextManager
from typing import Dict
from typing import Optional
from typing import Tuple
from typing import Type
from unittest import mock
from unittest.mock import MagicMock
from unittest.mock import _patch_dict

from nsdeploy_service import supervisor
from nsdeploy_service import trust
from nsdeploy_service.config import SERVICE_ROOT


class CaBundleTest(unittest.TestCase):
    """Installs a CA trust store for the service process when the interpreter has none."""
    def setUp(self) -> None:
        trust._installed = None  # pylint: disable=protected-access; the test inspects internals
        self._env: _patch_dict = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("SSL_CERT_FILE", None)
        os.environ.pop("SSL_CERT_DIR", None)
        # Both installation paths mutate the ssl module process-wide; restore them so
        # one test cannot change what another observes.
        self._ssl_state: Tuple[Callable[..., ssl.SSLContext], Callable[..., ssl.SSLContext], Type[ssl.SSLContext]]
        self._ssl_state = (ssl.create_default_context,
                           # pylint: disable-next=protected-access  # the test inspects internals
                           ssl._create_default_https_context,
                           ssl.SSLContext)

    def tearDown(self) -> None:
        (ssl.create_default_context,
         ssl._create_default_https_context,
         ssl.SSLContext) = self._ssl_state
        self._env.stop()
        trust._installed = None  # pylint: disable=protected-access; the test inspects internals

    def _no_store(self) -> ContextManager[MagicMock]:
        return mock.patch.object(trust, "has_usable_store", return_value=False)

    def _no_truststore(self) -> ContextManager[None]:
        return mock.patch.object(trust, "truststore", None)

    def test_installs_a_trust_store_when_the_interpreter_has_none(self) -> None:
        """A trust store is installed when the interpreter has none."""
        with self._no_store():
            self.assertIsNotNone(trust.ensure_ca_bundle())

    def test_prefers_the_os_trust_store_over_certifi(self) -> None:
        """The OS store carries the public roots *and* any corporate root, so it is a
        superset of certifi. Behind TLS inspection it is the only one that verifies
        an intercepted host."""
        with self._no_store():
            self.assertEqual(trust.ensure_ca_bundle(),
                             "the operating system trust store")

    def test_the_certifi_fallback_supplies_its_bundle_as_the_default_cafile(self) -> None:
        """The certifi fallback supplies its bundle as the default cafile."""
        captured: Dict[str, Any] = {}

        def spy(*_args: Any, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "context"

        with self._no_store(), self._no_truststore(), \
                mock.patch.object(ssl, "create_default_context", spy):
            bundle: Optional[str] = trust.ensure_ca_bundle()
            ssl.create_default_context()  # goes through the installed wrapper

        self.assertTrue(Path(bundle).is_file())
        self.assertEqual(captured.get("cafile"), bundle)

    def test_an_explicit_cafile_from_the_caller_is_not_overridden(self) -> None:
        """Only the "caller had no opinion" case is filled in."""
        captured: Dict[str, Any] = {}

        def spy(*_args: Any, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "context"

        with self._no_store(), self._no_truststore(), \
                mock.patch.object(ssl, "create_default_context", spy):
            trust.ensure_ca_bundle()
            ssl.create_default_context(cafile="/etc/ssl/mine.pem")

        self.assertEqual(captured.get("cafile"), "/etc/ssl/mine.pem")

    def test_urllib_picks_up_the_certifi_fallback_too(self) -> None:
        """urllib builds its HTTPS context from _create_default_https_context, which
        is a separate hook from the one httpx uses — both must be installed."""
        with self._no_store(), self._no_truststore():
            trust.ensure_ca_bundle()
            # pylint: disable-next=protected-access  # the test inspects internals
            self.assertIs(ssl._create_default_https_context, ssl.create_default_context)

    def test_reports_nothing_when_neither_is_available(self) -> None:
        """Nothing is installed when neither truststore nor certifi is available."""
        with self._no_store(), self._no_truststore(), mock.patch.object(trust, "certifi", None):
            self.assertIsNone(trust.ensure_ca_bundle())

    def test_it_does_not_touch_the_environment(self) -> None:
        """The regression that broke ddgs_search: an exported SSL_CERT_FILE is
        inherited by child processes and overrides their own trust stores."""
        with self._no_store():
            trust.ensure_ca_bundle()
        self.assertIsNone(os.environ.get("SSL_CERT_FILE"))
        self.assertIsNone(os.environ.get("SSL_CERT_DIR"))

    def test_does_nothing_when_the_interpreter_already_has_a_store(self) -> None:
        """Nothing is installed when the interpreter already has a usable store."""
        with mock.patch.object(trust, "has_usable_store", return_value=True):
            self.assertIsNone(trust.ensure_ca_bundle())

    def test_respects_an_operator_supplied_bundle(self) -> None:
        """Behind a TLS-inspecting proxy the corporate root is the only CA that
        works; substituting another would break every request instead of one."""
        os.environ["SSL_CERT_FILE"] = "/etc/ssl/corporate-root.pem"
        with self._no_store():
            self.assertIsNone(trust.ensure_ca_bundle())
        self.assertEqual(os.environ["SSL_CERT_FILE"], "/etc/ssl/corporate-root.pem")
        self.assertIsNone(trust._installed)  # pylint: disable=protected-access; the test inspects internals

    def test_respects_an_operator_supplied_directory(self) -> None:
        """An operator-supplied SSL_CERT_DIR is left in place."""
        os.environ["SSL_CERT_DIR"] = "/etc/ssl/certs"
        with self._no_store():
            self.assertIsNone(trust.ensure_ca_bundle())
        self.assertIsNone(trust._installed)  # pylint: disable=protected-access; the test inspects internals

    def test_is_idempotent(self) -> None:
        """Repeated calls return the same result."""
        with self._no_store():
            self.assertEqual(trust.ensure_ca_bundle(), trust.ensure_ca_bundle())

    def test_a_store_path_that_does_not_exist_does_not_count(self) -> None:
        """Windows builds commonly report a build-time Unix path that was never
        shipped, so the path being set is not evidence that it works."""
        fake: ssl.DefaultVerifyPaths = ssl.DefaultVerifyPaths(
            cafile="/nonexistent/cert.pem", capath="/nonexistent/certs",
            openssl_cafile_env="", openssl_cafile="/nonexistent/cert.pem",
            openssl_capath_env="", openssl_capath="/nonexistent/certs")
        with mock.patch.object(ssl, "get_default_verify_paths", return_value=fake):
            self.assertFalse(trust.has_usable_store())

    def test_an_existing_store_path_counts(self) -> None:
        """A store path that exists counts as a usable store."""
        tmp: str
        with tempfile.TemporaryDirectory() as tmp:
            bundle: Path = Path(tmp) / "cert.pem"
            bundle.write_text("", encoding="utf-8")
            paths: ssl.DefaultVerifyPaths = ssl.DefaultVerifyPaths(
                cafile=str(bundle), capath=None, openssl_cafile_env="",
                openssl_cafile=str(bundle), openssl_capath_env="", openssl_capath="")
            with mock.patch.object(ssl, "get_default_verify_paths", return_value=paths):
                self.assertTrue(trust.has_usable_store())


class TlsFailureMessageTest(unittest.TestCase):
    """Describes a TLS verification failure in actionable terms."""
    def test_names_the_url_and_the_ways_out(self) -> None:
        """The message names the URL and the settings that fix it."""
        text: str = trust.describe_tls_failure("https://api.openai.com/x", "verify failed")
        self.assertIn("https://api.openai.com/x", text)
        self.assertIn("SSL_CERT_FILE", text)
        self.assertIn("NSDEPLOY_SERVICE_STUDIO", text)


class BootstrapTest(unittest.TestCase):
    """The child-process hook. Python imports `sitecustomize` at interpreter
    start-up, so putting _bootstrap on a child's PYTHONPATH configures its TLS trust
    without editing a line of nsdeploy — which is what lets this package be dropped
    into any version of it."""

    def test_the_bootstrap_module_exists_where_the_supervisor_points(self) -> None:
        """The bootstrap module exists where the supervisor points."""
        self.assertTrue((SERVICE_ROOT / "_bootstrap" / "sitecustomize.py").is_file())

    def test_the_supervisor_puts_it_first_on_the_child_path(self) -> None:
        """The supervisor puts the bootstrap directory on the child's path."""
        # pylint: disable-next=protected-access  # the test inspects internals
        source: str = inspect.getsource(supervisor.Supervisor._spawn)
        self.assertIn('SERVICE_ROOT / "_bootstrap"', source)

    def test_it_swallows_failures(self) -> None:
        """A trust store that cannot be configured must not stop the interpreter
        starting; the build fails later with a clear TLS error instead."""
        path: Path = Path(__file__).resolve().parents[1] / "_bootstrap" / "sitecustomize.py"
        source: str = path.read_text(encoding="utf-8")
        self.assertIn("except Exception", source)


if __name__ == "__main__":
    unittest.main()
