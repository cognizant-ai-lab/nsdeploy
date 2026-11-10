from __future__ import annotations

from typing import Optional


class UploadUpstream:
    """
    Decides whether a deploy upload may name a BYOK upstream.

    A site's /byok/v1 forwards each visitor's API key to its upstream, so every site uses the service-wide
    upstream. An upload may leave the upstream out, or repeat the service's own value, which the console sends on
    every Launch. Any other value is refused.
    """

    REFUSAL: str = (
        "Per-deployment upstream is not supported. Every site's /byok/v1 forwards to the "
        "service-wide upstream (NSDEPLOY_SERVICE_UPSTREAM), and visitors choose their own "
        "router in the site's BYOK settings. Leave upstream out and deploy again."
    )

    @staticmethod
    def refusal(requested: Optional[str], service_upstream: Optional[str]) -> Optional[str]:
        """
        Explain why an upload's upstream is refused.

        :param requested: The upstream the upload named, if any.
        :param service_upstream: The service-wide upstream.
        :return: The refusal message, or None when the upload may go ahead.
        """
        # Blank counts as not given, and a trailing slash does not make a different upstream.
        wanted: str = (requested or "").strip().rstrip("/")
        if not wanted or wanted == (service_upstream or "").strip().rstrip("/"):
            return None
        return UploadUpstream.REFUSAL
