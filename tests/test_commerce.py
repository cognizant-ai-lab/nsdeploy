"""Authoritative state transitions and real two-site HTTP commerce boundaries."""
import hashlib
import asyncio
import http.client
import json
import os
import subprocess
import secrets
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
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
from nsdeploy.commerce.steward import PrivateTurn
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

    def setUp(self):
        """
        Create a fresh arbiter on a temporary database with a controllable clock and one deal.
        """
        self.temp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; removed by addCleanup
        self.addCleanup(self.temp.cleanup)
        self.now = 1900000000
        self.engine = Arbiter(Path(self.temp.name) / 'arbiter.sqlite', clock=lambda: self.now)
        self.deal = self.engine.create(default_trip(), 50000)

    def market(self, deal=None):
        """
        Run one seller bid for a deal and resolve its offers.

        :param deal: The deal to use; defaults to the deal created in setUp.
        :return: A tuple of the resolved offers, the seller capability and the bid.
        """
        deal = deal or self.deal
        seller = self.engine.provider_capability(deal['buyer_token'], 'seabreeze_inn', 1)
        bid = self.engine.submit_bid(seller, 'seabreeze_inn')
        return self.engine.resolve(deal['buyer_token'])['offers'], seller, bid

    def test_vendored_engine_is_exact_upstream_snapshot(self):
        """
        Check that the vendored arbiter matches the pinned upstream sha256.
        """
        source = Path(__file__).parents[1] / 'nsdeploy/commerce/arbiter.py'
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                         'bfd34f54b3adc883c9f325eee3a4cbb42054a37361d445f3d303aaeef3bb97e3')

    def test_fixed_catalog_nash_offer_and_sealed_views(self):
        """
        Check the fixed catalog price, the Nash offer and that public views leak no secrets.
        """
        self.assertEqual(public_catalog('seabreeze_inn', default_trip())['total_cents'], 52500)
        offers, seller, bid = self.market()
        self.assertEqual(offers[0]['total_cents'], 47750)
        self.assertEqual(sum(line['cents'] for line in offers[0]['line_items']), 47750)
        self.assertEqual(bid['status'], 'BID_COMMITTED')
        public = json.dumps([self.engine.public_request(seller, 'seabreeze_inn'), offers, bid])
        for secret in ('floor', 'budget', 'owner_token', 'buyer_token', '": 45500', '": 50000'):
            self.assertNotIn(secret, public)

    def test_no_agreement_and_ceiling_above_catalog(self):
        """
        Check a budget below the floor yields no agreement and a high ceiling caps at the offer.
        """
        low = self.engine.create(default_trip(), 45000)
        self.assertEqual(self.market(low)[0], [])
        self.assertEqual(self.engine.snapshot(low['owner_token'])['state'], 'NO_AGREEMENT')
        high = self.engine.create(default_trip(), 200000)
        self.assertEqual(self.market(high)[0][0]['total_cents'], 49000)

    def test_capabilities_cannot_cross_roles_or_deals(self):
        """
        Check that capabilities cannot be used across roles or deals.
        """
        offers, seller, _ = self.market()
        foreign = self.engine.create(default_trip(), 50000)
        for token in (seller, self.deal['buyer_token'], foreign['owner_token'], 'forged'):
            with self.assertRaises(CommerceError):
                self.engine.authorize(token, offers[0]['offer_id'])
        direct = self.engine.provider_capability(self.deal['buyer_token'], 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.submit_bid(direct, 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.offers(seller)

    def test_parallel_approval_and_settlement_are_idempotent_and_persist(self):
        """
        Check that parallel approvals settle once and the receipt survives a restart.
        """
        offers, _, bid = self.market()
        self.assertEqual(self.market()[2], bid)
        owner = self.deal['owner_token']
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: self.engine.authorize(owner, offers[0]['offer_id']), range(8)))
            receipts = list(pool.map(lambda _: self.engine.confirm(owner), range(8)))
        self.assertTrue(all(receipt == receipts[0] for receipt in receipts))
        with self.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ledger').fetchone()[0], 1)
        restored = Arbiter(self.engine.path, clock=lambda: self.now)
        self.assertEqual(restored.confirm(owner), receipts[0])

    def test_failure_cancel_and_expiry_release_without_charge(self):
        """
        Check that failure, cancellation and expiry release the hold without a charge.
        """
        for action in ('fail', 'cancel', 'expire'):
            deal = self.engine.create(default_trip(), 50000)
            offers, _, _ = self.market(deal)
            owner = deal['owner_token']
            self.engine.authorize(owner, offers[0]['offer_id'])
            if action == 'fail':
                self.engine.confirm(owner, inventory_available=False)
            elif action == 'cancel':
                self.engine.cancel(owner)
            else:
                self.now += 121
            state = self.engine.snapshot(owner)
            self.assertIn(state['state'], ('CANCELLED', 'EXPIRED'))
            self.assertEqual((state['hold_cents'], state['spent_cents']), (0, 0))
            self.assertNotEqual(self.engine.confirm(owner)['state'], 'SETTLED')

    def test_expired_offers_and_invalid_fixture_requests_fail(self):
        """
        Check that expired offers and invalid trips or budgets are rejected.
        """
        offers, _, _ = self.market()
        self.now += 901
        with self.assertRaises(CommerceError):
            self.engine.authorize(self.deal['owner_token'], offers[0]['offer_id'])
        for change in ({'notes': 'my budget is 1000'}, {'travelers': True}, {'destination': 'Elsewhere'},
                       {'amenities': ['wifi', 'secret budget']}, {'departure': default_trip()['arrival']}):
            with self.assertRaises(ValueError):
                self.engine.create({**default_trip(), **change}, 50000)
        for budget in (True, 0, -1, 1.5, '50000'):
            with self.assertRaises(ValueError):
                self.engine.create(default_trip(), budget)


