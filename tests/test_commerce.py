"""Authoritative state transitions and real two-site HTTP commerce boundaries."""
import hashlib
import asyncio
import http.client
import json
import os
import subprocess
import secrets
import sqlite3
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any
from typing import Callable
from typing import Dict
from typing import List
from typing import Mapping
from typing import Optional
from typing import Tuple
from typing import Type
from typing import Union
from unittest.mock import MagicMock
from unittest.mock import patch
from urllib.error import URLError

from nsdeploy.cailville_map import CailvilleMap
from nsdeploy.commerce.arbiter import Arbiter
from nsdeploy.commerce.arbiter import CommerceError
from nsdeploy.commerce.catalog import default_trip
from nsdeploy.commerce.catalog import public_catalog
from nsdeploy.commerce.service import API
from nsdeploy.commerce.service import KEY_HEADER
from nsdeploy.commerce.service import CommerceSite
from nsdeploy.commerce.service import from_plan
from nsdeploy.commerce.steward import ButterpinkCommerceGateway
from nsdeploy.commerce.steward import TURN
from nsdeploy.cailville import choose_position
from nsdeploy.gateway import make_gateway_handler
from nsdeploy.generate import generate_site
from nsdeploy.generate import build_private_steward_hocon
from nsdeploy.launcher import DEFAULT_RUNTIME_DIR
from nsdeploy.launcher import make_handler
from nsdeploy.resolve import DeploymentPlan


