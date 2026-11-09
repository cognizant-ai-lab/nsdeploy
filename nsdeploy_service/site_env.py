from __future__ import annotations

from typing import Collection
from typing import Dict
from typing import FrozenSet
from typing import Iterable
from typing import List
from typing import Mapping
from typing import Optional
from typing import Set
from typing import Tuple

from nsdeploy_service.config import ENV_PREFIX


class SiteEnv:
    """
    Builds the environment for the site processes the service starts.

    A site runs code from an uploaded network: its coded tools run in the site's process tree, and a HOCON ${NAME}
    substitution falls back to environment variables. So a site must not inherit the service's own credentials or
    the LLM-provider keys set on the host. Everything else is kept, such as PATH, PYTHONPATH, proxy and TLS
    variables, and the non-secret NSDEPLOY_SERVICE_ settings.

    An operator allow-list passes named provider variables through, for coded tools that build a provider client
    from the environment. The service's own credentials are never passed, even when listed.
    """

    # The service's own credentials: NSDEPLOY_SERVICE_ names with one of these endings,
    # such as NSDEPLOY_SERVICE_API_TOKEN and NSDEPLOY_SERVICE_ADMIN_TOKEN.
    SERVICE_SECRET_SUFFIXES: Tuple[str, ...] = ("_TOKEN", "_KEY", "_SECRET", "_PASSWORD")

    # LLM-provider credentials and endpoints. These are the rules of scrubbed_env() in nsdeploy/launcher.py,
    # copied rather than imported because the service runs nsdeploy as a separate process.
    PROVIDER_PREFIXES: Tuple[str, ...] = ("OPENAI_", "ANTHROPIC_", "AZURE_OPENAI_", "GEMINI_", "GOOGLE_API_",
                                          "NSDEPLOY_STEWARD_BYOK_")
    PROVIDER_SUFFIXES: Tuple[str, ...] = ("_API_KEY", "_API_TOKEN", "_SECRET_KEY")
    PROVIDER_NAMES: FrozenSet[str] = frozenset({"GOOGLE_APPLICATION_CREDENTIALS", "NSDEPLOY_FACADE_API_KEY"})

    # The key that nsdeploy's deploy-time theming reads from the site build's environment.
    THEME_KEY: str = "OPENAI_API_KEY"

    @staticmethod
    def build(base: Mapping[str, str], allow: Iterable[str] = ()) -> Dict[str, str]:
        """
        Copy an environment without the service's credentials or LLM-provider credentials.

        :param base: The environment to copy, such as os.environ. It is not changed.
        :param allow: Names to keep even when a provider rule would remove them.
        :return: A new environment for a site process.
        """
        allowed: Set[str] = set(allow)
        env: Dict[str, str] = {}
        name: str
        value: str
        # Copy each variable that a site process may receive.
        for name, value in base.items():
            if SiteEnv.passes(name, allowed):
                env[name] = value
        return env

    @staticmethod
    def passes(name: str, allow: Collection[str]) -> bool:
        """
        Report whether a site process receives a variable.

        :param name: The variable name.
        :param allow: Names to keep even when a provider rule would remove them.
        :return: True when the variable is passed on to the site.
        """
        # Checked before the allow-list, so the allow-list can never pass the service's credentials.
        if SiteEnv.is_service_secret(name):
            return False
        return name in allow or not SiteEnv.is_provider_secret(name)

    @staticmethod
    def theme_key_warning(theme: bool, base: Mapping[str, str], allow: Collection[str]) -> Optional[str]:
        """
        Explain that deploy-time theming cannot run because site builds do not receive the theming key.

        :param theme: Whether deploy-time theming is on for every build.
        :param base: The service's environment, such as os.environ.
        :param allow: Names to keep even when a provider rule would remove them.
        :return: A warning for the operator, or None when theming is off, no key is set, or sites receive the key.
        """
        if not theme or not base.get(SiteEnv.THEME_KEY) or SiteEnv.passes(SiteEnv.THEME_KEY, allow):
            return None
        # Names only, never the value: /health shows this warning without authentication.
        return (f"THEME is on, but site builds do not receive {SiteEnv.THEME_KEY}, so LLM theming cannot run and "
                f"new sites get the default look. To theme, list {SiteEnv.THEME_KEY} in SITE_ENV_ALLOW; any "
                f"uploaded network can then read the key (see nsdeploy_service/README.md).")

    @staticmethod
    def allow_list_warning(allow: Iterable[str]) -> Optional[str]:
        """
        Explain that SITE_ENV_ALLOW names some of the service's own credentials, which sites never receive.

        :param allow: The names listed in SITE_ENV_ALLOW.
        :return: A warning that names the ignored entries, or None when there are none.
        """
        ignored: List[str] = []
        name: str
        # Collect each listed name that build() drops anyway.
        for name in allow:
            if SiteEnv.is_service_secret(name):
                ignored.append(name)
        if not ignored:
            return None
        # Names only, never values: /health shows this warning without authentication.
        return (f"SITE_ENV_ALLOW lists {', '.join(ignored)}, but site processes never receive the service's own "
                f"credentials, so these entries have no effect. Remove them from SITE_ENV_ALLOW.")

    @staticmethod
    def is_service_secret(name: str) -> bool:
        """
        Report whether a variable holds one of the service's own credentials.

        :param name: The variable name.
        :return: True for an NSDEPLOY_SERVICE_ name that ends in _TOKEN, _KEY, _SECRET or _PASSWORD.
        """
        return name.startswith(ENV_PREFIX) and name.endswith(SiteEnv.SERVICE_SECRET_SUFFIXES)

    @staticmethod
    def is_provider_secret(name: str) -> bool:
        """
        Report whether a variable holds an LLM-provider credential or endpoint.

        :param name: The variable name.
        :return: True when the name matches a provider prefix, suffix or exact name.
        """
        if name in SiteEnv.PROVIDER_NAMES:
            return True
        return name.startswith(SiteEnv.PROVIDER_PREFIXES) or name.endswith(SiteEnv.PROVIDER_SUFFIXES)
