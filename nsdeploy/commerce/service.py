"""Explicitly enabled HTTP adapter around the upstream commerce authority.

Human capabilities remain in a private SQLite session table. Agent/MCP routes
have no access to that table. The merchant receives only a bounded public trip
and a deal-scoped seller capability; callbacks go to its configured arbiter.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from pathlib import Path

from .arbiter import Arbiter, CommerceError
from .catalog import default_trip, public_catalog, validate_trip

ASSETS = Path(__file__).with_name("static")
PROVIDER = "seabreeze_inn"
ARBITER = "commerce_arbiter"
API = "/commerce/api/"


def origin(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password):
        raise ValueError("Commerce endpoints must use an http(s) origin.")
    return f"{parsed.scheme}://{parsed.netloc}"


def post_json(url, body):
    # Only trusted deployment configuration supplies URLs. Never follow a redirect
    # with a seller capability, and never forward browser cookies or BYOK headers.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    request = urllib.request.Request(url, json.dumps(body).encode(),
                                     {"Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        result = json.loads(response.read(65537))
        if not isinstance(result, dict):
            raise ValueError("Invalid commerce adapter response.")
        return result


class CommerceSite:
    def __init__(self, config, site_base, links, database=None, clock=time.time):
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
        self.cookie_name = "nscommerce_" + hashlib.sha256(self.site_base.encode()).hexdigest()[:12]
        self.engine = Arbiter(database, clock=clock) if self.role == "arbiter" else None
        if self.engine:
            with self.engine.db() as db:
                db.execute("""CREATE TABLE IF NOT EXISTS human_sessions (
                    digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL,
                    deal TEXT, owner TEXT, buyer TEXT)""")

    def _session(self, handler, create=False):
        cookie = SimpleCookie()
        try:
            cookie.load(handler.headers.get("Cookie", ""))
        except ValueError:
            pass
        token = cookie[self.cookie_name].value if self.cookie_name in cookie else ""
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.engine.db() as db:
            row = db.execute("SELECT * FROM human_sessions WHERE digest=? AND expires>?",
                             (digest, self.clock())).fetchone()
            if row:
                return dict(row), None
            if not create:
                raise PermissionError("Open the arbiter checkout to establish your human session.")
            token = secrets.token_urlsafe(32)
            digest = hashlib.sha256(token.encode()).hexdigest()
            csrf = secrets.token_urlsafe(32)
            db.execute("INSERT INTO human_sessions(digest,csrf,expires) VALUES(?,?,?)",
                       (digest, csrf, self.clock() + 86400))
            row = db.execute("SELECT * FROM human_sessions WHERE digest=?", (digest,)).fetchone()
        secure = "; Secure" if self.site_base.startswith("https:") else ""
        return dict(row), (f"{self.cookie_name}={token}; HttpOnly; SameSite=Strict; "
                           f"Path=/commerce/api/; Max-Age=86400{secure}")

    def _view(self, session):
        if not session["owner"]:
            return {"state": "NEW", "offers": [], "events": [], "simulation": True}
        state = self.engine.snapshot(session["owner"])
        state["offers"] = self.engine.offers(session["buyer"])["offers"]
        state["simulation"] = True
        return state

    def _human_action(self, session, operation, body):
        if operation == "create":
            self._fields(body, {"trip", "budget_cents"})
            validate_trip(body["trip"])
            if type(body["budget_cents"]) is not int or not 1 <= body["budget_cents"] <= 10000000:
                raise ValueError("Budget must be a positive integer amount in cents, up to USD 100,000.")
            # Retry a lost create response without minting another mandate.
            if session["owner"]:
                current = self._view(session)
                if current["state"] not in ("SETTLED", "CANCELLED", "EXPIRED", "NO_AGREEMENT"):
                    if current["trip"] == body["trip"] and current["budget_cents"] == body["budget_cents"]:
                        return current
                    raise CommerceError("Cancel the current negotiation before changing its mandate.")
            deal = self.engine.create(body["trip"], body["budget_cents"], created_by="human_checkout")
            with self.engine.db() as db:
                db.execute("UPDATE human_sessions SET deal=?,owner=?,buyer=? WHERE digest=?",
                           (deal["deal_id"], deal["owner_token"], deal["buyer_token"], session["digest"]))
            session.update(deal=deal["deal_id"], owner=deal["owner_token"], buyer=deal["buyer_token"])
            return self._view(session)

        fields = {"deal_id", "offer_id"} if operation == "authorize" else {"deal_id"}
        self._fields(body, fields)
        if not session["deal"] or body["deal_id"] != session["deal"]:
            raise PermissionError("This deal does not belong to the active human session. Refresh the checkout.")
        if operation == "negotiate":
            current = self._view(session)
            if current["state"] not in ("OPEN", "NEGOTIATING"):
                raise CommerceError("This deal is closed. Start a new negotiation.")
            # Repeated calls read the immutable offer, never contact or reprice.
            with self.engine.db() as db:
                resolved = db.execute("SELECT 1 FROM offers WHERE deal=?", (session["deal"],)).fetchone()
            if not resolved:
                capability = self.engine.provider_capability(session["buyer"], PROVIDER, 1)
                public = self.engine.public_request(capability, PROVIDER)
                # A separate HTTP request executes the Inn's coded seller adapter.
                result = post_json(self.backend + API + "seller-bid",
                                   {"trip": public["trip"], "capability": capability})
                committed = self.engine.bid_receipt(session["deal"], PROVIDER)
                if result.get("commitment") != committed.get("commitment") or committed["status"] != "BID_COMMITTED":
                    raise CommerceError("The Inn did not commit a valid sealed bid. Retry negotiation.")
                self.engine.resolve(session["buyer"])
        elif operation == "authorize":
            if not isinstance(body["offer_id"], str):
                raise ValueError("An arbiter-issued offer ID is required.")
            self.engine.authorize(session["owner"], body["offer_id"])
        elif operation in ("confirm", "fail-inventory"):
            # Demo-only trusted inventory simulator, absent from all agent tools.
            self.engine.confirm(session["owner"], inventory_available=operation == "confirm")
        elif operation == "cancel":
            self.engine.cancel(session["owner"])
        else:
            raise ValueError("Unknown human commerce action.")
        return self._view(session)

    @staticmethod
    def _fields(body, expected):
        if not isinstance(body, dict) or set(body) != expected:
            raise ValueError("Unexpected fields in commerce request.")

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

    def handle(self, handler):
        path = urllib.parse.urlsplit(handler.path).path
        assets = {"/commerce": ("checkout.html", "text/html; charset=utf-8"),
                  "/commerce/checkout.js": ("checkout.js", "text/javascript; charset=utf-8"),
                  "/commerce/commerce.css": ("commerce.css", "text/css; charset=utf-8")}
        try:
            if handler.command == "GET" and path in assets:
                if path == "/commerce" and self.role == "seller":
                    return self._send(handler, 303, b"", "text/plain",
                                      {"Location": self.arbiter_url + "/commerce"})
                name, mime = assets[path]
                return self._send(handler, 200, (ASSETS / name).read_bytes(), mime)
            operation = path.removeprefix(API) if path.startswith(API) else ""
            if handler.command == "GET":
                if operation == "info":
                    return self._json(handler, 200, {"role": self.role, "arbiter_url": self.arbiter_url,
                        "seller_url": self.seller_url, "catalog": public_catalog(PROVIDER, default_trip())})
                if operation == "session" and self.engine:
                    session, cookie = self._session(handler, create=True)
                    return self._json(handler, 200, {"csrf": session["csrf"], **self._view(session)},
                                      {"Set-Cookie": cookie} if cookie else None)
                return self._json(handler, 404, {"error": "Unknown commerce endpoint."})
            if handler.command != "POST":
                return self._json(handler, 405, {"error": "Method not allowed."})
            # Reject cross-origin browser writes before reading the body. Provider
            # callbacks carry no browser Origin and still require a scoped capability.
            provider_action = operation in ("seller-bid", "provider-bid")
            request_origin = handler.headers.get("Origin")
            if ((not provider_action and request_origin != self.site_base)
                    or (provider_action and request_origin is not None)):
                handler.close_connection = True
                raise PermissionError("Commerce changes require the arbiter's own checkout origin.")
            if handler.headers.get("Content-Type", "").split(";")[0] != "application/json":
                handler.close_connection = True
                raise ValueError("Commerce requests must use application/json.")
            length = int(handler.headers.get("Content-Length", "0"))
            if not 1 <= length <= 8192 or handler.headers.get("Transfer-Encoding"):
                handler.close_connection = True
                raise ValueError("Invalid commerce request size.")
            body = json.loads(handler.rfile.read(length))
            if provider_action:
                return self._json(handler, 200, self._provider_action(operation, body))
            if not self.engine:
                raise PermissionError("Human mandates and approval belong on the arbiter site.")
            # Serializes a session's competing human actions, but not seller callbacks.
            with self.action_lock:
                session, _ = self._session(handler)
                if not secrets.compare_digest(handler.headers.get("X-Commerce-CSRF", ""), session["csrf"]):
                    raise PermissionError("Invalid checkout CSRF token. Refresh the page.")
                result = self._human_action(session, operation, body)
            return self._json(handler, 200, result)
        except PermissionError as exc:
            return self._json(handler, 403, {"error": str(exc)})
        except CommerceError as exc:
            return self._json(handler, 409, {"error": str(exc)})
        except (ValueError, TypeError, KeyError) as exc:
            return self._json(handler, 400, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError):
            return self._json(handler, 502, {"error": "Commerce peer unavailable. Start both sites, then retry; no funds were charged."})

    def _json(self, handler, status, body, extra=None):
        return self._send(handler, status, json.dumps(body).encode(), "application/json", extra)

    @staticmethod
    def _send(handler, status, body, mime, extra=None):
        handler.send_response(status)
        handler.send_header("Content-Type", mime)
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Referrer-Policy", "no-referrer")
        handler.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        # Deliberately no permissive CORS headers on private commerce routes.
        for key, value in (extra or {}).items():
            handler.send_header(key, value)
        handler.end_headers()
        handler.wfile.write(body)


def from_plan(plan, site_dir, site_base):
    config = plan.config.get("commerce")
    if not config:
        return None
    # Never place capabilities, budgets or the ledger in the statically served tree.
    database = site_dir.parent / ".commerce" / f"{plan.network_name}.sqlite"
    database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # HTTP commerce peers need not be conversational agent tools. In particular,
    # keep the arbiter concierge from calling back into the Inn's agent graph.
    links = {**(plan.config.get("links") or {}), **plan.links}
    service = CommerceSite(config, site_base, links, database)
    if service.engine:
        database.chmod(0o600)
    return service
