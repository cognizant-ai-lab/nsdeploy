"""Agentic City — expose nsdeploy as an HTTP deployment service.

POST a network HOCON, get back a live URL. Each deployment is one supervised
`python -m nsdeploy` child process on its own port, exactly as
cailville/launch_all.sh does it for the 13-site demo.

`Agentic City` is the product name shown to users (UI, OpenAPI docs, CLI
banner) — it was NS Deploy NexGen. The import path stays `nsdeploy_service` and
the settings prefix stays `NSDEPLOY_SERVICE_` so a rename never silently
invalidates a deployment's config.
"""
PRODUCT_NAME = "Agentic City"
__version__ = "0.1.0"
