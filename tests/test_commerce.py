"""Authoritative state transitions and real two-site HTTP commerce boundaries."""
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from nsdeploy.commerce.arbiter import Arbiter, CommerceError
from nsdeploy.commerce.catalog import default_trip, public_catalog
from nsdeploy.commerce.service import API, CommerceSite, from_plan
from nsdeploy.gateway import make_gateway_handler
from nsdeploy.generate import generate_site
from nsdeploy.launcher import DEFAULT_RUNTIME_DIR, make_handler
from nsdeploy.resolve import DeploymentPlan


class ArbiterStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1900000000
        self.engine = Arbiter(Path(self.temp.name) / 'arbiter.sqlite', clock=lambda: self.now)
        self.deal = self.engine.create(default_trip(), 100000)

    def market(self, deal=None):
        deal = deal or self.deal
        seller = self.engine.provider_capability(deal['buyer_token'], 'seabreeze_inn', 1)
        bid = self.engine.submit_bid(seller, 'seabreeze_inn')
        return self.engine.resolve(deal['buyer_token'])['offers'], seller, bid

    def test_vendored_engine_is_exact_upstream_snapshot(self):
        source = Path(__file__).parents[1] / 'nsdeploy/commerce/arbiter.py'
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),
                         'bfd34f54b3adc883c9f325eee3a4cbb42054a37361d445f3d303aaeef3bb97e3')

    def test_fixed_catalog_nash_offer_and_sealed_views(self):
        self.assertEqual(public_catalog('seabreeze_inn', default_trip())['total_cents'], 105000)
        offers, seller, bid = self.market()
        self.assertEqual(offers[0]['total_cents'], 95500)
        self.assertEqual(sum(line['cents'] for line in offers[0]['line_items']), 95500)
        self.assertEqual(bid['status'], 'BID_COMMITTED')
        public = json.dumps([self.engine.public_request(seller, 'seabreeze_inn'), offers, bid])
        for secret in ('floor', 'budget', 'owner_token', 'buyer_token', '91000', '100000'):
            self.assertNotIn(secret, public)

    def test_no_agreement_and_ceiling_above_catalog(self):
        low = self.engine.create(default_trip(), 90000)
        self.assertEqual(self.market(low)[0], [])
        self.assertEqual(self.engine.snapshot(low['owner_token'])['state'], 'NO_AGREEMENT')
        high = self.engine.create(default_trip(), 200000)
        self.assertEqual(self.market(high)[0][0]['total_cents'], 98000)

    def test_capabilities_cannot_cross_roles_or_deals(self):
        offers, seller, _ = self.market()
        foreign = self.engine.create(default_trip(), 100000)
        for token in (seller, self.deal['buyer_token'], foreign['owner_token'], 'forged'):
            with self.assertRaises(CommerceError):
                self.engine.authorize(token, offers[0]['offer_id'])
        direct = self.engine.provider_capability(self.deal['buyer_token'], 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.submit_bid(direct, 'seabreeze_inn')
        with self.assertRaises(CommerceError):
            self.engine.offers(seller)

    def test_parallel_approval_and_settlement_are_idempotent_and_persist(self):
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
        for action in ('fail', 'cancel', 'expire'):
            deal = self.engine.create(default_trip(), 100000)
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
        offers, _, _ = self.market()
        self.now += 901
        with self.assertRaises(CommerceError):
            self.engine.authorize(self.deal['owner_token'], offers[0]['offer_id'])
        for change in ({'notes': 'my budget is 1000'}, {'travelers': True}, {'destination': 'Elsewhere'},
                       {'amenities': ['wifi', 'secret budget']}, {'departure': default_trip()['arrival']}):
            with self.assertRaises(ValueError):
                self.engine.create({**default_trip(), **change}, 100000)
        for budget in (True, 0, -1, 1.5, '100000'):
            with self.assertRaises(ValueError):
                self.engine.create(default_trip(), budget)


class CommerceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 1900000000
        self.arbiter_server = self.server()
        self.seller_server = self.server()
        self.arbiter_url = f'http://127.0.0.1:{self.arbiter_server.server_port}'
        self.seller_url = f'http://127.0.0.1:{self.seller_server.server_port}'
        self.config = {'role': 'arbiter', 'seller_backend': self.seller_url}
        self.arbiter = CommerceSite(self.config, self.arbiter_url,
                                   {'seabreeze_inn': self.seller_url}, self.root / 'private.sqlite', clock=lambda: self.now)
        self.seller = CommerceSite({'role': 'seller', 'arbiter_backend': self.arbiter_url}, self.seller_url,
                                  {'commerce_arbiter': self.arbiter_url})
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        self.seller_server.RequestHandlerClass = self.handler(self.seller)
        self.cookies = {}
        self.csrf = {}

    def server(self, handler=None):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler or make_handler(self.root, '', DEFAULT_RUNTIME_DIR, []))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def handler(self, service):
        site = self.root / 'site'
        site.mkdir(exist_ok=True)
        (site / 'index.html').write_text('existing agent site')
        return make_handler(site, '', DEFAULT_RUNTIME_DIR, [], commerce=service)

    def request(self, operation, body=None, user='alice', headers=None, server=None, path=None):
        server = server or self.arbiter_server
        values = {'Connection': 'close'}
        if user in self.cookies:
            values['Cookie'] = self.cookies[user]
        if body is not None:
            values.update({'Origin': self.arbiter.site_base, 'Content-Type': 'application/json',
                           'X-Commerce-CSRF': self.csrf.get(user, '')})
        values.update(headers or {})
        # None removes a header, useful for simulating non-browser provider callbacks.
        values = {key: value for key, value in values.items() if value is not None}
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=20)
        connection.request('POST' if body is not None else 'GET', path or API + operation,
                           json.dumps(body) if body is not None else None, values)
        response = connection.getresponse()
        raw = response.read()
        extra = dict(response.getheaders())
        if 'Set-Cookie' in extra:
            self.cookies[user] = extra['Set-Cookie'].split(';')[0]
        data = json.loads(raw) if extra.get('Content-Type') == 'application/json' else raw.decode()
        if isinstance(data, dict) and 'csrf' in data:
            self.csrf[user] = data['csrf']
        code = response.status
        connection.close()
        return code, data, extra

    def create(self, budget=100000, user='alice'):
        self.assertEqual(self.request('session', user=user)[0], 200)
        code, body, _ = self.request('create', {'trip': default_trip(), 'budget_cents': budget}, user=user)
        self.assertEqual(code, 200, body)
        return body

    def negotiate(self, **kwargs):
        state = self.create(**kwargs)
        code, body, _ = self.request('negotiate', {'deal_id': state['deal_id']}, user=kwargs.get('user', 'alice'))
        self.assertEqual(code, 200, body)
        return body

    def test_real_two_site_flow_with_immutable_offer_audit_and_receipt(self):
        with patch.object(self.seller, '_provider_action', wraps=self.seller._provider_action) as seller_call:
            state = self.negotiate()
            seller_body = seller_call.call_args.args[1]
            self.assertEqual(set(seller_body), {'trip', 'capability'})
            self.assertNotIn('100000', json.dumps(seller_body))
        deal = {'deal_id': state['deal_id']}
        self.assertEqual(state['offers'][0]['total_cents'], 95500)
        self.assertEqual(self.request('negotiate', deal)[1]['offers'], state['offers'])
        audit = next(event for event in state['events'] if event['kind'] == 'SELLER_ADAPTER_REQUEST')
        self.assertNotIn('budget', json.dumps(audit))
        self.assertNotIn('capability', json.dumps(state))
        self.assertNotIn('owner_token', json.dumps(state))
        offer = state['offers'][0]['offer_id']
        self.assertEqual(self.request('authorize', {**deal, 'offer_id': offer})[1]['state'], 'HELD')
        result = self.request('confirm', deal)[1]
        self.assertEqual(result['state'], 'SETTLED')
        self.assertEqual(result['spent_cents'], 95500)
        self.assertEqual(self.request('confirm', deal)[1]['receipt'], result['receipt'])

    def test_session_isolation_csrf_origin_and_forged_offer_fail(self):
        state = self.negotiate()
        payload = {'deal_id': state['deal_id'], 'offer_id': state['offers'][0]['offer_id']}
        self.request('session', user='bob')
        self.assertEqual(self.request('authorize', payload, user='bob')[0], 403)
        self.assertEqual(self.request('authorize', payload, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('authorize', payload, headers={'Origin': None})[0], 403)
        self.assertEqual(self.request('authorize', payload, headers={'X-Commerce-CSRF': 'forged'})[0], 403)
        self.assertEqual(self.request('authorize', {**payload, 'offer_id': 'invented-by-model'})[0], 409)
        self.assertEqual(self.request('authorize', {**payload, 'amount': 1})[0], 400)
        self.assertEqual(self.request('session')[1]['spent_cents'], 0)

    def test_provider_endpoint_rejects_browser_and_forged_or_cross_role_capabilities(self):
        state = self.create()
        with self.arbiter.engine.db() as db:
            row = db.execute('SELECT * FROM human_sessions WHERE deal=?', (state['deal_id'],)).fetchone()
        for capability in ('forged', row['owner'], row['buyer']):
            code, _, _ = self.request('provider-bid', {'trip': default_trip(), 'capability': capability},
                                      headers={'Origin': None})
            self.assertEqual(code, 409)
        self.assertEqual(self.request('provider-bid', {'trip': default_trip(), 'capability': 'forged'})[0], 403)
        self.assertEqual(self.request('confirm', {'deal_id': state['deal_id']}, server=self.seller_server,
                                      headers={'Origin': self.seller_url})[0], 403)

    def test_no_agreement_failure_expiry_and_cancel(self):
        low = self.negotiate(budget=90000)
        self.assertEqual(low['state'], 'NO_AGREEMENT')
        self.assertEqual(low['offers'], [])
        for action, expected in [('fail-inventory', 'CANCELLED'), ('cancel', 'CANCELLED'), ('expire', 'EXPIRED')]:
            state = self.negotiate()
            deal = {'deal_id': state['deal_id']}
            self.request('authorize', {**deal, 'offer_id': state['offers'][0]['offer_id']})
            if action == 'expire':
                self.now += 121
                result = self.request('session')[1]
            else:
                result = self.request(action, deal)[1]
            self.assertEqual(result['state'], expected)
            self.assertEqual((result['hold_cents'], result['spent_cents']), (0, 0))
            self.assertEqual(self.request('negotiate', deal)[0], 409)

    def test_unavailable_seller_can_retry_without_charge_or_new_mandate(self):
        state = self.create()
        from urllib.error import URLError
        with patch('nsdeploy.commerce.service.post_json', side_effect=URLError('offline')):
            code, body, _ = self.request('negotiate', {'deal_id': state['deal_id']})
        self.assertEqual(code, 502)
        self.assertIn('retry', body['error'])
        recovered = self.request('negotiate', {'deal_id': state['deal_id']})[1]
        self.assertEqual(recovered['spent_cents'], 0)
        self.assertEqual(len(recovered['offers']), 1)

    def test_create_retry_and_mandate_changes_do_not_replace_an_active_deal(self):
        state = self.create()
        code, repeated, _ = self.request('create', {'trip': default_trip(), 'budget_cents': 100000})
        self.assertEqual(code, 200)
        self.assertEqual(repeated['deal_id'], state['deal_id'])
        for amount, expected in [(99999, 409), (100000.0, 400), (True, 400)]:
            self.assertEqual(self.request('create', {'trip': default_trip(), 'budget_cents': amount})[0], expected)
        self.assertEqual(self.request('session')[1]['deal_id'], state['deal_id'])

    def test_expired_session_requires_reopening_checkout_without_leaking_old_deal(self):
        state = self.create()
        self.now += 86401
        self.assertEqual(self.request('negotiate', {'deal_id': state['deal_id']})[0], 403)
        code, new, headers = self.request('session')
        self.assertEqual((code, new['state']), (200, 'NEW'))
        self.assertNotIn('deal_id', new)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])

    def test_restart_recovers_human_session_and_private_data_is_not_static(self):
        state = self.negotiate()
        self.arbiter = CommerceSite(self.config, self.arbiter_url, {}, self.root / 'private.sqlite', clock=lambda: self.now)
        self.arbiter_server.RequestHandlerClass = self.handler(self.arbiter)
        code, restored, headers = self.request('session')
        self.assertEqual(code, 200)
        self.assertEqual(restored['deal_id'], state['deal_id'])
        self.assertEqual(restored['offers'], state['offers'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        for path in ('/private.sqlite', '/.commerce/commerce_arbiter.sqlite', '/commerce/arbiter.py'):
            self.assertEqual(self.request('', path=path)[0], 404)
        self.assertEqual(self.request('', path='/')[1], 'existing agent site')
        self.assertEqual(self.request('', path='/commerce', server=self.seller_server)[2]['Location'], self.arbiter_url + '/commerce')

    def test_gateway_preserves_public_origin_cookie_and_transaction_flow(self):
        gateway = self.server(make_gateway_handler('localhost', {
            'commerce-arbiter': self.arbiter_url, 'seabreeze-inn': self.seller_url}))
        host = f'commerce-arbiter.localhost:{gateway.server_port}'
        self.arbiter.site_base = 'http://' + host
        self.seller.arbiter_url = self.arbiter.site_base
        headers = {'Host': host}
        self.assertEqual(self.request('session', server=gateway, headers=headers)[0], 200)
        code, state, _ = self.request('create', {'trip': default_trip(), 'budget_cents': 100000}, server=gateway, headers=headers)
        self.assertEqual(code, 200)
        code, state, _ = self.request('negotiate', {'deal_id': state['deal_id']}, server=gateway, headers=headers)
        self.assertEqual(code, 200, state)
        self.assertEqual(state['offers'][0]['total_cents'], 95500)


class CommerceDeploymentTests(unittest.TestCase):
    def test_opt_in_generation_and_database_outside_public_tree(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = {'tools': [{'name': 'concierge', 'instructions': 'Explain the demo.'}]}
            plain = DeploymentPlan('plain', config, 'concierge', agents=config['tools'])
            generate_site(plain, root / 'plain', '/v1', '/byok/v1', 'http://127.0.0.1:8090')
            self.assertNotIn('/commerce', (root / 'plain/index.html').read_text())
            self.assertIsNone(from_plan(plain, root / 'plain', 'http://127.0.0.1:8090'))
            config['commerce'] = {'role': 'arbiter', 'seller_backend': 'http://127.0.0.1:8093'}
            config['links'] = {'seabreeze_inn': 'https://seabreeze-inn.example.test/seabreeze_inn'}
            opted = DeploymentPlan('commerce_arbiter', config, 'concierge', agents=config['tools'])
            generate_site(opted, root / 'public', '/v1', '/byok/v1', 'http://127.0.0.1:8105')
            self.assertIn('href="/commerce"', (root / 'public/index.html').read_text())
            service = from_plan(opted, root / 'public', 'http://127.0.0.1:8105')
            self.assertEqual(service.seller_url, 'https://seabreeze-inn.example.test')
            self.assertFalse(Path(service.engine.path).is_relative_to(root / 'public'))
            self.assertEqual(Path(service.engine.path).stat().st_mode & 0o777, 0o600)

    def test_map_addition_preserves_arbiter_on_reset_and_avoids_mobile_overlap(self):
        from nsdeploy.cailville import choose_position
        root = Path(__file__).parents[1] / 'cailville'
        for filename in ('community.json', 'community.base.json'):
            community = json.loads((root / filename).read_text())
            arbiter = next(site for site in community['sites'] if site['id'] == 'commerce_arbiter')
            self.assertEqual(arbiter['port'], 8105)
            self.assertIn(['seabreeze_inn', 'commerce_arbiter'], community['relationships'])
            following = choose_position(community['sites'])
            self.assertGreater(following['my_px'], max(site['position']['my_px'] for site in community['sites']))


if __name__ == '__main__':
    unittest.main()
