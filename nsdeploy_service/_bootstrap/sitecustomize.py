"""Configure TLS trust in every `python -m nsdeploy` child the supervisor spawns.

Python imports `sitecustomize` automatically during interpreter start-up if it is
importable, so putting this directory on the child's PYTHONPATH runs it before the
child's own code — without editing a line of nsdeploy. That is what lets
nsdeploy_service be dropped into an unmodified nsdeploy of any version.

Why it is needed: some Python builds (the python.org Windows installers in
particular) ship no OpenSSL trust store, so every HTTPS call fails against a valid
certificate. And on a network with TLS inspection the corporate root is in the OS
store and deliberately not in certifi's, so an intercepted host — commonly the LLM
endpoints — fails even when a public bundle is configured.

Why not simply export SSL_CERT_FILE to the child: a hosted coded tool may carry its
own TLS stack. `ddgs_search` pulls in `primp`, a Rust client that reads
SSL_CERT_FILE and then trusts *only* that file instead of the OS store, so setting
it turned every search into "invalid peer certificate: UnknownIssuer". Configuring
Python's own ssl module in-process leaves other stacks alone.

Failures here are swallowed. A trust store that cannot be configured must not stop
a build from starting — it will fail later with a clear TLS error instead of an
ImportError from the interpreter's start-up.
"""
try:
    from nsdeploy_service.trust import ensure_ca_bundle

    ensure_ca_bundle()
except Exception:  # noqa: BLE001 - never break interpreter start-up
    pass
