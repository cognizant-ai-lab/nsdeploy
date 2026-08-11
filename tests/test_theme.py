import json
import unittest
from unittest.mock import patch

from nsdeploy.generate import _index_html, _theme_css
from nsdeploy.theme import DEFAULT_THEME_MODEL, PROMPT_VERSION, ThemeSpec, _SYSTEM_PROMPT, _chat


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps({"choices": [{"message": {"content": "theme"}}]}).encode()


class ThemeChatTests(unittest.TestCase):
    def test_default_theme_model_is_gpt_5_6(self):
        self.assertEqual(DEFAULT_THEME_MODEL, "gpt-5.6")

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_gpt_5_payload_omits_temperature(self, urlopen):
        self.assertEqual(_chat("https://api.openai.com/v1", "key", "gpt-5.6", "system", "user"), "theme")

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data)
        self.assertNotIn("temperature", payload)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 180)

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_other_models_keep_low_temperature(self, urlopen):
        _chat("http://127.0.0.1:11434/v1", "key", "qwen2.5:7b", "system", "user")

        request = urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data)["temperature"], 0.2)


class ThemeLayoutTests(unittest.TestCase):
    def test_prompt_requests_composed_runtime_slots(self):
        self.assertEqual(PROMPT_VERSION, "8")
        self.assertIn('data-ns-layout="composed"', _SYSTEM_PROMPT)
        self.assertIn('data-ns-slot="chat"', _SYSTEM_PROMPT)
        self.assertIn('data-ns-slot="agents"', _SYSTEM_PROMPT)
        self.assertIn("<details><summary>", _SYSTEM_PROMPT)
        self.assertIn("CRUSE forms must remain reachable", _SYSTEM_PROMPT)

    def test_composed_layout_and_native_drawer_survive_sanitizing(self):
        spec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed" onclick="bad()">
                  <header class="mast" data-ns-slot="header"></header>
                  <main class="desk" data-ns-slot="chat"><script>bad()</script></main>
                  <details class="drawer">
                    <summary>Agents working</summary>
                    <aside data-ns-slot="agents"></aside>
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
        self.assertIn("<details", spec.body)
        self.assertIn("<summary>Agents working</summary>", spec.body)
        self.assertNotIn("onclick", spec.body)
        self.assertNotIn("<script", spec.body)

    def test_generated_composed_page_uses_flexible_scroll_and_widget_guards(self):
        spec = ThemeSpec.coerce({
            "body": """
                <div id="app" data-ns-layout="composed">
                  <div data-ns-slot="header"></div>
                  <main data-ns-slot="chat"></main>
                  <aside data-ns-slot="agents"></aside>
                </div>
            """,
        })
        page = _index_html(spec, "Test network")
        css = _theme_css(spec)

        self.assertIn('<link rel="stylesheet" href="/theme.css"', page)
        self.assertIn('import("/site.js")', page)
        self.assertIn('body{min-height:100vh;overflow-y:auto!important', css)
        self.assertIn('#app[data-ns-layout="composed"]{min-width:0!important', css)
        self.assertIn('.ns-widget{box-sizing:border-box!important;max-width:100%!important}', css)
        self.assertIn('boot("#app")', page)

    def test_incomplete_composed_layout_falls_back_to_default(self):
        spec = ThemeSpec.coerce({
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

    def test_legacy_empty_mount_remains_supported(self):
        spec = ThemeSpec.coerce({"body": '<div class="frame"><div id="app"></div></div>'})
        page = _index_html(spec, "Legacy network")

        self.assertIn('<div id="app"></div>', page)
        self.assertIn('#app:not([data-ns-layout="composed"])', _theme_css(spec))

    def test_fixed_editable_layout_keeps_default_full_viewport_shell(self):
        spec = ThemeSpec.coerce({
            "body": '<div id="app" data-ns-layout="fixed">Loading...</div>',
            "style": ".site-note { color: green; }",
        })

        css = _theme_css(spec)
        self.assertIn(".site-note { color: green; }", css)
        self.assertIn("#app{height:100vh;overflow:hidden}", css)
        self.assertNotIn('#app:not([data-ns-layout="composed"])', css)

    def test_relative_site_assets_survive_css_sanitizing(self):
        spec = ThemeSpec.coerce({
            "body": '<div id="app"></div>',
            "style": '.hero{background:url("./assets/harbor.jpg")}',
        })

        self.assertIn('./assets/harbor.jpg', spec.style)


if __name__ == "__main__":
    unittest.main()
