import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from typing import Dict
from typing import Literal
import urllib.request
from unittest.mock import MagicMock
from unittest.mock import patch

from nsdeploy.generate import _index_html
from nsdeploy.generate import _theme_css
from nsdeploy.theme import DEFAULT_THEME_MODEL
from nsdeploy.theme import PROMPT_VERSION
from nsdeploy.theme import ThemeSpec
from nsdeploy.theme import _SYSTEM_PROMPT
from nsdeploy.theme import _chat
from nsdeploy.theme import propose_theme


class _Response:
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *args: Any) -> Literal[False]:
        return False

    def read(self) -> bytes:
        """
        Return a canned chat completion body.

        :return: The encoded JSON response body.
        """
        return json.dumps({"choices": [{"message": {"content": "theme"}}]}).encode()


class ThemeChatTests(unittest.TestCase):
    """Tests for the theme chat request payload and prompt caching."""

    def test_default_theme_model_is_gpt_5_6(self) -> None:
        """Check default theme model is gpt 5 6."""
        self.assertEqual(DEFAULT_THEME_MODEL, "gpt-5.6")

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_gpt_5_payload_omits_temperature(self, urlopen: MagicMock) -> None:
        """
        Check GPT-5 payload omits temperature.

        :param urlopen: The patched urlopen mock.
        """
        self.assertEqual(_chat("https://api.openai.com/v1", "key", "gpt-5.6", "system", "user"), "theme")

        request: urllib.request.Request = urlopen.call_args.args[0]
        payload: Dict[str, Any] = json.loads(request.data)
        self.assertNotIn("temperature", payload)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 180)

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_other_models_keep_low_temperature(self, urlopen: MagicMock) -> None:
        """
        Check other models keep low temperature.

        :param urlopen: The patched urlopen mock.
        """
        _chat("http://127.0.0.1:11434/v1", "key", "qwen2.5:7b", "system", "user")

        request: urllib.request.Request = urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data)["temperature"], 0.2)

    def test_custom_prompt_is_appended_and_part_of_cache_identity(self) -> None:
        """Check custom prompt is appended and part of cache identity."""
        plan: SimpleNamespace = SimpleNamespace(
            config={"metadata": {"description": "A test network"}},
            network_name="test_network",
            front_man="front",
            agents=[{"name": "front", "function": {"description": "Helps users"}}],
        )
        response: str = ('===META===\n{"brand":"Test"}\n===STYLE===\n.page { color: navy; }\n===BODY===\n'
                         '<div id="app" data-ns-layout="composed"><div data-ns-slot="header"></div>'
                         '<main data-ns-slot="chat"></main><aside data-ns-slot="agents"></aside>'
                         '<div data-ns-slot="settings"></div></div>\n')
        tmp: str
        chat: MagicMock
        with tempfile.TemporaryDirectory() as tmp, \
                patch("nsdeploy.theme.CACHE_DIR", Path(tmp)), \
                patch("nsdeploy.theme._chat", return_value=response) as chat:
            kwargs: Dict[str, Any] = {"model": "test-model", "api_key": "key", "upstream": "https://example.test/v1"}
            propose_theme(plan, theme_prompt="Use warm paper tones", **kwargs)
            propose_theme(plan, theme_prompt="Use cool ocean tones", **kwargs)

        self.assertEqual(chat.call_count, 2)
        self.assertIn("Additional theme instructions from the deployer:\nUse warm paper tones",
                      chat.call_args_list[0].args[4])
        self.assertIn("Additional theme instructions from the deployer:\nUse cool ocean tones",
                      chat.call_args_list[1].args[4])

    def test_fresh_generated_layout_must_place_settings(self) -> None:
        """Check fresh generated layout must place settings."""
        plan: SimpleNamespace = SimpleNamespace(
            config={"metadata": {"description": "A test network"}},
            network_name="test_network",
            front_man="front",
            agents=[{"name": "front", "function": {"description": "Helps users"}}],
        )
        response: str = ('===META===\n{"brand":"Test"}\n===STYLE===\n.page { color: navy; }\n===BODY===\n'
                         '<div id="app" data-ns-layout="composed"><div data-ns-slot="header"></div>'
                         '<main data-ns-slot="chat"></main><aside data-ns-slot="agents"></aside>'
                         '</div>\n')
        tmp: str
        with tempfile.TemporaryDirectory() as tmp, \
                patch("nsdeploy.theme.CACHE_DIR", Path(tmp)), \
                patch("nsdeploy.theme._chat", return_value=response):
            spec: ThemeSpec = propose_theme(
                plan, model="test-model", api_key="key", upstream="https://example.test/v1",
            )

        self.assertEqual(spec.brand, "Test")
        self.assertEqual(spec.body, "")
        self.assertEqual(spec.style, "")