class CommerceHTTPTests(unittest.TestCase):
    # pylint: disable=too-many-instance-attributes,too-many-public-methods
    # A two-site fixture, and one test per policy the steward enforces.
    """
    Tests for the commerce boundary between a real arbiter site and seller site over HTTP.
    """

    def setUp(self):
        """
        Start arbiter and seller commerce sites on local HTTP servers with a shared steward key.
        """
        self.temp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; removed by addCleanup
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1900000000
        self.key = secrets.token_urlsafe(48)
        self.key_file = self.root / 'private/steward.key'
        self.key_file.parent.mkdir()
        self.key_file.write_text(self.key)
        self.sessions = {'alice': secrets.token_urlsafe(32), 'bob': secrets.token_urlsafe(32)}
        self.arbiter_server = self.server()
        self.seller_server = self.server()
        self.arbiter_url = f'http://127.0.0.1:{self.arbiter_server.server_port}'
        self.seller_url = f'http://127.0.0.1:{self.seller_server.server_port}'
        self.config = {'role': 'arbiter', 'seller_backend': self.seller_url}
        self.arbiter = CommerceSite(self.config, self.arbiter_url, {}, self.root / 'private/arbiter.sqlite',
                                    clock=lambda: self.now, steward_key=self.key)
        self.seller = CommerceSite({'role': 'seller', 'arbiter_backend': self.arbiter_url}, self.seller_url, {})
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        self.seller_server.RequestHandlerClass = self.handler(self.seller)

    def server(self, handler=None):
        """
        Start a threaded HTTP server and register its shutdown.

        :param handler: The request handler class; defaults to a plain launcher handler.
        :return: The running server.
        """
        handler = handler or make_handler(self.root, '', DEFAULT_RUNTIME_DIR, [])
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def handler(self, service):
        """
        Build a launcher handler that serves an existing site plus a commerce service.

        :param service: The commerce service to mount.
        :return: The request handler class.
        """
        site = self.root / 'site'
        site.mkdir(exist_ok=True)
        (site / 'index.html').write_text('existing agent site')
        return make_handler(site, '', DEFAULT_RUNTIME_DIR, [], commerce=service)

    # pylint: disable-next=too-many-arguments,too-many-positional-arguments
    def request(self, operation='', body=None, user='alice', headers=None, server=None, path=None):
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
        values = {'Connection': 'close', KEY_HEADER: self.key, 'Content-Type': 'application/json'}
        values.update(headers or {})
        values = {key: value for key, value in values.items() if value is not None}
        if body is not None and operation not in ('provider-bid', 'seller-bid'):
            body = {'session': self.sessions[user], **body}
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
        connection.request('POST' if body is not None else 'GET', path or API + operation,
                           json.dumps(body) if body is not None else None, values)
        response = connection.getresponse()
        raw, extra = response.read(), dict(response.getheaders())
        data = json.loads(raw) if extra.get('Content-Type') == 'application/json' else raw.decode()
        code = response.status
        connection.close()
        return code, data, extra

    def negotiate(self, budget=50000, user='alice'):
        """
        Negotiate the default trip and assert success.

        :param budget: The budget in cents.
        :param user: The session user.
        :return: The negotiation state.
        """
        code, state, _ = self.request('negotiate', {'trip': default_trip(), 'budget_cents': budget}, user=user)
        self.assertEqual(code, 200, state)
        return state

    def test_real_http_negotiation_approval_receipt_and_retries(self):
        """
        Check negotiation, approval, the receipt and idempotent retries over real HTTP.
        """
        provider_action = self.seller._provider_action  # pylint: disable=protected-access
        with patch.object(self.seller, '_provider_action', wraps=provider_action) as call:
            state = self.negotiate()
            seller_body = call.call_args.args[1]
            self.assertEqual(set(seller_body), {'trip', 'capability'})
            self.assertNotIn('50000', json.dumps(seller_body))
        self.assertEqual(state['offers'][0]['total_cents'], 47750)
        self.assertEqual((state['hold_cents'], state['spent_cents']), (0, 0))
        self.assertEqual(self.negotiate()['offers'], state['offers'])
        payload = {'offer_id': state['offers'][0]['offer_id']}
        result = self.request('approve', payload)[1]
        self.assertEqual(result['state'], 'SETTLED')
        self.assertEqual(result['receipt']['paid_cents'], 47750)
        self.assertEqual(self.request('approve', payload)[1]['receipt'], result['receipt'])
        self.assertEqual(self.negotiate()['receipt'], result['receipt'])
        with self.arbiter.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM ledger').fetchone()[0], 1)
        serialized = json.dumps(result)
        for secret in (self.key, self.sessions['alice'], 'owner_token', 'buyer_token', 'floor_cents'):
            self.assertNotIn(secret, serialized)

    def test_no_web_interface_pairing_cookie_or_browser_access(self):
        """
        Check that commerce exposes no web UI, pairing, cookies or browser access.
        """
        for path in ('/commerce', '/commerce/checkout.js', '/commerce/commerce.css', '/commerce/api/session',
                     '/commerce/api/steward-pair', '/commerce/api/create'):
            code, _, headers = self.request(path=path)
            self.assertEqual(code, 404, path)
            self.assertNotIn('Set-Cookie', headers)
        for headers in ({KEY_HEADER: None}, {KEY_HEADER: 'forged'}, {'Origin': self.arbiter_url}):
            body = {'trip': default_trip(), 'budget_cents': 50000}
            self.assertEqual(self.request('negotiate', body, headers=headers)[0], 403)
        self.assertNotIn('Access-Control-Allow-Origin', self.request('info')[2])
        self.assertEqual(self.request(path='/')[1], 'existing agent site')

    def test_private_session_isolation_and_forged_prices(self):
        """
        Check that sessions are isolated and forged approval fields are rejected.
        """
        alice = self.negotiate()
        bob = self.negotiate(user='bob')
        payload = {'offer_id': alice['offers'][0]['offer_id']}
        self.assertEqual(self.request('approve', payload, user='bob')[0], 409)
        for extra in ({'price': 1}, {'owner': 'model'}, {'approved': True}):
            self.assertEqual(self.request('approve', {**payload, **extra})[0], 400)
        self.assertEqual(self.request('approve', {'offer_id': 'fake'})[0], 409)
        self.assertNotEqual(alice['deal_id'], bob['deal_id'])

    def test_invalid_dates_scope_budget_and_mandate_changes(self):
        """
        Check that invalid budgets, trips and mandate changes are rejected.
        """
        self.negotiate()
        for budget in (True, 50000.5, -1):
            self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': budget})[0], 400)
        self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': 60000})[0], 409)
        trip = {**default_trip(), 'travelers': 5}
        self.assertEqual(self.request('negotiate', {'trip': trip, 'budget_cents': 50000})[0], 400)
        self.request('cancel', {})
        self.assertEqual(self.negotiate(60000)['state'], 'NEGOTIATING')

    def test_no_agreement_cancel_inventory_failure_expiry_and_restart(self):
        """
        Check no agreement, inventory failure, restart persistence and expiry.
        """
        self.assertEqual(self.negotiate(45000)['state'], 'NO_AGREEMENT')
        offer = self.negotiate()['offers'][0]
        self.arbiter.inventory_available = False
        result = self.request('approve', {'offer_id': offer['offer_id']})[1]
        self.assertEqual((result['state'], result['spent_cents']), ('CANCELLED', 0))
        state = self.negotiate(51000)
        self.arbiter = CommerceSite(self.config, self.arbiter_url, {}, self.root / 'private/arbiter.sqlite',
                                    clock=lambda: self.now, steward_key=self.key)
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        self.assertEqual(self.request('status', {})[1]['offers'], state['offers'])
        self.now += 901
        self.assertEqual(self.request('approve', {'offer_id': state['offers'][0]['offer_id']})[0], 409)
        self.now += 86400
        self.assertEqual(self.request('status', {})[0], 403)

    def test_outage_retry_is_idempotent(self):
        """
        Check that a seller outage fails cleanly and a retry creates one deal.
        """
        with patch('nsdeploy.commerce.service.post_json', side_effect=URLError('offline')):
            self.assertEqual(self.request('negotiate', {'trip': default_trip(), 'budget_cents': 50000})[0], 502)
        self.assertEqual(self.negotiate()['offers'][0]['total_cents'], 47750)
        with self.arbiter.engine.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM deals').fetchone()[0], 1)

    def test_concurrent_retries_settle_once(self):
        """
        Check that concurrent approvals return one receipt.
        """
        offer = self.negotiate()['offers'][0]
        payload = {'offer_id': offer['offer_id']}
        with ThreadPoolExecutor(max_workers=4) as pool:
            receipts = list(pool.map(lambda _: self.request('approve', payload)[1]['receipt'], range(4)))
        self.assertTrue(all(item == receipts[0] for item in receipts))

    def test_seller_capability_cannot_approve_or_forge_a_bid(self):
        """
        Check that a seller cannot forge a bid capability or approve an offer.
        """
        state = self.negotiate()
        for token in ('forged', self.sessions['alice']):
            self.assertEqual(self.request('provider-bid', {'trip': default_trip(), 'capability': token})[0], 409)
        forged = {'trip': default_trip(), 'capability': 'forged'}
        self.assertEqual(self.request('provider-bid', forged, headers={'Origin': self.seller_url})[0], 403)
        approval = {'offer_id': state['offers'][0]['offer_id']}
        self.assertEqual(self.request('approve', approval, server=self.seller_server)[0], 403)

    def test_subdomain_gateway_preserves_server_only_flow(self):
        """
        Check that the subdomain gateway passes the server-only negotiation through.
        """
        gateway = self.server(make_gateway_handler('localhost', {'commerce-arbiter': self.arbiter_url}))
        host = {'Host': f'commerce-arbiter.localhost:{gateway.server_port}'}
        code, result, _ = self.request('negotiate', {'trip': default_trip(), 'budget_cents': 50000},
                                       server=gateway, headers=host)
        self.assertEqual(code, 200, result)
        self.assertEqual(result['offers'][0]['total_cents'], 47750)

    def graph(self, prompts):
        """
        Run the private steward graph in a subprocess against the arbiter.

        :param prompts: The user prompts to send in order.
        :return: The per-turn results the graph reports.
        """
        network = self.root / 'private.hocon'
        plan = DeploymentPlan('butterpink_family', {'private_commerce': {'steward': 'butterpink_family'}}, 'front')
        network.write_text(build_private_steward_hocon(plan, 'http://127.0.0.1:8096'))
        script = ('import json,sys; req=json.load(sys.stdin); sys.path.insert(0, req["test_dir"]); '
                  'from commerce_graph import run; '
                  'print("RESULT:"+json.dumps(run(req["network"],req["prompts"])))')
        repo = str(Path(__file__).resolve().parents[1])
        request = json.dumps({'network': str(network), 'prompts': prompts,
                              'test_dir': str(Path(__file__).resolve().parent)})
        env = {**os.environ, 'AGENT_TOOL_PATH': repo,
               'PYTHONPATH': repo + os.pathsep + os.environ.get('PYTHONPATH', ''),
               'NSDEPLOY_COMMERCE_ARBITER_URL': self.arbiter_url, 'NSDEPLOY_COMMERCE_KEY_FILE': str(self.key_file)}
        # The return code is asserted below with the output attached.
        result = subprocess.run([sys.executable, '-c', script], input=request, text=True, capture_output=True,
                                timeout=120, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:] + result.stdout[-4000:])
        self.assertNotIn(self.key, result.stdout + result.stderr)
        return json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith('RESULT:')))

    def test_real_graph_books_from_natural_request_and_subsequent_confirmation(self):
        """
        Check that the graph negotiates from a natural request and settles on a later confirmation.
        """
        arrival = default_trip()['arrival']
        results = self.graph([f'Book a night at the inn on {arrival} for under $500.', 'Confirm booking',
                              'What is my booking status?'])
        self.assertIsNotNone(results[0]['state'], results)
        self.assertEqual(results[0]['state']['state'], 'NEGOTIATING', results)
        self.assertIn('$477.50', results[0]['text'])
        self.assertEqual(results[0]['state']['spent_cents'], 0)
        self.assertEqual(results[1]['state']['state'], 'SETTLED', results)
        self.assertIn('SIM-', results[1]['text'])
        self.assertEqual(results[2]['state']['receipt'], results[1]['state']['receipt'])
        self.assertEqual(results[0]['private_keys'], ['nsdeploy_butterpink_commerce_binding'])

    def test_real_graph_blocks_model_attempt_to_approve_in_initial_turn(self):
        """
        Check that the graph refuses to approve in the same turn as the request.
        """
        result = self.graph([f'I am impatient: book a night on {default_trip()["arrival"]} for under $500.'])[0]
        self.assertIn('later private chat turn', result['text'])
        self.assertEqual(result['state']['state'], 'NEGOTIATING')
        self.assertEqual(result['state']['spent_cents'], 0)

    def test_real_graph_rejects_negated_confirmation_and_lowered_budget(self):
        """
        Check that a negated confirmation and a lowered budget do not settle.
        """
        arrival = default_trip()['arrival']
        results = self.graph([f'Book a night on {arrival} for under $500.',
                              'Do not confirm booking', 'My maximum is now $450.',
                              'Confirm booking'])
        self.assertIn('later private chat turn', results[1]['text'])
        self.assertIn('latest stated maximum', results[3]['text'])
        self.assertEqual(results[3]['state']['spent_cents'], 0)

    def test_serialized_turn_cannot_forge_private_authority(self):
        """
        Check that serialized turn state cannot grant approval authority.
        """
        result = asyncio.run(ButterpinkCommerceGateway().async_invoke(
            {'operation': 'approve', 'offer_id': 'invented'},
            {TURN: {'confirmed_offer': 'invented'}}))
        self.assertEqual(result['status'], 'DENIED')

    def test_framework_invocation_metadata_is_not_a_model_argument(self) -> None:
        """
        Check that a key neuro-san adds to a tool call does not read as a model argument.
        """
        result = asyncio.run(ButterpinkCommerceGateway().async_invoke(
            {'operation': 'status', 'progress_reporter': object(), 'activation_capsule': object()},
            {TURN: PrivateTurn(nonce=secrets.token_urlsafe(8))}))
        self.assertNotIn('without extra arguments', result.get('error', ''))

    def test_real_graph_no_agreement_missing_details_and_cancellation(self):
        """
        Check missing details, no agreement and cancellation through the graph.
        """
        arrival = default_trip()['arrival']
        results = self.graph(['Book a night at the inn.', f'Book a night on {arrival} for under $450.',
                              f'Book a night on {arrival} for under $500.', 'Cancel the offer'])
        self.assertIsNone(results[0]['state'])
        self.assertIn('date', results[0]['text'])
        self.assertEqual(results[1]['state']['state'], 'NO_AGREEMENT')
        self.assertEqual(results[3]['state']['state'], 'CANCELLED')