class ArbiterStateTests(unittest.TestCase):
    """
    Tests for the vendored arbiter engine's state transitions and sealed views.
    """

    def setUp(self) -> None:
        """
        Create a fresh arbiter on a temporary database with a controllable clock and one deal.
        """
        self.temp: tempfile.TemporaryDirectory[str] = (
            tempfile.TemporaryDirectory())  # pylint: disable=consider-using-with; removed by addCleanup
        self.addCleanup(self.temp.cleanup)
        self.now: int = 1900000000
        self.engine: Arbiter = Arbiter(Path(self.temp.name) / 'arbiter.sqlite', clock=lambda: self.now)
        self.deal: Dict[str, Any] = self.engine.create(default_trip(), 50000)

    def market(self, deal: Optional[Dict[str, Any]] = None) -> Tuple[List[Dict[str, Any]], str, Dict[str, Any]]:
        """
        Run one seller bid for a deal and resolve its offers.

        :param deal: The deal to use; defaults to the deal created in setUp.
        :return: A tuple of the resolved offers, the seller capability and the bid.
        """
        deal = deal or self.deal
        seller: str = self.engine.provider_capability(deal['buyer_token'], 'seabreeze_inn', 1)
        bid: Dict[str, Any] = self.engine.submit_bid(seller, 'seabreeze_inn')
        return self.engine.resolve(deal['buyer_token'])['offers'], seller, bid

    def test_vendored_engine_is_exact_upstream_snapshot(self) -> None:
        """
        Check that the vendored arbiter matches the pinned upstream sha256.
        """
        source: Path = Path(__file__).parents[1] / 'nsdeploy/commerce/arbiter.py'
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                         'bfd34f54b3adc883c9f325eee3a4cbb42054a37361d445f3d303aaeef3bb97e3')

    def test_fixed_catalog_nash_offer_and_sealed_views(self) -> None:
        """
        Check the fixed catalog price, the Nash offer and that public views leak no secrets.
        """
        self.assertEqual(public_catalog('seabreeze_inn', default_trip())['total_cents'], 52500)
        offers: List[Dict[str, Any]]
        seller: str
        bid: Dict[str, Any]
        offers, seller, bid = self.market()
        self.assertEqual(offers[0]['total_cents'], 47750)
        self.assertEqual(sum(line['cents'] for line in offers[0]['line_items']), 47750)
        self.assertEqual(bid['status'], 'BID_COMMITTED')
        public: str = json.dumps([self.engine.public_request(seller, 'seabreeze_inn'), offers, bid])
        secret: str
        for secret in ('floor', 'budget', 'owner_token', 'buyer_token', '": 45500', '": 50000'):
            self.assertNotIn(secret, public)

    def test_no_agreement_and_ceiling_above_catalog(self) -> None:
        """
        Check a budget below the floor yields no agreement and a high ceiling caps at the offer.
        """
        low: Dict[str, Any] = self.engine.create(default_trip(), 45000)
        self.assertEqual(self.market(low)[0], [])
        self.assertEqual(self.engine.snapshot(low['owner_token'])['state'], 'NO_AGREEMENT')
        high: Dict[str, Any] = self.engine.create(default_trip(), 200000)
        self.assertEqual(self.market(high)[0][0]['total_cents'], 49000)

    def test_capabilities_cannot_cross_roles_or_deals(self) -> None:
        """
        Check that capabilities cannot be used across roles or deals.
        """
        offers: List[Dict[str, Any]]
        seller: str
        offers, seller, _ = self.market()
        foreign: Dict[str, Any] = self.engine.create(default_trip(), 50000)
        token: str
        for token in (seller, self.deal['buyer_token'], foreign['owner_token'], 'forged'):
            with self.assertRaises(CommerceError):
                self.engine.authorize(token, offers[0]['offer_id'])
        direct: str = self.engine.provider_capability(self.deal['buyer_token'], 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.submit_bid(direct, 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.offers(seller)

    def test_parallel_approval_and_settlement_are_idempotent_and_persist(self) -> None:
        """
        Check that parallel approvals settle once and the receipt survives a restart.
        """
        offers: List[Dict[str, Any]]
        bid: Dict[str, Any]
        offers, _, bid = self.market()
        self.assertEqual(self.market()[2], bid)
        owner: str = self.deal['owner_token']
        pool: ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: self.engine.authorize(owner, offers[0]['offer_id']), range(8)))
            receipts: List[Dict[str, Any]] = list(pool.map(lambda _: self.engine.confirm(owner), range(8)))
        self.assertTrue(all(receipt == receipts[0] for receipt in receipts))
        db: sqlite3.Connection
        with self.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ledger').fetchone()[0], 1)
        restored: Arbiter = Arbiter(self.engine.path, clock=lambda: self.now)
        self.assertEqual(restored.confirm(owner), receipts[0])

    def test_failure_cancel_and_expiry_release_without_charge(self) -> None:
        """
        Check that failure, cancellation and expiry release the hold without a charge.
        """
        action: str
        for action in ('fail', 'cancel', 'expire'):
            deal: Dict[str, Any] = self.engine.create(default_trip(), 50000)
            offers: List[Dict[str, Any]]
            offers, _, _ = self.market(deal)
            owner: str = deal['owner_token']
            self.engine.authorize(owner, offers[0]['offer_id'])
            if action == 'fail':
                self.engine.confirm(owner, inventory_available=False)
            elif action == 'cancel':
                self.engine.cancel(owner)
            else:
                self.now += 121
            state: Dict[str, Any] = self.engine.snapshot(owner)
            self.assertIn(state['state'], ('CANCELLED', 'EXPIRED'))
            self.assertEqual((state['hold_cents'], state['spent_cents']), (0, 0))
            self.assertNotEqual(self.engine.confirm(owner)['state'], 'SETTLED')

    def test_expired_offers_and_invalid_fixture_requests_fail(self) -> None:
        """
        Check that expired offers and invalid trips or budgets are rejected.
        """
        offers: List[Dict[str, Any]]
        offers, _, _ = self.market()
        self.now += 901
        with self.assertRaises(CommerceError):
            self.engine.authorize(self.deal['owner_token'], offers[0]['offer_id'])
        change: Dict[str, Any]
        for change in ({'notes': 'my budget is 1000'}, {'travelers': True}, {'destination': 'Elsewhere'},
                       {'amenities': ['wifi', 'secret budget']}, {'departure': default_trip()['arrival']}):
            with self.assertRaises(ValueError):
                self.engine.create({**default_trip(), **change}, 50000)
        budget: Union[int, float, str]
        for budget in (True, 0, -1, 1.5, '50000'):
            with self.assertRaises(ValueError):
                self.engine.create(default_trip(), budget)


