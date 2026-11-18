import unittest
from typing import Dict
from typing import Optional

from nsdeploy_service.site_env import SiteEnv


class TestSiteEnv(unittest.TestCase):
    """
    Checks which variables SiteEnv keeps from a site process, and which it passes on.
    """

    def test_service_token_is_removed(self) -> None:
        """
        The service's shared API token never reaches a site process.
        """
        base: Dict[str, str] = {
            "NSDEPLOY_SERVICE_API_TOKEN": "fake-service-token",
            "PATH": "/usr/bin",
        }
        self.assertEqual(SiteEnv.build(base), {"PATH": "/usr/bin"})

    def test_other_service_credentials_are_removed(self) -> None:
        """
        Every NSDEPLOY_SERVICE_ name ending in _TOKEN, _KEY, _SECRET or _PASSWORD is removed.
        """
        base: Dict[str, str] = {
            "NSDEPLOY_SERVICE_ADMIN_TOKEN": "fake-admin-token",
            "NSDEPLOY_SERVICE_SIGNING_KEY": "fake-signing-key",
            "NSDEPLOY_SERVICE_SESSION_SECRET": "fake-session-secret",
            "NSDEPLOY_SERVICE_DB_PASSWORD": "fake-db-password",
        }
        self.assertEqual(SiteEnv.build(base), {})

    def test_non_secret_service_settings_are_kept(self) -> None:
        """
        NSDEPLOY_SERVICE_STUDIO and other non-secret service settings are passed on.
        """
        base: Dict[str, str] = {
            "NSDEPLOY_SERVICE_STUDIO": "/fake/studio",
            "NSDEPLOY_SERVICE_THEME_MODEL": "fake-model",
            "NSDEPLOY_SERVICE_UPSTREAM": "https://upstream.example.test/v1",
            "NSDEPLOY_SERVICE_SITE_ENV_ALLOW": "OPENAI_API_KEY",
        }
        self.assertEqual(SiteEnv.build(base), base)

    def test_provider_credentials_are_removed(self) -> None:
        """
        LLM-provider keys and credential files are removed.
        """
        base: Dict[str, str] = {
            "OPENAI_API_KEY": "fake-openai-key",
            "ANTHROPIC_API_KEY": "fake-anthropic-key",
            "FOO_API_TOKEN": "fake-foo-token",
            "GOOGLE_APPLICATION_CREDENTIALS": "/fake/credentials.json",
        }
        self.assertEqual(SiteEnv.build(base), {})

    def test_every_facade_rule_from_nsdeploy_applies(self) -> None:
        """
        Every provider prefix, suffix and exact name that nsdeploy scrubs from its facade removes a variable.
        """
        # Each rule has a name here that no other rule matches, so dropping any one rule fails this test.
        # NSDEPLOY_FACADE_API_KEY is the exception: it also ends in _API_KEY.
        base: Dict[str, str] = {
            "OPENAI_BASE_URL": "https://provider.example.test/v1",
            "ANTHROPIC_BASE_URL": "https://anthropic.example.test",
            "AZURE_OPENAI_ENDPOINT": "https://azure.example.test",
            "GEMINI_MODEL": "fake-gemini-model",
            "GOOGLE_API_ENDPOINT": "https://google.example.test",
            "GOOGLE_API_KEY": "fake-google-key",
            "NSDEPLOY_STEWARD_BYOK_MODEL": "fake-steward-model",
            "GROQ_API_KEY": "fake-groq-key",
            "FOO_API_TOKEN": "fake-foo-token",
            "FOO_SECRET_KEY": "fake-secret-key",
            "GOOGLE_APPLICATION_CREDENTIALS": "/fake/credentials.json",
            "NSDEPLOY_FACADE_API_KEY": "fake-facade-key",
        }
        self.assertEqual(SiteEnv.build(base), {})

    def test_path_and_proxy_settings_are_kept(self) -> None:
        """
        PATH, PYTHONPATH, proxy and TLS variables are passed on unchanged.
        """
        base: Dict[str, str] = {
            "PATH": "/usr/bin:/bin",
            "PYTHONPATH": "/fake/lib",
            "HTTPS_PROXY": "http://proxy.example.test:3128",
            "SSL_CERT_FILE": "/fake/ca.pem",
        }
        self.assertEqual(SiteEnv.build(base), base)

    def test_allow_list_passes_a_provider_key(self) -> None:
        """
        A provider key named in the allow-list is passed on, and unlisted ones are still removed.
        """
        base: Dict[str, str] = {
            "OPENAI_API_KEY": "fake-openai-key",
            "ANTHROPIC_API_KEY": "fake-anthropic-key",
        }
        env: Dict[str, str] = SiteEnv.build(base, ["OPENAI_API_KEY"])
        self.assertEqual(env, {"OPENAI_API_KEY": "fake-openai-key"})

    def test_allow_list_cannot_pass_the_service_token(self) -> None:
        """
        The service's own credentials stay out even when the allow-list names them.
        """
        base: Dict[str, str] = {
            "NSDEPLOY_SERVICE_API_TOKEN": "fake-service-token",
            "NSDEPLOY_SERVICE_ADMIN_TOKEN": "fake-admin-token",
        }
        env: Dict[str, str] = SiteEnv.build(base, ["NSDEPLOY_SERVICE_API_TOKEN", "NSDEPLOY_SERVICE_ADMIN_TOKEN"])
        self.assertEqual(env, {})

    def test_input_mapping_is_not_changed(self) -> None:
        """
        Building the site environment leaves the source mapping as it was.
        """
        base: Dict[str, str] = {
            "NSDEPLOY_SERVICE_API_TOKEN": "fake-service-token",
            "OPENAI_API_KEY": "fake-openai-key",
            "PATH": "/usr/bin",
        }
        before: Dict[str, str] = dict(base)
        env: Dict[str, str] = SiteEnv.build(base, ["OPENAI_API_KEY"])
        env["PATH"] = "/changed"
        self.assertEqual(base, before)

    def test_passes_agrees_with_build(self) -> None:
        """
        passes reports what build keeps: a provider key only when listed, and never the service token.
        """
        self.assertTrue(SiteEnv.passes("PATH", []))
        self.assertFalse(SiteEnv.passes("OPENAI_API_KEY", []))
        self.assertTrue(SiteEnv.passes("OPENAI_API_KEY", ["OPENAI_API_KEY"]))
        self.assertFalse(SiteEnv.passes("NSDEPLOY_SERVICE_API_TOKEN", ["NSDEPLOY_SERVICE_API_TOKEN"]))

    def test_theme_key_warning_when_sites_do_not_get_the_key(self) -> None:
        """
        With theming on and the key set but not listed, the warning names the key and SITE_ENV_ALLOW.
        """
        warning: Optional[str] = SiteEnv.theme_key_warning(True, {"OPENAI_API_KEY": "fake-openai-key"}, [])
        self.assertIsNotNone(warning)
        self.assertIn("OPENAI_API_KEY", warning)
        self.assertIn("SITE_ENV_ALLOW", warning)
        # /health shows the warning without authentication, so it must never contain the key itself.
        self.assertNotIn("fake-openai-key", warning)

    def test_theme_key_warning_when_the_key_is_missing_or_empty(self) -> None:
        """
        With theming on and no key, the warning says to set it, and to list it only when it is not listed yet.
        """
        unlisted: Optional[str] = SiteEnv.theme_key_warning(True, {}, [])
        self.assertIsNotNone(unlisted)
        self.assertIn("OPENAI_API_KEY is not set", unlisted)
        self.assertIn("SITE_ENV_ALLOW", unlisted)
        listed: Optional[str] = SiteEnv.theme_key_warning(True, {"OPENAI_API_KEY": ""}, ["OPENAI_API_KEY"])
        self.assertIsNotNone(listed)
        self.assertIn("OPENAI_API_KEY is not set", listed)
        self.assertNotIn("SITE_ENV_ALLOW", listed)

    def test_no_theme_key_warning_when_theming_is_off_or_can_run(self) -> None:
        """
        No warning when theming is off, or when the allow-list passes a non-empty key.
        """
        key: Dict[str, str] = {"OPENAI_API_KEY": "fake-openai-key"}
        self.assertIsNone(SiteEnv.theme_key_warning(False, key, []))
        self.assertIsNone(SiteEnv.theme_key_warning(False, {}, []))
        self.assertIsNone(SiteEnv.theme_key_warning(True, key, ["OPENAI_API_KEY"]))

    def test_allow_list_warning_names_ignored_service_credentials(self) -> None:
        """
        A service credential in the allow-list is named in the warning, and a provider key is not.
        """
        warning: Optional[str] = SiteEnv.allow_list_warning(["OPENAI_API_KEY", "NSDEPLOY_SERVICE_API_TOKEN"])
        self.assertIsNotNone(warning)
        self.assertIn("NSDEPLOY_SERVICE_API_TOKEN", warning)
        self.assertNotIn("OPENAI_API_KEY", warning)

    def test_no_allow_list_warning_for_provider_keys(self) -> None:
        """
        No warning when the allow-list is empty or names only provider keys.
        """
        self.assertIsNone(SiteEnv.allow_list_warning([]))
        self.assertIsNone(SiteEnv.allow_list_warning(["OPENAI_API_KEY", "GROQ_API_KEY"]))


if __name__ == "__main__":
    unittest.main()