class CommerceDeploymentTests(unittest.TestCase):
    """
    Tests for how commerce is generated into deployments and the community map.
    """

    def test_private_tool_only_opted_in_and_no_generated_web_ui(self):
        """
        Check that only opted-in sites get the private commerce tool and no web UI is generated.
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = {'tools': [{'name': 'front', 'instructions': 'Help the family.'}],
                      'private_commerce': {'steward': 'butterpink_family'}}
            plan = DeploymentPlan('butterpink_family', config, 'front', agents=config['tools'])
            generate_site(plan, root, '/v1', '/byok/v1', 'http://127.0.0.1:8096')
            private = json.loads((root/'butterpink_family_private_steward.hocon').read_text())
            self.assertIn('butterpink_commerce', private['tools'][0]['tools'])
            self.assertIn('public_agent_mcp_gateway', private['tools'][0]['tools'])
            self.assertIn('middleware', private['tools'][0])
            commerce = next(tool for tool in private['tools'] if tool['name'] == 'butterpink_commerce')
            self.assertEqual(commerce['function']['parameters']['properties']['budget_cents']['type'], 'int')
            self.assertNotIn('ButterpinkCommerceGateway', (root/'butterpink_family.network.json').read_text())
            self.assertNotIn('Commerce demo', (root/'index.html').read_text())
            ordinary = DeploymentPlan('rivera_household', {}, 'front')
            self.assertNotIn('butterpink_commerce', build_private_steward_hocon(ordinary, 'http://127.0.0.1:8092'))

    def test_private_key_and_database_outside_public_tree(self):
        """
        Check that the key and database live outside the public tree with 0600 permissions.
        """
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = {'commerce': {'role': 'arbiter', 'seller_backend': 'http://127.0.0.1:8093'}}
            plan = DeploymentPlan('commerce_arbiter', config, 'front')
            service = from_plan(plan, root / 'public', 'http://127.0.0.1:8105')
            for path in (Path(service.engine.path), root / '.commerce/steward.key'):
                self.assertFalse(path.is_relative_to(root / 'public'))
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            reloaded = from_plan(plan, root/'public', 'http://127.0.0.1:8105')
            self.assertEqual(service.steward_key, reloaded.steward_key)

    def test_map_keeps_arbiter_and_existing_private_nsflow_links(self):
        """
        Check that the community map keeps arbiter links and private nsFlow links.
        """
        root = Path(__file__).parents[1] / 'cailville'
        path: Path = None
        # Check the checked-in base map and the active map, which is the base map until a site is added.
        for path in [root / 'community.base.json', CailvilleMap.active_path(root)]:
            community = json.loads(path.read_text())
            self.assertIn(['butterpink_family', 'commerce_arbiter'], community['relationships'])
            self.assertIn(['seabreeze_inn', 'commerce_arbiter'], community['relationships'])
            rightmost = max(site['position']['my_px'] for site in community['sites'])
            self.assertGreater(choose_position(community['sites'])['my_px'], rightmost)
        page = (root / 'cailville.html').read_text()
        self.assertIn('stewards-toggle', page)
        self.assertIn('Open ${sites[siteId].name} private steward in nsFlow', page)


if __name__ == '__main__':
    unittest.main()