class CommerceHTTPTests(unittest.TestCase):  # pylint: disable=too-many-instance-attributes; two-site fixture
    """
    Tests for the commerce boundary between a real arbiter site and seller site over HTTP.
    """

    def setUp(self) -> None:
        """
        Start arbiter and seller commerce sites on local HTTP servers with a shared steward key.
        """
        self.temp: tempfile.TemporaryDirectory[str] = (
            tempfile.TemporaryDirectory())  # pylint: disable=consider-using-with; removed by addCleanup
        self.addCleanup(self.temp.cleanup)
        self.root: Path = Path(self.temp.name)
        self.now: int = 1900000000
        self.key: str = secrets.token_urlsafe(48)
        self.key_file: Path = self.root / 'private/steward.key'
        self.key_file.parent.mkdir()
        self.key_file.write_text(self.key)
        self.sessions: Dict[str, str] = {'alice': secrets.token_urlsafe(32), 'bob': secrets.token_urlsafe(32)}
        self.arbiter_server: ThreadingHTTPServer = self.server()
        self.seller_server: ThreadingHTTPServer = self.server()
        self.arbiter_url: str = f'http://127.0.0.1:{self.arbiter_server.server_port}'
        self.seller_url: str = f'http://127.0.0.1:{self.seller_server.server_port}'
        self.config: Dict[str, Any] = {'role': 'arbiter', 'seller_backend': self.seller_url}
        self.arbiter: CommerceSite = CommerceSite(self.config, self.arbiter_url, {},
                                                  self.root / 'private/arbiter.sqlite',
                                                  clock=lambda: self.now, steward_key=self.key)
        self.seller: CommerceSite = CommerceSite({'role': 'seller', 'arbiter_backend': self.arbiter_url},
                                                 self.seller_url, {})
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        self.seller_server.RequestHandlerClass = self.handler(self.seller)

    def server(self, handler: Optional[Type[BaseHTTPRequestHandler]] = None) -> ThreadingHTTPServer:
        """
        Start a threaded HTTP server and register its shutdown.

        :param handler: The request handler class; defaults to a plain launcher handler.
        :return: The running server.
        """
        handler = handler or make_handler(self.root, '', DEFAULT_RUNTIME_DIR, [])
        server: ThreadingHTTPServer = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def handler(self, service: CommerceSite) -> Type[BaseHTTPRequestHandler]:
        """
        Build a launcher handler that serves an existing site plus a commerce service.

        :param service: The commerce service to mount.
        :return: The request handler class.
        """
        site: Path = self.root / 'site'
        site.mkdir(exist_ok=True)
        (site / 'index.html').write_text('existing agent site')
        return make_handler(site, '', DEFAULT_RUNTIME_DIR, [], commerce=service)

    # pylint: disable-next=too-many-arguments,too-many-positional-arguments
    def request(self, operation: str = '', body: Optional[Dict[str, Any]] = None, user: str = 'alice',
                headers: Optional[Mapping[str, Optional[str]]] = None, server: Optional[ThreadingHTTPServer] = None,
                path: Optional[str] = None) -> Tuple[int, Any, Dict[str, str]]:
        """
        Send a request to a commerce site and decode the response.

        :param operation: The commerce API operation name.
        :param body: The JSON body; None sends a GET.
        :param user: The session user whose token the body carries.
        :param headers: Header overrides; a None value removes the header.
        :param server: The target server; defaults to the arbiter.
        :param path: An explicit request path that replaces the API operation path.
        :return: A tuple of the status code, the decoded body and the response headers.
        """
        server = server or self.arbiter_server
        values: Dict[str, Optional[str]] = {'Connection': 'close', KEY_HEADER: self.key,
                                            'Content-Type': 'application/json'}
        values.update(headers or {})
        values = {key: value for key, value in values.items() if value is not None}
        if body is not None and operation not in ('provider-bid', 'seller-bid'):
            body = {'session': self.sessions[user], **body}
        connection: http.client.HTTPConnection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
        connection.request('POST' if body is not None else 'GET', path or API + operation,
                           json.dumps(body) if body is not None else None, values)
        response: http.client.HTTPResponse = connection.getresponse()
        raw: bytes
        extra: Dict[str, str]
        raw, extra = response.read(), dict(response.getheaders())
        data: Any = json.loads(raw) if extra.get('Content-Type') == 'application/json' else raw.decode()
        code: int = response.status
        connection.close()
        return code, data, extra

    def negotiate(self, budget: int = 50000, user: str = 'alice') -> Dict[str, Any]:
        """
        Negotiate the default trip and assert success.

        :param budget: The budget in cents.
        :param user: The session user.
        :return: The negotiation state.
        """
        code: int
        state: Dict[str, Any]
        code, state, _ = self.request('negotiate', {'trip': default_trip(), 'budget_cents': budget}, user=user)
        self.assertEqual(code, 200, state)
        return state

    def test_real_http_negotiation_approval_receipt_and_retries(self) -> None:
        """
        Check negotiation, approval, the receipt and idempotent retries over real HTTP.
        """
        provider_action: Callable[[str, Any], Dict[str, Any]] = (
            self.seller._provider_action)  # pylint: disable=protected-access
        call: MagicMock
        with patch.object(self.seller, '_provider_action', wraps=provider_action) as call:
            state: Dict[str, Any] = self.negotiate()
            seller_body: Dict[str, Any] = call.call_args.args[1]
            self.assertEqual(set(seller_body), {'trip', 'capability'})
            self.assertNotIn('50000', json.dumps(seller_body))
        self.assertEqual(state['offers'][0]['total_cents'], 47750)
        self.assertEqual((state['hold_cents'], state['spent_cents']), (0, 0))
        self.assertEqual(self.negotiate()['offers'], state['offers'])
        payload: Dict[str, Any] = {'offer_id': state['offers'][0]['offer_id']}
        result: Dict[str, Any] = self.request('approve', payload)[1]
        self.assertEqual(result['state'], 'SETTLED')
        self.assertEqual(result['receipt']['paid_cents'], 47750)
        self.assertEqual(self.request('approve', payload)[1]['receipt'], result['receipt'])
        self.assertEqual(self.negotiate()['receipt'], result['receipt'])
        db: sqlite3.Connection
        with self.arbiter.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ledger').fetchone()[0], 1)
        serialized: str = json.dumps(result)
        secret: str
        for secret in (self.key, self.sessions['alice'], 'owner_token', 'buyer_token', 'floor_cents'):
            self.assertNotIn(secret, serialized)

    def test_no_web_interface_pairing_cookie_or_browser_access(self) -> None:
        """
        Check that commerce exposes no web UI, pairing, cookies or browser access.
        """
        path: str
        for path in ('/commerce', '/commerce/checkout.js', '/commerce/commerce.css', '/commerce/api/session',
                     '/commerce/api/steward-pair', '/commerce/api/create'):
            code: int
            headers: Mapping[str, Optional[str]]
            code, _, headers = self.request(path=path)
            self.assertEqual(code, 404, path)
            self.assertNotIn('Set-Cookie', headers)
        for headers in ({KEY_HEADER: None}, {KEY_HEADER: 'forged'}, {'Origin': self.arbiter_url}):
            body: Dict[str, Any] = {'trip': default_trip(), 'budget_cents': 50000}
            self.assertEqual(self.request('negotiate', body, headers=headers)[0], 403)
        self.assertNotIn('Access-Control-Allow-Origin', self.request('info')[2])
        self.assertEqual(self.request(path='/')[1], 'existing agent site')

    def test_private_session_isolation_and_forged_prices(self) -> None:
        """
        Check that sessions are isolated and forged approval fields are rejected.
        """
        alice: Dict[str, Any] = self.negotiate()
        bob: Dict[str, Any] = self.negotiate(user='bob')
        payload: Dict[str, Any] = {'offer_id': alice['offers'][0]['offer_id']}
        self.assertEqual(self.request('approve', payload, user='bob')[0], 409)
        extra: Dict[str, Any]
        for extra in ({'price': 1}, {'owner': 'model'}, {'approved': True}):
            self.assertEqual(self.request('approve', {**payload, **extra})[0], 400)
        self.assertEqual(self.request('approve', {'offer_id': 'fake'})[0], 409)
        self.assertNotEqual(alice['deal_id'], bob['deal_id'])

    def test_invalid_dates_scope_budget_and_mandate_changes(self) -> None:
        """
        Check that invalid budgets, trips and mandate changes are rejected.
        """
        self.negotiate()
        budget: Union[int, float]
        for budget in (True, 50000.5, -1):
            self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': budget})[0], 400)
        self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': 60000})[0], 409)
        trip: Dict[str, Any] = {**default_trip(), 'travelers': 5}
        self.assertEqual(self.request('negotiate', {'trip': trip, 'budget_cents': 50000})[0], 400)
        self.request('cancel', {})
        self.assertEqual(self.negotiate(60000)['state'], 'NEGOTIATING')

    def test_no_agreement_cancel_inventory_failure_expiry_and_restart(self) -> None:
        """
        Check no agreement, inventory failure, restart persistence and expiry.
        """
        self.assertEqual(self.negotiate(45000)['state'], 'NO_AGREEMENT')
        offer: Dict[str, Any] = self.negotiate()['offers'][0]
        self.arbiter.inventory_available = False
        result: Dict[str, Any] = self.request('approve', {'offer_id': offer['offer_id']})[1]
        self.assertEqual((result['state'], result['spent_cents']), ('CANCELLED', 0))
        state: Dict[str, Any] = self.negotiate(51000)
        self.arbiter = CommerceSite(self.config, self.arbiter_url, {}, self.root / 'private/arbiter.sqlite',
                                    clock=lambda: self.now, steward_key=self.key)
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        self.assertEqual(self.request('status', {})[1]['offers'], state['offers'])
        self.now += 901
        self.assertEqual(self.request('approve', {'offer_id': state['offers'][0]['offer_id']})[0], 409)
        self.now += 86400
        self.assertEqual(self.request('status', {})[0], 403)

    def test_outage_retry_is_idempotent(self) -> None:
        """
        Check that a seller outage fails cleanly and a retry creates one deal.
        """
        with patch('nsdeploy.commerce.service.post_json', side_effect=URLError('offline')):
            self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': 50000})[0], 502)
        self.assertEqual(self.negotiate()['offers'][0]['total_cents'], 47750)
        db: sqlite3.Connection
        with self.arbiter.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM deals').fetchone()[0], 1)

    def test_concurrent_retries_settle_once(self) -> None:
        """
        Check that concurrent approvals return one receipt.
        """
        offer: Dict[str, Any] = self.negotiate()['offers'][0]
        payload: Dict[str, Any] = {'offer_id': offer['offer_id']}
        pool: ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            receipts: List[Dict[str, Any]] = list(pool.map(lambda _: self.request('approve', payload)[1]['receipt'],
                                                           range(4)))
        self.assertTrue(all(item == receipts[0] for item in receipts))

    def test_seller_capability_cannot_approve_or_forge_a_bid(self) -> None:
        """
        Check that a seller cannot forge a bid capability or approve an offer.
        """
        state: Dict[str, Any] = self.negotiate()
        token: str
        for token in ('forged', self.sessions['alice']):
            self.assertEqual(self.request('provider-bid', {'trip': default_trip(), 'capability': token})[0], 409)
        forged: Dict[str, Any] = {'trip': default_trip(), 'capability': 'forged'}
        self.assertEqual(self.request('provider-bid', forged, headers={'Origin': self.seller_url})[0], 403)
        approval: Dict[str, Any] = {'offer_id': state['offers'][0]['offer_id']}
        self.assertEqual(self.request('approve', approval, server=self.seller_server)[0], 403)

    def test_subdomain_gateway_preserves_server_only_flow(self) -> None:
        """
        Check that the subdomain gateway passes the server-only negotiation through.
        """
        gateway: ThreadingHTTPServer = self.server(make_gateway_handler('localhost',
                                                                        {'commerce-arbiter': self.arbiter_url}))
        host: Dict[str, str] = {'Host': f'commerce-arbiter.localhost:{gateway.server_port}'}
        code: int
        result: Dict[str, Any]
        code, result, _ = self.request('negotiate', {'trip': default_trip(), 'budget_cents': 50000},
                                       server=gateway, headers=host)
        self.assertEqual(code, 200, result)
        self.assertEqual(result['offers'][0]['total_cents'], 47750)

    def graph(self, prompts: List[str]) -> List[Dict[str, Any]]:
        """
        Run the private steward graph in a subprocess against the arbiter.

        :param prompts: The user prompts to send in order.
        :return: The per-turn results the graph reports.
        """
        network: Path = self.root / 'private.hocon'
        plan: DeploymentPlan = DeploymentPlan('butterpink_family',
                                              {'private_commerce': {'steward': 'butterpink_family'}}, 'front')
        network.write_text(build_private_steward_hocon(plan, 'http://127.0.0.1:8096'))
        script: str = ('import json,sys; req=json.load(sys.stdin); sys.path.insert(0, req["test_dir"]); '
                       'from commerce_graph import run; '
                       'print("RESULT:"+json.dumps(run(req["network"],req["prompts"])))')
        repo: str = str(Path(__file__).resolve().parents[1])
        request: str = json.dumps({'network': str(network), 'prompts': prompts,
                                   'test_dir': str(Path(__file__).resolve().parent)})
        env: Dict[str, str] = {**os.environ, 'AGENT_TOOL_PATH': repo,
                               'PYTHONPATH': repo + os.pathsep + os.environ.get('PYTHONPATH', ''),
                               'NSDEPLOY_COMMERCE_ARBITER_URL': self.arbiter_url,
                               'NSDEPLOY_COMMERCE_KEY_FILE': str(self.key_file)}
        # The return code is asserted below with the output attached.
        result: subprocess.CompletedProcess[str] = subprocess.run([sys.executable, '-c', script], input=request,
                                                                  text=True, capture_output=True,
                                                                  timeout=120, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:] + result.stdout[-4000:])
        self.assertNotIn(self.key, result.stdout + result.stderr)
        return json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith('RESULT:')))

    def test_real_graph_books_from_natural_request_and_subsequent_confirmation(self) -> None:
        """
        Check that the graph negotiates from a natural request and settles on a later confirmation.
        """
        arrival: str = default_trip()['arrival']
        results: List[Dict[str, Any]] = self.graph([f'Book a night at the inn on {arrival} for under $500.',
                                                    'Confirm booking', 'What is my booking status?'])
        self.assertIsNotNone(results[0]['state'], results)
        self.assertEqual(results[0]['state']['state'], 'NEGOTIATING', results)
        self.assertIn('$477.50', results[0]['text'])
        self.assertEqual(results[0]['state']['spent_cents'], 0)
        self.assertEqual(results[1]['state']['state'], 'SETTLED', results)
        self.assertIn('SIM-', results[1]['text'])
        self.assertEqual(results[2]['state']['receipt'], results[1]['state']['receipt'])
        self.assertEqual(results[0]['private_keys'], ['nsdeploy_butterpink_commerce_binding'])

    def test_real_graph_blocks_model_attempt_to_approve_in_initial_turn(self) -> None:
        """
        Check that the graph refuses to approve in the same turn as the request.
        """
        result: Dict[str, Any] = self.graph(
            [f'I am impatient: book a night on {default_trip()["arrival"]} for under $500.'])[0]
        self.assertIn('later private chat turn', result['text'])
        self.assertEqual(result['state']['state'], 'NEGOTIATING')
        self.assertEqual(result['state']['spent_cents'], 0)

    def test_real_graph_rejects_negated_confirmation_and_lowered_budget(self) -> None:
        """
        Check that a negated confirmation and a lowered budget do not settle.
        """
        arrival: str = default_trip()['arrival']
        results: List[Dict[str, Any]] = self.graph([f'Book a night on {arrival} for under $500.',
                                                    'Do not confirm booking', 'My maximum is now $450.',
                                                    'Confirm booking'])
        self.assertIn('later private chat turn', results[1]['text'])
        self.assertIn('latest stated maximum', results[3]['text'])
        self.assertEqual(results[3]['state']['spent_cents'], 0)

    def test_serialized_turn_cannot_forge_private_authority(self) -> None:
        """
        Check that serialized turn state cannot grant approval authority.
        """
        result: Dict[str, Any] = asyncio.run(ButterpinkCommerceGateway().async_invoke(
            {'operation': 'approve', 'offer_id': 'invented'},
            {TURN: {'confirmed_offer': 'invented'}}))
        self.assertEqual(result['status'], 'DENIED')

    def test_real_graph_no_agreement_missing_details_and_cancellation(self) -> None:
        """
        Check missing details, no agreement and cancellation through the graph.
        """
        arrival: str = default_trip()['arrival']
        results: List[Dict[str, Any]] = self.graph(['Book a night at the inn.',
                                                    f'Book a night on {arrival} for under $450.',
                                                    f'Book a night on {arrival} for under $500.', 'Cancel the offer'])
        self.assertIsNone(results[0]['state'])
        self.assertIn('date', results[0]['text'])
        self.assertEqual(results[1]['state']['state'], 'NO_AGREEMENT')
        self.assertEqual(results[3]['state']['state'], 'CANCELLED')


