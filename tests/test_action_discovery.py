import contextlib
import io
import json
from pathlib import Path
import tempfile
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Tuple
import unittest
from unittest.mock import MagicMock
from unittest.mock import patch

from nsdeploy.action_discovery import Page
from nsdeploy.action_discovery import api_actions
from nsdeploy.action_discovery import discover
from nsdeploy.action_discovery import form_action
from nsdeploy.action_discovery import prepare_actions
from nsdeploy.generate import generate_site
from nsdeploy.resolve import DeploymentPlan

FORM: str = ('<form action="/post" method="post"><input name="size" type="radio" value="small">'
             '<input name="size" type="radio" value="large"><input name="topping" type="checkbox" value="cheese">'
             '<input name="topping" type="checkbox" value="onion">'
             '<input name="delivery" type="time" min="11:00" max="21:00" step="900">'
             '<textarea name="comments"></textarea><button>Submit</button></form>')
SPEC: Dict[str, Any] = json.loads(
    (Path(__file__).parent.parent / 'examples/actions/restful-api.openapi.json').read_text())


class DiscoveryTests(unittest.TestCase):
    """Tests for form and OpenAPI action discovery."""

    def test_native_form_contract_and_choices(self) -> None:
        """Check native form contract and choices."""
        a: Dict[str, Any] = form_action('https://forms.test/form', Page(FORM).forms[0], 0)
        p: Dict[str, Any] = a['inputSchema']['properties']
        self.assertEqual(p['size']['enum'], ['small', 'large'])
        self.assertEqual(p['topping']['items']['enum'], ['cheese', 'onion'])
        self.assertIn('900 seconds', p['delivery']['description'])
        self.assertEqual(len(a['request']['fingerprint']), 64)
        self.assertFalse(a['enabled'])

    def test_unsafe_or_unsupported_forms_are_not_inferred(self) -> None:
        """Check unsafe or unsupported forms are not inferred."""
        bodies: List[str] = ['<input type="hidden" name="csrf" value="secret">', '<input type="password" name="pw">',
                             '<input type="file" name="upload">', '<input name="x" onchange="send()">',
                             '<button name="delete" value="1">Go</button>']
        body: str
        for body in bodies:
            with self.subTest(body=body), self.assertRaises(ValueError):
                form_action('https://forms.test/form', Page(f'<form action="/post">{body}</form>').forms[0], 0)

    def test_optional_native_formats_allow_empty_values(self) -> None:
        """Check optional native formats allow empty values."""
        html: str = ('<form action="/post"><input name="optional" type="email">'
                     '<input name="required" type="email" required></form>')
        form: Dict[str, Any] = Page(html).forms[0]
        props: Dict[str, Any] = form_action('https://forms.test/form', form, 0)['inputSchema']['properties']
        self.assertNotIn('format', props['optional'])
        self.assertEqual(props['required']['format'], 'email')

    def test_openapi_public_schema_and_safety_exclusions(self) -> None:
        """Check openapi public schema and safety exclusions."""
        spec: Dict[str, Any] = json.loads(json.dumps(SPEC))
        spec['paths']['/admin'] = {'post': {'security': [{'key': []}]}}
        schema: Dict[str, str] = {'type': 'string', 'pattern': '^abc$'}
        spec['paths']['/unsupported'] = {'get': {'parameters': [{'name': 'x', 'in': 'query', 'schema': schema}]}}
        issues: List[Dict[str, Any]] = []
        actions: List[Dict[str, Any]] = api_actions(spec, 'spec.json', issues)
        self.assertEqual(len(actions), 3)
        self.assertEqual(len(issues), 2)
        self.assertEqual(actions[0]['request']['jsonFields'], ['data'])
        self.assertEqual(actions[1]['inputSchema']['required'], ['id'])
        self.assertEqual(actions[2]['effect'], 'irreversible')

    def test_crawl_is_bounded_and_never_submits(self) -> None:
        """Check crawl is bounded and never submits."""
        calls: List[Tuple[str, str]] = []

        def fetch(url: str, method: str = 'GET',
                  headers: Optional[Dict[str, str]] = None  # pylint: disable=unused-argument; fetcher signature
                  ) -> Tuple[str, Dict[str, str], int]:
            calls.append((url, method))
            if method == 'OPTIONS':
                return '', {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET'}, 200
            links: str = ('<a href="/docs/next">Docs</a><a href="/delete?id=1">Delete</a>'
                          '<a href="https://other.test/form">Other</a>')
            return FORM + links, {}, 200
        doc: Dict[str, Any] = discover('https://forms.test/form', site_url='https://agent.test', max_pages=1,
                                       fetcher=fetch)
        self.assertEqual(doc['visited'], ['https://forms.test/form'])
        self.assertEqual([method for _, method in calls], ['GET', 'OPTIONS', 'OPTIONS'])
        self.assertEqual(doc['actions'][0]['cors']['checks'][0]['status'], 'preflight-permitted')

    def test_missing_cors_stays_unverified(self) -> None:
        """Check missing cors stays unverified."""
        def fetch(url: str, method: str = 'GET',  # pylint: disable=unused-argument; fetcher signature
                  headers: Optional[Dict[str, str]] = None  # pylint: disable=unused-argument; fetcher signature
                  ) -> Tuple[str, Dict[str, str], int]:
            return (FORM if method == 'GET' else ''), {}, 200
        doc: Dict[str, Any] = discover('https://forms.test/form', site_url='https://agent.test', fetcher=fetch)
        self.assertEqual(doc['actions'][0]['cors']['checks'][0]['status'], 'unverified')

    def test_linked_spec_discovery_ignores_mail_and_foreign_links(self) -> None:
        """Check linked spec discovery ignores mail and foreign links."""
        calls: List[Tuple[str, str]] = []

        def fetch(url: str, method: str = 'GET',
                  headers: Optional[Dict[str, str]] = None  # pylint: disable=unused-argument; fetcher signature
                  ) -> Tuple[str, Dict[str, str], int]:
            calls.append((url, method))
            if method == 'OPTIONS':
                return '', {}, 403
            if url.endswith('/openapi.json'):
                return json.dumps(SPEC), {}, 200
            links: str = ('<a href="mailto:test@example.com">Email</a><a href="/openapi.json">API</a>'
                          '<a href="https://other.test/spec.json">Other</a>')
            return links, {}, 200
        doc: Dict[str, Any] = discover('https://docs.test/', fetcher=fetch)
        self.assertEqual(len(doc['actions']), 3)
        self.assertEqual([u for u, m in calls if m == 'GET'], ['https://docs.test/', 'https://docs.test/openapi.json'])

    def test_lock_review_reuse_refresh_and_source_mismatch(self) -> None:
        """Check lock review reuse refresh and source mismatch."""
        doc: Dict[str, Any] = {'version': 1, 'source': 'https://forms.test/form', 'spec': None, 'siteOrigin': None,
                               'actions': [form_action('https://forms.test/form', Page(FORM).forms[0], 0)],
                               'issues': []}
        directory: str
        scan: MagicMock
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()), \
                patch('nsdeploy.action_discovery.discover', return_value=doc) as scan:
            path: Path = Path(directory) / 'discovered-actions.json'
            with self.assertRaisesRegex(ValueError, 'No discovered actions enabled'):
                prepare_actions(path, doc['source'])
            self.assertTrue(path.exists())
            selected: Dict[str, Any] = prepare_actions(path, allow=[doc['actions'][0]['name']])
            self.assertTrue(selected['actions'][0]['enabled'])
            prepare_actions(path)
            self.assertEqual(scan.call_count, 1)
            with self.assertRaisesRegex(ValueError, 'source changed'):
                prepare_actions(path, 'https://other.test')
            with self.assertRaisesRegex(ValueError, 'Unknown'):
                prepare_actions(path, allow=['invented'])

    def test_static_catalog_is_loaded_without_adapter_and_not_exposed_by_cors(self) -> None:
        """Check static catalog is loaded without adapter and not exposed by cors."""
        directory: str
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            out: Path = Path(directory)
            config: Dict[str, Any] = {'tools': [{'name': 'front', 'instructions': 'Help.'}]}
            plan: DeploymentPlan = DeploymentPlan(network_name='test', config=config, front_man='front')
            manifest: Dict[str, Any] = generate_site(plan, out, 'browser://mock', '', 'https://agent.test/test',
                                                     static_bundle=True,
                                                     discovered_actions={'version': 1, 'actions': []},
                                                     action_caller_origins=['https://caller.test'])
            self.assertEqual(manifest['actions']['catalog'], './discovered-actions.json')
            self.assertTrue((out / 'runtime/discovered-actions.js').exists())
            self.assertFalse((out / 'actions.js').exists())
            self.assertNotIn('discovered-actions', (out / '_headers').read_text())
