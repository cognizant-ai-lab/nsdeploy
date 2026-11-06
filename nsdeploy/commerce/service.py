"""Server-to-server commerce for private stewards and the public Seabreeze site.

The upstream arbiter remains the sole authority. There is no checkout UI or
browser session API. Private-runtime credentials never enter model arguments.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from nsdeploy.commerce.arbiter import Arbiter
from nsdeploy.commerce.arbiter import CommerceError
from nsdeploy.commerce.catalog import default_trip
from nsdeploy.commerce.catalog import public_catalog
from nsdeploy.commerce.catalog import validate_trip

PROVIDER = "seabreeze_inn"
ARBITER = "commerce_arbiter"
STEWARD = "butterpink_family"
API = "/commerce/api/"
KEY_HEADER = "X-Commerce-Steward-Key"


def origin(url):
    """
    Return the origin of an HTTP(S) commerce endpoint.

    :param url: The endpoint URL.
    :return: The origin string, e.g. "https://example.com".
    :raises ValueError: If the URL is not an HTTP(S) URL without credentials.
    """
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password):
        raise ValueError("Commerce endpoints must use an http(s) origin.")
    return f"{parsed.scheme}://{parsed.netloc}"


def credential_path():
    """
    Return the path of the private steward credential file.

    :return: The credential path, from NSDEPLOY_COMMERCE_KEY_FILE or the default location.
    """
    return Path(os.environ.get("NSDEPLOY_COMMERCE_KEY_FILE", str(
        Path(__file__).resolve().parents[2] / ".nsdeploy/cailville/.commerce/steward.key")))


def provision_key(path):
    """Shared only by the trusted local arbiter and private studio processes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(48))
    path.chmod(0o600)
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise ValueError("Invalid private commerce credential file.")
    return value


def post_json(url, body, headers=None):
    """
    POST a JSON body to a commerce peer without following redirects.

    :param url: The peer endpoint URL.
    :param body: The JSON-serializable request body.
    :param headers: Optional extra request headers.
    :return: The decoded JSON object response.
    :raises ValueError: If the response is not a JSON object.
    """
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        """
        Redirect handler that refuses every redirect.
        """

        def redirect_request(self, *args, **kwargs):  # pylint: disable=unused-argument; base-class signature
            """
            Refuse the redirect.

            :param args: The base-class positional arguments, ignored.
            :param kwargs: The base-class keyword arguments, ignored.
            :return: None, so the redirect is not followed.
            """
            return None

    request = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json", **(headers or {})})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        result = json.loads(response.read(1048577))
        if not isinstance(result, dict):
            raise ValueError("Invalid commerce adapter response.")
        return result