class ThemeLayoutTests(unittest.TestCase):
    """Tests for theme layout prompts and generated page composition."""

    def test_prompt_requests_composed_runtime_slots(self) -> None:
        """Check prompt requests composed runtime slots."""
        self.assertEqual(PROMPT_VERSION, "13")
        self.assertIn('data-ns-layout="composed"', _SYSTEM_PROMPT)
        self.assertIn('data-ns-slot="chat"', _SYSTEM_PROMPT)
        self.assertIn('data-ns-slot="agents"', _SYSTEM_PROMPT)
        self.assertIn('data-ns-slot="settings"', _SYSTEM_PROMPT)
        self.assertNotIn('data-ns-slot="activity"', _SYSTEM_PROMPT)
        self.assertIn(".ns-turn-status-spinner", _SYSTEM_PROMPT)
        self.assertIn(".ns-turn-status-text", _SYSTEM_PROMPT)
        self.assertIn("data-status-type", _SYSTEM_PROMPT)
        self.assertIn("data-turn-active='true'", _SYSTEM_PROMPT)
        self.assertIn(".ns-send-steering", _SYSTEM_PROMPT)
        self.assertIn(".ns-steering-message", _SYSTEM_PROMPT)
        self.assertIn("<details><summary>", _SYSTEM_PROMPT)
        self.assertIn("CRUSE forms must remain reachable", _SYSTEM_PROMPT)
        self.assertIn("OPTIONAL starting point", _SYSTEM_PROMPT)
        self.assertIn("supplement/correct submitted information through chat", _SYSTEM_PROMPT)
        self.assertIn("reports, comparison tables, charts", _SYSTEM_PROMPT)
        self.assertIn("YOU choose where and how it appears", _SYSTEM_PROMPT)
        self.assertIn("automatically opens it when an API key is required", _SYSTEM_PROMPT)

    def test_composed_layout_and_native_drawer_survive_sanitizing(self) -> None:
        """Check composed layout and native drawer survive sanitizing."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed" onclick="bad()">
                  <header class="mast" data-ns-slot="header"></header>
                  <main class="desk" data-ns-slot="chat"><script>bad()</script></main>
                  <details class="drawer">
                    <summary>Agents working</summary>
                    <aside data-ns-slot="agents"></aside>
                  </details>
                  <section class="timeline" data-ns-slot="activity"></section>
                  <details class="model-settings">
                    <summary aria-label="Model settings">⚙</summary>
                    <div data-ns-slot="settings"></div>
                  </details>
                </div>
                <div id="app">duplicate</div>
            """,
            "style": ".desk { min-height: 40rem; }",
        })

        self.assertEqual(spec.body.count('id="app"'), 1)
        self.assertIn('data-ns-layout="composed"', spec.body)
        self.assertIn('data-ns-slot="header"', spec.body)
        self.assertIn('data-ns-slot="chat"', spec.body)
        self.assertIn('data-ns-slot="agents"', spec.body)
        self.assertIn('data-ns-slot="activity"', spec.body)
        self.assertIn('data-ns-slot="settings"', spec.body)
        self.assertIn("<details", spec.body)
        self.assertIn("<summary>Agents working</summary>", spec.body)
        self.assertNotIn("onclick", spec.body)
        self.assertNotIn("<script", spec.body)

    def test_generated_composed_page_uses_flexible_scroll_and_widget_guards(self) -> None:
        """Check generated composed page uses flexible scroll and widget guards."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed">
                  <div data-ns-slot="header"></div>
                  <main data-ns-slot="chat"></main>
                  <aside data-ns-slot="agents"></aside>
                </div>
            """,
        })
        page: str = _index_html(spec, "Test network")
        css: str = _theme_css(spec)

        self.assertIn('<link rel="stylesheet" href="/theme.css"', page)
        self.assertIn('import("/site.js")', page)
        self.assertIn('body{min-height:100vh;overflow-y:auto!important', css)
        self.assertIn('#app[data-ns-layout="composed"]{min-width:0!important', css)
        self.assertIn('.ns-widget{box-sizing:border-box!important;max-width:100%!important}', css)
        self.assertIn('boot("#app")', page)

    def test_incomplete_composed_layout_falls_back_to_default(self) -> None:
        """Check incomplete composed layout falls back to default."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed">
                  <div data-ns-slot="header"></div>
                  <main data-ns-slot="chat"></main>
                </div>
            """,
            "style": "body { color: red; }",
        })

        self.assertEqual(spec.body, "")
        self.assertEqual(spec.style, "")

    def test_duplicate_optional_activity_slot_falls_back_to_default(self) -> None:
        """Check duplicate optional activity slot falls back to default."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed">
                  <div data-ns-slot="header"></div>
                  <main data-ns-slot="chat"></main>
                  <aside data-ns-slot="agents"></aside>
                  <section data-ns-slot="activity"></section>
                  <section data-ns-slot="activity"></section>
                </div>
            """,
            "style": "body { color: red; }",
        })

        self.assertEqual(spec.body, "")
        self.assertEqual(spec.style, "")

    def test_duplicate_settings_slot_falls_back_to_default(self) -> None:
        """Check duplicate settings slot falls back to default."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed">
                  <div data-ns-slot="header"></div>
                  <main data-ns-slot="chat"></main>
                  <aside data-ns-slot="agents"></aside>
                  <div data-ns-slot="settings"></div>
                  <div data-ns-slot="settings"></div>
                </div>
            """,
            "style": "body { color: red; }",
        })

        self.assertEqual(spec.body, "")
        self.assertEqual(spec.style, "")

    def test_legacy_empty_mount_remains_supported(self) -> None:
        """Check legacy empty mount remains supported."""
        spec: ThemeSpec = ThemeSpec.coerce({"body": '<div class="frame"><div id="app"></div></div>'})
        page: str = _index_html(spec, "Legacy network")

        self.assertIn('<div id="app"></div>', page)
        self.assertIn('#app:not([data-ns-layout="composed"])', _theme_css(spec))

    def test_fixed_editable_layout_keeps_default_full_viewport_shell(self) -> None:
        """Check fixed editable layout keeps default full viewport shell."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": '<div id="app" data-ns-layout="fixed">Loading...</div>',
            "style": ".site-note { color: green; }",
        })

        css: str = _theme_css(spec)
        self.assertIn(".site-note { color: green; }", css)
        self.assertIn("#app{height:100vh;overflow:hidden}", css)
        self.assertNotIn('#app:not([data-ns-layout="composed"])', css)

    def test_relative_site_assets_survive_css_sanitizing(self) -> None:
        """Check relative site assets survive css sanitizing."""
        spec: ThemeSpec = ThemeSpec.coerce({
            "body": '<div id="app"></div>',
            "style": '.hero{background:url("./assets/harbor.jpg")}',
        })

        self.assertIn('./assets/harbor.jpg', spec.style)


if __name__ == "__main__":
    unittest.main()