class CommerceDeploymentTests(unittest.TestCase):
    """
    Tests for how commerce is generated into deployments and the community map.
    """

    def test_private_tool_only_opted_in_and_no_generated_web_ui(self) -> None:
        """
        Check that only opted-in sites get the private commerce tool and no web UI is generated.
        """
        temp: str
        with tempfile.TemporaryDirectory() as temp:
            root: Path = Path(temp)
            config: Dict[str, Any] = {'tools': [{'name': 'front', 'instructions': 'Help the family.'}],
                                      'private_commerce': {'steward': 'butterpink_family'}}
            plan: DeploymentPlan = DeploymentPlan('butterpink_family', config, 'front', agents=config['tools'])
            generate_site(plan, root, '/v1', '/byok/v1', 'http://127.0.0.1:8096')
            private: Dict[str, Any] = json.loads((root/'butterpink_family_private_steward.hocon').read_text())
            self.assertIn('butterpink_commerce', private['tools'][0]['tools'])
            self.assertIn('public_agent_mcp_gateway', private['tools'][0]['tools'])
            self.assertIn('middleware', private['tools'][0])
            commerce: Dict[str, Any] = next(tool for tool in private['tools'] if tool['name'] == 'butterpink_commerce')
            self.assertEqual(commerce['function']['parameters']['properties']['budget_cents']['type'], 'int')
            self.assertNotIn('ButterpinkCommerceGateway', (root/'butterpink_family.network.json').read_text())
            self.assertNotIn('Commerce demo', (root/'index.html').read_text())
            ordinary: DeploymentPlan = DeploymentPlan('rivera_household', {}, 'front')
            self.assertNotIn('butterpink_commerce', build_private_steward_hocon(ordinary, 'http://127.0.0.1:8092'))

    def test_private_key_and_database_outside_public_tree(self) -> None:
        """
        Check that the key and database live outside the public tree with 0600 permissions.
        """
        temp: str
        with tempfile.TemporaryDirectory() as temp:
            root: Path = Path(temp)
            config: Dict[str, Any] = {'commerce': {'role': 'arbiter', 'seller_backend': 'http://127.0.0.1:8093'}}
            plan: DeploymentPlan = DeploymentPlan('commerce_arbiter', config, 'front')
            service: Optional[CommerceSite] = from_plan(plan, root / 'public', 'http://127.0.0.1:8105')
            path: Path
            for path in (Path(service.engine.path), root / '.commerce/steward.key'):
                self.assertFalse(path.is_relative_to(root / 'public'))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            reloaded: Optional[CommerceSite] = from_plan(plan, root/'public', 'http://127.0.0.1:8105')
            self.assertEqual(service.steward_key, reloaded.steward_key)

    def test_map_keeps_arbiter_and_existing_private_nsflow_links(self) -> None:
        """
        Check that the community map keeps arbiter links and private nsFlow links.
        """
        root: Path = Path(__file__).parents[1] / 'cailville'
        path: Path
        # Check the checked-in base map and the active map, which is the base map until a site is added.
        for path in [root / 'community.base.json', CailvilleMap.active_path(root)]:
            community: Dict[str, Any] = json.loads(path.read_text())
            self.assertIn(['butterpink_family', 'commerce_arbiter'], community['relationships'])
            self.assertIn(['seabreeze_inn', 'commerce_arbiter'], community['relationships'])
            rightmost: int = max(site['position']['my_px'] for site in community['sites'])
            self.assertGreater(choose_position(community['sites'])['my_px'], rightmost)
        page: str = (root / 'cailville.html').read_text()
        self.assertIn('stewards-toggle', page)
        self.assertIn('Open ${sites[siteId].name} private steward in nsFlow', page)


if __name__ == '__main__':
    unittest.main()