class CommerceSite:  # pylint: disable=too-many-instance-attributes; site configuration
    """
    Server-to-server commerce endpoint for either the arbiter or the seller role.
    """

    # pylint: disable-next=too-many-arguments,too-many-positional-arguments  # public constructor
    def __init__(self, config, site_base, links, database=None, clock=time.time, steward_key=None):
        """
        Initialize the commerce site.

        :param config: The commerce configuration, including its role and peer backend.
        :param site_base: The public base URL of this site.
        :param links: The resolved network links by name.
        :param database: The arbiter database path; used only by the arbiter role.
        :param clock: The time source.
        :param steward_key: The private steward credential; required by the arbiter role.
        :raises ValueError: If the role is unknown, an endpoint is invalid, or the arbiter lacks a credential.
        """
        self.role = config["role"]
        if self.role not in ("arbiter", "seller"):
            raise ValueError("Commerce role must be arbiter or seller.")
        self.site_base = origin(site_base)
        self.clock = clock
        self.action_lock = threading.RLock()
        self.arbiter_url = origin(links.get(ARBITER) or config.get("arbiter_backend", site_base))
        self.seller_url = origin(links.get(PROVIDER) or config.get("seller_backend", site_base))
        self.backend = origin(config["seller_backend"] if self.role == "arbiter"
                              else config["arbiter_backend"])
        self.inventory_available = config.get("inventory_available", True)
        self.engine = Arbiter(database, clock=clock) if self.role == "arbiter" else None
        self.steward_key = steward_key
        if self.engine:
            if not steward_key:
                raise ValueError("The arbiter requires a private-runtime credential.")
            with self.engine.db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS private_chats (
                    digest TEXT PRIMARY KEY, deal TEXT NOT NULL, owner TEXT NOT NULL,
                    buyer TEXT NOT NULL, expires REAL NOT NULL)""")

    @staticmethod
    def _fields(body, expected):
        if not isinstance(body, dict) or set(body) != expected:
            raise ValueError("Unexpected fields in commerce request.")

    @staticmethod
    def _digest(value):
        if not isinstance(value, str) or not 32 <= len(value) <= 200:
            raise PermissionError("A private chat capability is required.")
        return hashlib.sha256(value.encode()).hexdigest()

    def _view(self, chat):
        state = self.engine.snapshot(chat["owner"])
        state["offers"] = self.engine.offers(chat["buyer"])["offers"]
        return {**state, "steward": STEWARD, "simulation": True}

    def _negotiate(self, chat):
        state = self._view(chat)
        if state["state"] not in ("OPEN", "NEGOTIATING") or state["offers"]:
            return state
        capability = self.engine.provider_capability(chat["buyer"], PROVIDER, 1)
        public = self.engine.public_request(capability, PROVIDER)
        result = post_json(self.backend + API + "seller-bid",
                           {"trip": public["trip"], "capability": capability})
        committed = self.engine.bid_receipt(chat["deal"], PROVIDER)
        if result.get("commitment") != committed.get("commitment") or committed["status"] != "BID_COMMITTED":
            raise CommerceError("The Inn did not commit a valid sealed bid. Retry negotiation.")
        self.engine.resolve(chat["buyer"])
        return self._view(chat)

    def _steward_action(self, operation, body):
        if operation not in ("negotiate", "status", "approve", "cancel"):
            raise PermissionError("Unknown private commerce operation.")
        fields = {"session", "trip", "budget_cents"} if operation == "negotiate" else {"session"}
        if operation == "approve":
            fields.add("offer_id")
        self._fields(body, fields)
        digest = self._digest(body["session"])
        # Seller callbacks must remain outside this lock to avoid deadlock.
        with self.action_lock:
            with self.engine.db() as db:
                row = db.execute("SELECT * FROM private_chats WHERE digest=?", (digest,)).fetchone()
            chat = dict(row) if row else None
            if chat and chat["expires"] <= self.clock():
                raise PermissionError("Private booking session expired. Start a new private chat.")
            if operation == "negotiate":
                trip = validate_trip(body["trip"])
                budget = body["budget_cents"]
                # An exact type check rejects bool, which isinstance(..., int) would accept.
                if type(budget) is not int or not 1 <= budget <= 10000000:  # pylint: disable=unidiomatic-typecheck
                    raise ValueError("Budget must be positive integer USD cents, at most $100,000.")
                if chat:
                    previous = self._view(chat)
                    if previous["trip"] == trip and previous["budget_cents"] == budget:
                        return self._negotiate(chat)  # Retry never creates another booking.
                    if previous["state"] not in ("SETTLED", "CANCELLED", "EXPIRED", "NO_AGREEMENT"):
                        raise CommerceError("Cancel the current offer before changing dates or budget.")
                deal = self.engine.create(trip, budget, created_by=STEWARD + "_private_steward")
                chat = {"digest": digest, "deal": deal["deal_id"], "owner": deal["owner_token"],
                        "buyer": deal["buyer_token"], "expires": self.clock() + 86400}
                with self.engine.db() as db:
                    db.execute("INSERT OR REPLACE INTO private_chats VALUES(?,?,?,?,?)", tuple(chat.values()))
                    # pylint: disable-next=protected-access  # vendored arbiter has no public event API
                    self.engine._event(db, chat["deal"], "STEWARD_NEGOTIATION_REQUESTED", {"steward": STEWARD})
                return self._negotiate(chat)
            if not chat:
                raise PermissionError("This private chat has no booking mandate.")
            if operation == "approve":
                if not isinstance(body["offer_id"], str):
                    raise ValueError("An arbiter-issued offer ID is required.")
                # The private runtime verifies a fresh human confirmation before
                # calling this authenticated operation. Models never receive this key.
                self.engine.authorize(chat["owner"], body["offer_id"])
                self.engine.confirm(chat["owner"], inventory_available=self.inventory_available)
            elif operation == "cancel":
                self.engine.cancel(chat["owner"])
            return self._view(chat)

    def _provider_action(self, operation, body):
        self._fields(body, {"trip", "capability"})
        trip = validate_trip(body["trip"])
        if not isinstance(body["capability"], str) or len(body["capability"]) > 200:
            raise PermissionError("A scoped seller capability is required.")
        if self.role == "seller" and operation == "seller-bid":
            return post_json(self.backend + API + "provider-bid", body)
        if self.role != "arbiter" or operation != "provider-bid":
            raise PermissionError("This site does not expose that commerce role.")
        capability = body["capability"]
        context = self.engine.context(capability, PROVIDER)
        if context["trip"] != trip or context["route"] != "arbiter" or context["round"] != 1:
            raise PermissionError("The seller capability does not authorize this stay or route.")
        receipt = self.engine.submit_bid(capability, PROVIDER)
        self.engine.record_exchange(capability, PROVIDER, "SELLER_ADAPTER_REQUEST",
                                    self.engine.public_request(capability, PROVIDER))
        return receipt

    # pylint: disable-next=too-many-return-statements,too-many-branches  # one response per outcome
    def handle(self, handler):
        """
        Serve one commerce API request.

        :param handler: The HTTP request handler for the request.
        :return: None; the response is written to the handler.
        """
        path = urllib.parse.urlsplit(handler.path).path
        operation = path.removeprefix(API) if path.startswith(API) else ""
        try:
            if handler.command == "GET" and operation == "info":
                return self._json(handler, 200, {"role": self.role, "arbiter_url": self.arbiter_url,
                                                 "seller_url": self.seller_url,
                                                 "catalog": public_catalog(PROVIDER, default_trip())})
            allowed = {"negotiate", "status", "approve", "cancel", "seller-bid", "provider-bid"}
            if not operation or operation not in allowed:
                return self._json(handler, 404,
                                  {"error": "No commerce web interface. Use your private steward in nsFlow."})
            if handler.command != "POST":
                return self._json(handler, 405, {"error": "Method not allowed."})
            if handler.headers.get("Origin") is not None:
                handler.close_connection = True
                raise PermissionError("Commerce is called by private runtimes, not browser scripts.")
            provider_action = operation in ("seller-bid", "provider-bid")
            if not provider_action and (not self.engine or not secrets.compare_digest(
                    handler.headers.get(KEY_HEADER, ""), self.steward_key)):
                handler.close_connection = True
                raise PermissionError("A trusted private runtime is required.")
            if handler.headers.get("Content-Type", "").split(";")[0] != "application/json":
                handler.close_connection = True
                raise ValueError("Commerce requests must use application/json.")
            length = int(handler.headers.get("Content-Length", "0"))
            if not 1 <= length <= 8192 or handler.headers.get("Transfer-Encoding"):
                handler.close_connection = True
                raise ValueError("Invalid commerce request size.")
            body = json.loads(handler.rfile.read(length))
            if provider_action:
                result = self._provider_action(operation, body)
            else:
                result = self._steward_action(operation, body)
            return self._json(handler, 200, result)
        except PermissionError as exc:
            return self._json(handler, 403, {"error": str(exc)})
        except CommerceError as exc:
            return self._json(handler, 409, {"error": str(exc)})
        except (ValueError, TypeError, KeyError) as exc:
            return self._json(handler, 400, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError):
            return self._json(handler, 502, {"error": "Commerce peer unavailable. Retry or inspect booking status; "
                                                      "no receipt is fabricated."})

    @staticmethod
    def _json(handler, status, body):
        payload = json.dumps(body).encode()
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(payload)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.end_headers()
        handler.wfile.write(payload)


def from_plan(plan, site_dir, site_base):
    """
    Build the commerce site for a deployment plan, provisioning the arbiter credential when needed.

    :param plan: The deployment plan.
    :param site_dir: The site's output directory.
    :param site_base: The public base URL of the site.
    :return: The commerce site, or None when the plan has no commerce configuration.
    """
    config = plan.config.get("commerce")
    if not config:
        return None
    database = site_dir.parent / ".commerce" / f"{plan.network_name}.sqlite"
    database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    links = {**(plan.config.get("links") or {}), **plan.links}
    key = None
    if config["role"] == "arbiter":
        path = Path(os.environ.get("NSDEPLOY_COMMERCE_KEY_FILE", database.parent / "steward.key"))
        key = provision_key(path)
    service = CommerceSite(config, site_base, links, database, steward_key=key)
    if service.engine:
        database.chmod(0o600)
    return service
